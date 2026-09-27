// Demand exits (C-16, US-26; LLD §4.2.4): Lost, Dormant, Invalid in one transaction.
import { addDays } from '../domain/dates.js';
import type { IsoDate } from '../domain/dates.js';
import type { ExitType } from '../domain/commercial.js';
import { JourneyError, invalidTransition, notFoundErr } from './errors.js';
import type { DemandJourneyRow } from './model.js';
import { audit, notify } from './notify.js';
import type { Tx } from './ports.js';
import { closeItems } from './queue-ops.js';

export interface ExitInput {
  type: ExitType;
  reasonCode?: string | null;
  reason?: string | null;
  competingTerms?: string | null;
  competingPriceInr?: number | null;
  revisitDate?: IsoDate | null;
  revisitDays: number;
  flagPerson?: boolean;
  personId?: string | null;
  actor: string;
  via: 'ui' | 'system';
}

const SRQ_EVENT_STATUS = { Open: 'open', 'In progress': 'in_progress', Fulfilled: 'fulfilled', Cancelled: 'cancelled' } as const;

/** Cancels the open sourcing requests of a demand (exit, void) with sourcing_request.updated.v1. */
export async function cancelOpenSourcingRequests(tx: Tx, demandId: string): Promise<void> {
  for (const srq of await tx.q.openSourcingRequestsOfDemand(demandId)) {
    await tx.rows.update('sourcing_requests', srq.id, { status: 'Cancelled', closed_at: tx.now });
    await tx.events.emit(
      'sourcing_request.updated.v1',
      { type: 'sourcing_request', id: srq.id },
      { sourcingRequestId: srq.id, status: SRQ_EVENT_STATUS.Cancelled },
    );
    await closeItems(tx, { subjectId: srq.id }, 'cancelled', 'srq_cancelled');
  }
}
export { SRQ_EVENT_STATUS };

export async function exitDemand(tx: Tx, demandId: string, input: ExitInput): Promise<DemandJourneyRow> {
  const dj = await tx.rows.get('demand_journey', demandId, { forUpdate: true });
  if (!dj) throw notFoundErr('demand');
  if (dj.commercial_status === 'Closed') throw invalidTransition('a Closed demand cannot exit');
  if (dj.exit_type) throw invalidTransition(`the demand already exited (${dj.exit_type})`);
  if (await tx.q.openDealOfDemand(demandId))
    throw new JourneyError(409, 'exit-blocked-by-open-deal', 'cancel the open deal first');
  if ((input.type === 'Lost' || input.type === 'Invalid') && !input.reasonCode)
    throw new JourneyError(400, 'validation-failed', `reasonCode is required for ${input.type}`);

  const revisit = input.type === 'Dormant' ? (input.revisitDate ?? addDays(tx.today, input.revisitDays)) : null;
  const updated =
    (await tx.rows.update('demand_journey', demandId, {
      exit_type: input.type,
      exit_reason_code: input.reasonCode ?? (input.type === 'Dormant' ? 'postponed' : null),
      exit_reason: input.reason ?? null,
      competing_terms: input.type === 'Lost' ? (input.competingTerms ?? null) : null,
      competing_price_inr: input.type === 'Lost' ? (input.competingPriceInr ?? null) : null,
      exit_flag_person: !!input.flagPerson,
      exit_person_id: input.personId ?? null,
      revisit_date: revisit,
      exited_at: tx.now,
      exited_by: input.actor,
    })) ?? dj;

  await cancelOpenSourcingRequests(tx, demandId);
  await closeItems(tx, { demandId }, 'cancelled', 'exited');

  const view = await tx.rows.get('demand_view', demandId);
  const code = view?.code ?? null;
  for (const owner of await tx.q.ownersOfConfirmedMatchOffers(demandId)) {
    await notify(tx, owner, {
      kind: 'demand_exited',
      title: `${code ?? 'Demand'} exited: ${input.type}`,
      subject: { type: 'demand', id: demandId, code },
    });
  }

  await tx.events.emit(
    'demand.exited.v1',
    { type: 'demand', id: demandId },
    {
      demandId,
      exit: input.type,
      ...(revisit ? { revisitDate: revisit } : {}),
      // the reason code, never the free-text reason (PII possible)
      ...(updated.exit_reason_code ? { reason: updated.exit_reason_code } : {}),
      ...(updated.competing_terms ? { competingTerms: updated.competing_terms } : {}),
      ...(updated.competing_price_inr !== null ? { competingPriceInr: updated.competing_price_inr } : {}),
      ...(input.flagPerson ? { flagPerson: true } : {}),
      ...(input.personId ? { personId: input.personId } : {}),
    },
  );

  const curve = await tx.q.curveBySubject('demand', demandId);
  if (curve) {
    if (input.type === 'Dormant') {
      await tx.rows.update('life_curve', curve.id, {
        stage: 'Paused',
        paused_until: revisit,
        next_change_on: null,
        day_count: 0,
        stage_changed_at: tx.now,
      });
      if (curve.stage !== 'Paused') {
        await tx.events.emit(
          'lifecycle.stage_changed.v1',
          { type: 'demand', id: demandId },
          { subjectType: 'demand', subjectId: demandId, from: curve.stage, to: 'Paused', day: curve.day_count },
        );
      }
    } else if (!curve.frozen) {
      await tx.rows.update('life_curve', curve.id, { frozen: true, next_change_on: null });
    }
  }
  await audit(
    tx,
    'demand.exited',
    input.actor,
    { type: 'demand', id: demandId },
    { exit: input.type, ...(updated.exit_reason_code ? { reasonCode: updated.exit_reason_code } : {}), ...(code ? { code } : {}) },
    input.via,
  );
  return updated;
}
