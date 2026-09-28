// Life curve service (LLD §4.1): creation, event-driven confirmation (§4.1.3), recomputation, stage actions (§4.1.4).
import { addDays, istDate, minDate } from '../domain/dates.js';
import type { IsoDate } from '../domain/dates.js';
import {
  demandCategory,
  evaluateCurve,
  offerCategory,
  stageActions,
  thresholdsFor,
  upcomingClockStart,
} from '../domain/lifecurve.js';
import type { Stage, SubjectType } from '../domain/lifecurve.js';
import { exitDemand } from './exits.js';
import type { DemandViewRow, LifeCurveRow, OfferViewRow } from './model.js';
import { SYSTEM_ACTOR } from './ports.js';
import type { Tx } from './ports.js';
import { closeItems, openItem, rankOffer, resolveAssignee } from './queue-ops.js';
import { thresholds } from './settings.js';

/** How a confirmation happened (LifeCurve.lastConfirmedHow). */
export type ConfirmHow = 'call' | 'meeting' | 'visit' | 'price_sheet' | 'deal_follow_up';

export interface CurveBasis {
  categoryKey: string;
  clockFloor: IsoDate;
  clockStartsOn: IsoDate | null;
}

export const isProjectConfiguration = (o: Pick<OfferViewRow, 'deal_type' | 'market' | 'project_id'>) =>
  o.deal_type === 'Sale' && o.market === 'Primary' && !!o.project_id;

export async function offerBasis(tx: Tx, o: OfferViewRow): Promise<CurveBasis> {
  const th = (await thresholds(tx)).value;
  const floor =
    isProjectConfiguration(o) && o.price_sheet_date && o.price_sheet_date > o.captured_on
      ? o.price_sheet_date
      : o.captured_on;
  const clockStartsOn =
    o.possession_status === 'Available From' ? upcomingClockStart(o.available_from, tx.today, th.upcomingLeadDays) : null;
  return {
    categoryKey: `offer.${offerCategory({ segment: o.segment, dealType: o.deal_type, market: o.market })}`,
    clockFloor: floor,
    clockStartsOn,
  };
}

export async function demandBasis(tx: Tx, d: DemandViewRow): Promise<CurveBasis> {
  const th = (await thresholds(tx)).value;
  return {
    categoryKey: `demand.${demandCategory({ segment: d.segment, dealTypes: d.deal_types, market: d.market }, th)}`,
    clockFloor: d.captured_on,
    clockStartsOn: null,
  };
}

async function evaluate(tx: Tx, c: Pick<LifeCurveRow, 'category_key' | 'last_confirmed_at' | 'clock_floor' | 'clock_starts_on' | 'paused_until' | 'stage'>) {
  const settings = (await thresholds(tx)).value;
  const th = thresholdsFor(c.category_key, settings);
  const s = evaluateCurve({
    lastConfirmedDate: c.last_confirmed_at ? istDate(c.last_confirmed_at) : null,
    clockFloor: c.clock_floor,
    clockStartsOn: c.clock_starts_on,
    thresholds: th,
    today: tx.today,
    paused: c.stage === 'Paused' || !!c.paused_until,
  });
  // Upcoming offers are also due on their availability date (Upcoming → Available in the nightly pass, §4.1.5 step 3).
  if (c.clock_starts_on && s.stage !== 'Paused') {
    const availableOn = addDays(c.clock_starts_on, settings.upcomingLeadDays);
    if (availableOn > tx.today) s.nextChangeOn = minDate(s.nextChangeOn, availableOn);
  }
  return s;
}

export async function createCurve(tx: Tx, subjectType: SubjectType, subjectId: string, basis: CurveBasis): Promise<LifeCurveRow> {
  const draft = {
    category_key: basis.categoryKey,
    last_confirmed_at: null,
    clock_floor: basis.clockFloor,
    clock_starts_on: basis.clockStartsOn,
    paused_until: null,
    stage: 'Fresh' as const,
  };
  const s = await evaluate(tx, draft);
  const existing = await tx.q.curveBySubject(subjectType, subjectId);
  if (existing) return existing;
  const row = await tx.rows.insert('life_curve', {
    subject_type: subjectType,
    subject_id: subjectId,
    category_key: basis.categoryKey,
    stage: s.stage,
    day_count: s.dayCount,
    last_confirmed_how: 'created',
    clock_floor: basis.clockFloor,
    clock_starts_on: basis.clockStartsOn,
    next_change_on: s.nextChangeOn,
    stage_changed_at: tx.now,
  });
  return row;
}

export interface CurveChange {
  row: LifeCurveRow;
  from: Stage;
  to: Stage;
}

/**
 * Applies a patch, recomputes day/stage/next_change_on and, when the stage changed, writes lifecycle.stage_changed.v1
 * and runs the stage actions (unless `actions: false`).
 */
export async function refreshCurve(
  tx: Tx,
  curve: LifeCurveRow,
  patch: Partial<LifeCurveRow>,
  opts: { actions?: boolean } = {},
): Promise<CurveChange> {
  const merged = { ...curve, ...patch };
  let stage = merged.stage;
  let day = merged.day_count;
  let next: IsoDate | null = null;
  if (!merged.frozen) {
    const s = await evaluate(tx, merged);
    stage = s.stage;
    day = s.dayCount;
    next = s.nextChangeOn;
  }
  const changed = stage !== curve.stage;
  const row =
    (await tx.rows.update('life_curve', curve.id, {
      ...patch,
      stage,
      day_count: day,
      next_change_on: next,
      ...(changed ? { stage_changed_at: tx.now } : {}),
      ...(stage === 'Expired' && curve.subject_type === 'offer' ? { availability_unknown: true } : {}),
    })) ?? curve;
  if (changed) {
    await tx.events.emit(
      'lifecycle.stage_changed.v1',
      { type: curve.subject_type, id: curve.subject_id },
      { subjectType: curve.subject_type, subjectId: curve.subject_id, from: curve.stage, to: stage, day },
    );
    if (opts.actions !== false) await applyStageActions(tx, curve.subject_type, curve.subject_id, stage);
  }
  return { row, from: curve.stage, to: stage };
}

/** Stage actions (LLD §4.1.4). Offers that are Closed/Inactive/voided or outside the launch area get no queue items. */
export async function applyStageActions(tx: Tx, subjectType: SubjectType, subjectId: string, to: Stage): Promise<void> {
  if (subjectType === 'offer') {
    const [view, oj] = await Promise.all([tx.rows.get('offer_view', subjectId), tx.rows.get('offer_journey', subjectId)]);
    if (!view || !oj || view.voided || view.outside_launch_area) return;
    if (oj.commercial_status === 'Closed' || oj.commercial_status === 'Inactive') return;
    const actions = stageActions('offer', to, {
      publicationLevel: view.publication_level,
      isProjectConfiguration: isProjectConfiguration(view),
    });
    for (const a of actions) {
      if (a.kind === 'queue' && a.section === 'should_call') {
        await openItem(tx, {
          section: 'should_call',
          subjectType: 'offer',
          subjectId,
          subjectCode: view.code,
          offerId: subjectId,
          assignee: await resolveAssignee(tx, 'supply', view.owner_user_id),
          reason: a.reason,
          rank: await rankOffer(tx, view, a.boost),
        });
      }
    }
    return;
  }
  const [view, dj] = await Promise.all([tx.rows.get('demand_view', subjectId), tx.rows.get('demand_journey', subjectId)]);
  if (!view || !dj || view.voided || dj.exit_type || dj.commercial_status === 'Closed') return;
  for (const a of stageActions('demand', to, { publicationLevel: null, isProjectConfiguration: false })) {
    if (a.kind === 'queue' && a.section === 'reconfirm_due' && !view.outside_launch_area) {
      await openItem(tx, {
        section: 'reconfirm_due',
        subjectType: 'demand',
        subjectId,
        subjectCode: view.code,
        demandId: subjectId,
        assignee: await resolveAssignee(tx, 'demand', view.owner_user_id),
        reason: 'reconfirm',
        dueAt: tx.now,
      });
    }
    if (a.kind === 'dormant_exit') {
      const th = (await thresholds(tx)).value;
      await exitDemand(tx, subjectId, {
        type: 'Dormant',
        reasonCode: 'life_curve_expired',
        revisitDays: th.dormantRevisitDays,
        actor: SYSTEM_ACTOR,
        via: 'system',
      });
    }
  }
}

/**
 * Confirmation (LLD §4.1.3): resets last_confirmed_at, recomputes, clears availability_unknown, closes reconfirm items and
 * writes offer.confirmed.v1 / demand.confirmed.v1 (+ lifecycle.stage_changed.v1 when the stage changes).
 */
export async function confirmSubject(
  tx: Tx,
  subjectType: SubjectType,
  subjectId: string,
  how: ConfirmHow,
  eventHow: string,
  at: Date = tx.now,
  extra: Partial<LifeCurveRow> = {},
): Promise<CurveChange | undefined> {
  const curve = await tx.q.curveBySubject(subjectType, subjectId);
  if (!curve) return undefined;
  const last = curve.last_confirmed_at && curve.last_confirmed_at > at ? curve.last_confirmed_at : at;
  const change = await refreshCurve(tx, curve, {
    last_confirmed_at: last,
    last_confirmed_how: how,
    availability_unknown: false,
    ...extra,
  });
  await closeItems(
    tx,
    { subjectId, sections: [subjectType === 'offer' ? 'should_call' : 'reconfirm_due'] },
    'done',
    'confirmed',
  );
  if (subjectType === 'offer') {
    const offerHow = (['call', 'meeting', 'visit', 'price_sheet'] as const).includes(eventHow as 'call')
      ? (eventHow as 'call' | 'meeting' | 'visit' | 'price_sheet')
      : 'call';
    await tx.events.emit('offer.confirmed.v1', { type: 'offer', id: subjectId }, { offerId: subjectId, confirmedAt: at.toISOString(), how: offerHow });
  } else {
    await tx.events.emit('demand.confirmed.v1', { type: 'demand', id: subjectId }, { demandId: subjectId, confirmedAt: at.toISOString(), how: eventHow });
  }
  return change;
}

/** Closed / Inactive / Lost / Invalid / voided: the curve stops (no event: the stage itself is unchanged). */
export async function freezeCurve(tx: Tx, subjectType: SubjectType, subjectId: string): Promise<void> {
  const curve = await tx.q.curveBySubject(subjectType, subjectId);
  if (curve && !curve.frozen) await tx.rows.update('life_curve', curve.id, { frozen: true, next_change_on: null });
}

/** Unfreezes a curve and recomputes it from the last confirmation (deal cancel compensation). */
export async function unfreezeCurve(tx: Tx, subjectType: SubjectType, subjectId: string): Promise<CurveChange | undefined> {
  const curve = await tx.q.curveBySubject(subjectType, subjectId);
  if (!curve) return undefined;
  return refreshCurve(tx, curve, { frozen: false, paused_until: null, ...(curve.stage === 'Paused' ? { stage: 'Fresh' } : {}) });
}
