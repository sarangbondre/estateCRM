// Read models returned by the API (contract schemas LifeCurve, QueueRef, OfferJourney, DemandJourney).
import { istDate } from '../domain/dates.js';
import { evaluateCurve, thresholdsFor } from '../domain/lifecurve.js';
import type { Stage } from '../domain/lifecurve.js';
import { notFoundErr } from './errors.js';
import type { DemandJourneyRow, DemandViewRow, LifeCurveRow, OfferJourneyRow, OfferViewRow, QueueItemRow } from './model.js';
import type { Tx } from './ports.js';
import { thresholds } from './settings.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID.test(s);

export async function offerByIdOrCode(tx: Tx, idOrCode: string): Promise<OfferViewRow> {
  const v = isUuid(idOrCode) ? await tx.rows.get('offer_view', idOrCode) : await tx.rows.byCode('offer_view', idOrCode);
  if (!v) throw notFoundErr('offer');
  return v;
}
export async function demandByIdOrCode(tx: Tx, idOrCode: string): Promise<DemandViewRow> {
  const v = isUuid(idOrCode) ? await tx.rows.get('demand_view', idOrCode) : await tx.rows.byCode('demand_view', idOrCode);
  if (!v) throw notFoundErr('demand');
  return v;
}

const HOWS = ['call', 'meeting', 'visit', 'price_sheet', 'deal_follow_up', 'created'] as const;

/** LifeCurve with the day count and stage as of today (read-only evaluation). */
export async function lifeCurveView(tx: Tx, curve: LifeCurveRow, code: string, lastSeenOn: string | null) {
  const settings = (await thresholds(tx)).value;
  const th = thresholdsFor(curve.category_key, settings);
  let stage: Stage = curve.stage;
  let day = curve.day_count;
  let next = curve.next_change_on;
  if (!curve.frozen && curve.stage !== 'Paused') {
    const s = evaluateCurve({
      lastConfirmedDate: curve.last_confirmed_at ? istDate(curve.last_confirmed_at) : null,
      clockFloor: curve.clock_floor,
      clockStartsOn: curve.clock_starts_on,
      thresholds: th,
      today: tx.today,
      paused: false,
    });
    // The stored stage changes only through the nightly run / confirmations (with their events); show today's day.
    day = s.dayCount;
    if (s.stage === curve.stage) next = curve.next_change_on ?? s.nextChangeOn;
    stage = curve.stage;
  }
  return {
    subjectType: curve.subject_type,
    subjectId: curve.subject_id,
    code,
    categoryKey: curve.category_key as 'offer.lease_residential',
    stage,
    dayCount: day,
    lastConfirmedAt: curve.last_confirmed_at ? curve.last_confirmed_at.toISOString() : null,
    lastConfirmedHow: (HOWS as readonly string[]).includes(curve.last_confirmed_how ?? '') ? (curve.last_confirmed_how as 'call') : null,
    clockStartsOn: curve.clock_starts_on,
    lastSeenAt: lastSeenOn ? new Date(`${lastSeenOn}T00:00:00+05:30`).toISOString() : null,
    pausedUntil: curve.paused_until,
    nextChangeOn: next,
    thresholds: th,
    availabilityUnknown: curve.availability_unknown,
  };
}
export type LifeCurveView = Awaited<ReturnType<typeof lifeCurveView>>;

export const queueRef = (i: QueueItemRow) => ({
  section: i.section as 'must_call',
  queueItemId: i.id,
  rank: i.rank_score,
  reason: i.reason,
  dueAt: i.due_at ? i.due_at.toISOString() : null,
  attempts: i.attempts,
  nextCallDate: i.next_call_date,
});

const SECTION_ORDER = ['must_call', 'should_call', 'to_contact', 'to_qualify', 'reconfirm_due', 'dormant_revisits', 'needs_sourcing', 'open_matches'];
/** The item a card acts on: the first open item of the subject in section priority order. */
export function primaryItem(items: readonly QueueItemRow[], subjectId: string): QueueItemRow | undefined {
  const own = items.filter((i) => i.subject_id === subjectId && i.status === 'open');
  return own.sort((a, b) => {
    const ia = SECTION_ORDER.indexOf(a.section);
    const ib = SECTION_ORDER.indexOf(b.section);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  })[0];
}

async function curveOf(tx: Tx, type: 'offer' | 'demand', id: string): Promise<LifeCurveRow> {
  const c = await tx.q.curveBySubject(type, id);
  if (!c) throw notFoundErr(`${type} journey`);
  return c;
}

export async function offerJourneyView(tx: Tx, view: OfferViewRow, oj?: OfferJourneyRow) {
  const journey = oj ?? (await tx.rows.get('offer_journey', view.id));
  if (!journey) throw notFoundErr('offer journey');
  const curve = await curveOf(tx, 'offer', view.id);
  const item = primaryItem(await tx.q.openItemsOf({ offerId: view.id }, 50), view.id);
  const deals = await tx.q.openDealsOfOffer(view.id, 50);
  const proposals = await tx.q.openProposalIdsOfOffer(view.id, 50);
  return {
    offerId: view.id,
    code: view.code,
    commercialStatus: journey.commercial_status,
    commercialChangedAt: journey.commercial_changed_at.toISOString(),
    inactiveReason: (journey.inactive_reason as 'other' | null) ?? null,
    lifeCurve: await lifeCurveView(tx, curve, view.code, view.last_seen_on),
    queue: item ? queueRef(item) : null,
    signals: {
      enquiries: journey.enquiry_count,
      openMatches: journey.open_match_count,
      confirmedMatches: journey.confirmed_match_count,
    },
    sourcedForDemandId: view.sourced_for_demand_id,
    openDealIds: deals.map((d) => d.id),
    openProposalIds: proposals,
    version: journey.version,
  };
}

export async function demandJourneyView(tx: Tx, view: DemandViewRow, dj?: DemandJourneyRow) {
  const journey = dj ?? (await tx.rows.get('demand_journey', view.id));
  if (!journey) throw notFoundErr('demand journey');
  const curve = await curveOf(tx, 'demand', view.id);
  const item = primaryItem(await tx.q.openItemsOf({ demandId: view.id }, 50), view.id);
  const srqs = await tx.q.openSourcingRequestsOfDemand(view.id);
  const deal = await tx.q.openDealOfDemand(view.id);
  const live = await tx.q.countMatchesOfDemand(view.id, ['Suggested', 'Confirmed']);
  const q = journey.qualification as Record<string, unknown> | null;
  return {
    demandId: view.id,
    code: view.code,
    commercialStatus: journey.commercial_status,
    commercialChangedAt: journey.commercial_changed_at.toISOString(),
    exit: journey.exit_type
      ? {
          type: journey.exit_type,
          ...(journey.exit_reason_code ? { reasonCode: journey.exit_reason_code } : {}),
          reason: journey.exit_reason,
          competingTerms: journey.competing_terms,
          competingPriceInr: journey.competing_price_inr,
          flagPerson: journey.exit_flag_person,
          personId: journey.exit_person_id,
          revisitDate: journey.revisit_date,
          exitedAt: (journey.exited_at ?? journey.updated_at).toISOString(),
          ...(journey.exited_by ? { exitedBy: journey.exited_by } : {}),
        }
      : null,
    qualifiedAt: journey.qualified_at ? journey.qualified_at.toISOString() : null,
    qualification: q
      ? {
          decisionMakerReached: q['decisionMakerReached'] === true,
          budgetConfirmed: q['budgetConfirmed'] === true,
          timingConfirmed: q['timingConfirmed'] === true,
          agreesToWork: q['agreesToWork'] === true,
          decisionMakerNote: typeof q['decisionMakerNote'] === 'string' ? q['decisionMakerNote'] : null,
        }
      : null,
    lifeCurve: await lifeCurveView(tx, curve, view.code, view.last_seen_on),
    queue: item ? queueRef(item) : null,
    ownerUserId: view.owner_user_id,
    liveMatches: live,
    openSourcingRequestIds: srqs.map((s) => s.id),
    openDealId: deal?.id ?? null,
    unreachable: journey.unreachable,
    version: journey.version,
  };
}
