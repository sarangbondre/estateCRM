// Demand journey (C-09, C-16, US-20, US-26; LLD §4.2.3–4.2.5, §4.5): qualify, exits, reactivation.
import { confirmSubject } from './curve.js';
import { rederiveDemand } from './derive.js';
import { JourneyError, forbiddenErr, invalidTransition, notFoundErr, outsideLaunchArea } from './errors.js';
import { exitDemand } from './exits.js';
import type { ExitInput } from './exits.js';
import { demandCells } from './facts.js';
import type { DemandJourneyRow } from './model.js';
import { audit } from './notify.js';
import type { Tx } from './ports.js';
import { closeItems, openItem, resolveAssignee } from './queue-ops.js';
import { thresholds } from './settings.js';
import { demandByIdOrCode } from './views.js';

export interface Checklist {
  decisionMakerReached: boolean;
  budgetConfirmed: boolean;
  timingConfirmed: boolean;
  agreesToWork: boolean;
  decisionMakerNote?: string | null;
}

async function journeyFor(tx: Tx, demandId: string): Promise<DemandJourneyRow> {
  const dj = await tx.rows.get('demand_journey', demandId, { forUpdate: true });
  if (!dj) throw notFoundErr('demand');
  return dj;
}

/** Contacted → Active: all four checklist items, a confirmation, demand.qualified.v1 (crm-engine runs matching). */
export async function qualifyDemand(tx: Tx, actor: string, idOrCode: string, checklist: Checklist) {
  const view = await demandByIdOrCode(tx, idOrCode);
  const dj = await journeyFor(tx, view.id);
  if (dj.exit_type) throw invalidTransition(`the demand exited (${dj.exit_type}); reactivate it first`);
  if (dj.commercial_status === 'Closed') throw invalidTransition('the demand is Closed');
  if (view.voided) throw invalidTransition('the demand was voided');
  if (view.outside_launch_area) throw outsideLaunchArea();
  if (dj.qualified_at) throw invalidTransition('the demand is already qualified');
  const complete = checklist.decisionMakerReached && checklist.budgetConfirmed && checklist.timingConfirmed && checklist.agreesToWork;
  if (!complete) throw new JourneyError(400, 'qualification-incomplete', 'all four checklist items must be true');
  await tx.rows.update('demand_journey', dj.id, {
    qualified_at: tx.now,
    qualification: { ...checklist, decisionMakerNote: checklist.decisionMakerNote ?? null },
    first_contacted_at: dj.first_contacted_at ?? tx.now,
    unreachable: false,
  });
  // The qualifying call is a confirmation.
  await confirmSubject(tx, 'demand', view.id, 'call', 'qualification');
  await closeItems(tx, { subjectId: view.id, sections: ['to_contact', 'to_qualify'] }, 'done', 'qualified');
  await rederiveDemand(tx, view.id);
  await tx.events.emit('demand.qualified.v1', { type: 'demand', id: view.id }, { demandId: view.id });
  void actor;
  return view;
}

export interface ExitRequest {
  type: 'Lost' | 'Dormant' | 'Invalid';
  reasonCode?: string;
  reason?: string | null;
  competingTerms?: string | null;
  competingPriceInr?: number | null;
  revisitDate?: string | null;
  flagPerson?: boolean;
  personId?: string | null;
}

export async function exitDemandRequest(tx: Tx, actor: string, idOrCode: string, body: ExitRequest) {
  const view = await demandByIdOrCode(tx, idOrCode);
  if (body.type === 'Dormant' && body.revisitDate && body.revisitDate <= tx.today)
    throw new JourneyError(400, 'validation-failed', 'revisitDate must be in the future');
  if (body.flagPerson && !body.personId) throw new JourneyError(400, 'validation-failed', 'flagPerson needs personId');
  const th = (await thresholds(tx)).value;
  const input: ExitInput = {
    type: body.type,
    reasonCode: body.reasonCode ?? null,
    reason: body.reason ?? null,
    competingTerms: body.competingTerms ?? null,
    competingPriceInr: body.competingPriceInr ?? null,
    revisitDate: body.revisitDate ?? null,
    revisitDays: th.dormantRevisitDays,
    flagPerson: body.flagPerson ?? false,
    personId: body.personId ?? null,
    actor,
    via: 'ui',
  };
  await exitDemand(tx, view.id, input);
  return view;
}

/**
 * Exit → Active (or derived): clears the exit, unfreezes the curve with a confirmation (day 0, Fresh), re-derives,
 * demand.reactivated.v1 (+ status / lifecycle / confirmed events). Lost and Invalid need Admin/Manager (exit override).
 */
export async function reactivateDemandCore(tx: Tx, actor: { userId: string; role: string }, demandId: string, via: 'ui' | 'system' = 'ui') {
  const dj = await journeyFor(tx, demandId);
  if (!dj.exit_type) throw invalidTransition('the demand has not exited');
  if (dj.exit_type !== 'Dormant' && actor.role !== 'Admin' && actor.role !== 'Manager')
    throw forbiddenErr(`reactivating a ${dj.exit_type} demand needs Admin or Manager`);
  await tx.rows.update('demand_journey', demandId, {
    exit_type: null,
    exit_reason_code: null,
    exit_reason: null,
    competing_terms: null,
    competing_price_inr: null,
    exit_flag_person: false,
    exit_person_id: null,
    revisit_date: null,
    exited_at: null,
    exited_by: null,
    unreachable: false,
  });
  const curve = await tx.q.curveBySubject('demand', demandId);
  await confirmSubject(tx, 'demand', demandId, 'call', 'reactivation', tx.now, {
    frozen: false,
    paused_until: null,
    ...(curve?.stage === 'Paused' ? { stage: 'Fresh' as const } : {}),
  });
  await closeItems(tx, { subjectId: demandId, sections: ['dormant_revisits'] }, 'done', 'reactivated');
  const after = await rederiveDemand(tx, demandId);
  await tx.events.emit('demand.reactivated.v1', { type: 'demand', id: demandId }, { demandId });
  const view = await tx.rows.get('demand_view', demandId);
  if (view) {
    await tx.q.adjustGapCells(demandCells(view), 1, 0, tx.now);
    if (!view.outside_launch_area && after && !after.qualified_at) {
      await openItem(tx, {
        section: after.first_contacted_at ? 'to_qualify' : 'to_contact',
        subjectType: 'demand',
        subjectId: demandId,
        subjectCode: view.code,
        demandId,
        assignee: await resolveAssignee(tx, 'demand', view.owner_user_id),
        reason: after.first_contacted_at ? 'qualify' : 'first_contact',
        dueAt: tx.now,
      });
    }
  }
  await audit(tx, 'demand.reactivated', actor.userId, { type: 'demand', id: demandId }, { from: dj.exit_type }, via);
}

export async function reactivateDemandRequest(tx: Tx, actor: { userId: string; role: string }, idOrCode: string) {
  const view = await demandByIdOrCode(tx, idOrCode);
  await reactivateDemandCore(tx, actor, view.id);
  return view;
}
