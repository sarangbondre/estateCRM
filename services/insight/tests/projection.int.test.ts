// INS-01: the read model fed by the 64 subscribed events (LLD §3, §4.10) on the local stack.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import topology from '@11e/contracts/event-topology.json' with { type: 'json' };
import { sql } from '@11e/db';
import { HANDLED_EVENTS } from '../src/application/projection.js';
import { reconcileRollups } from '../src/adapters/reconcile.js';
import { demandCreated, offerCreated } from './fixtures.js';
import { harness, ids } from './helpers.js';

const h = harness();
afterAll(() => h.close());
const T = h.tenantId;

const offer = async (id: string) =>
  (await h.rows<Record<string, unknown>>(sql`select * from rm_offer where tenant_id = ${T} and id = ${id}`))[0];
const demand = async (id: string) =>
  (await h.rows<Record<string, unknown>>(sql`select * from rm_demand where tenant_id = ${T} and id = ${id}`))[0];
const offerRollupTotal = async (where = sql`true`) =>
  Number(
    (await h.rows<{ n: string | null }>(sql`select sum(n) as n from rm_offer_rollup where tenant_id = ${T} and ${where}`))[0]?.n ??
      0,
  );
const factTotal = async (metric: string) =>
  Number(
    (
      await h.rows<{ n: number | null }>(
        sql`select sum(n)::int as n from rm_daily_fact where tenant_id = ${T} and metric = ${metric}`,
      )
    )[0]?.n ?? 0,
  );

describe('subscriptions', () => {
  it('handles exactly the events routed to q_insight', () => {
    const routed = Object.entries(topology.routes as Record<string, { queues: string[] }>)
      .filter(([, r]) => r.queues.includes('q_insight'))
      .map(([type]) => type)
      .sort();
    expect([...HANDLED_EVENTS].sort()).toEqual(routed);
    expect(routed.length).toBe(64);
  });
});

describe('offers', () => {
  it('projects an offer through its life and keeps the rollup in step', async () => {
    const o = offerCreated();
    await h.deliver('offer.created.v1', o, { aggregateId: o.offerId, producer: 'records' });
    let row = await offer(o.offerId);
    expect(row).toMatchObject({ code: o.code, deal_type: 'Lease', bhk_min: 2, commercial_status: 'Available' });
    expect(await offerRollupTotal(sql`deal_type = 'Lease'`)).toBeGreaterThanOrEqual(1);
    expect(await factTotal('offer_created')).toBe(1);

    const agent = ids();
    await h.deliver(
      'offer.record_stage_changed.v1',
      { offerId: o.offerId, from: 'Enriched', to: 'Verified', changedBy: agent },
      { aggregateId: o.offerId, producer: 'records' },
    );
    await h.deliver('lifecycle.stage_changed.v1', { subjectType: 'offer', subjectId: o.offerId, from: 'Fresh', to: 'Stale', day: 61 }, { aggregateId: o.offerId, producer: 'journeys' });
    await h.deliver('publication.changed.v1', { subjectType: 'offer', subjectId: o.offerId, from: 'Private', to: 'Public', reason: 'user', publicId: 'P-1' }, { aggregateId: o.offerId, producer: 'listings' });
    await h.deliver('offer.commercial_status_changed.v1', { offerId: o.offerId, from: 'Available', to: 'Matched' }, { aggregateId: o.offerId, producer: 'journeys' });
    row = await offer(o.offerId);
    expect(row).toMatchObject({ record_stage: 'Verified', verified_by: agent, life_stage: 'Stale', publication_level: 'Public', commercial_status: 'Matched' });
    expect(await factTotal('offer_verified')).toBe(1);
    expect(await factTotal('offer_published_public')).toBe(1);
    // exactly one rollup tuple carries this offer
    expect(await offerRollupTotal(sql`life_stage = 'Stale' and publication_level = 'Public'`)).toBe(1);
    expect(await offerRollupTotal()).toBe(1);
  });

  it('ignores stale versions of the same stream and applies other streams independently', async () => {
    const o = offerCreated({ rentMonthlyInrMin: 50_000, rentMonthlyInrMax: 50_000 });
    await h.deliver('offer.created.v1', o, { aggregateId: o.offerId, version: 1 });
    await h.deliver('offer.updated.v1', { ...o, rentMonthlyInrMin: 70_000, rentMonthlyInrMax: 70_000 }, { aggregateId: o.offerId, version: 3 });
    // an older price change arrives late: ignored
    await h.deliver('offer.price_changed.v1', { offerId: o.offerId, previous: {}, current: { rentMonthlyInrMin: 55_000 } }, { aggregateId: o.offerId, version: 2 });
    expect((await offer(o.offerId))?.['rent_monthly_inr_min']).toBe(70_000);
    // a journeys event with a low version is a different stream and applies
    await h.deliver('offer.confirmed.v1', { offerId: o.offerId, confirmedAt: '2026-10-06T10:00:00.000Z', how: 'call' }, { aggregateId: o.offerId, version: 1 });
    expect((await offer(o.offerId))?.['confirmed_how']).toBe('call');
  });

  it('creates a stub for an event that arrives before offer.created and fills it later', async () => {
    const o = offerCreated();
    await h.deliver('lifecycle.stage_changed.v1', { subjectType: 'offer', subjectId: o.offerId, from: 'Fresh', to: 'Ageing', day: 31 }, { aggregateId: o.offerId });
    const before = await offerRollupTotal();
    let row = await offer(o.offerId);
    expect(row).toMatchObject({ code: null, life_stage: 'Ageing' });
    await h.deliver('offer.created.v1', o, { aggregateId: o.offerId, version: 1 });
    row = await offer(o.offerId);
    expect(row).toMatchObject({ code: o.code, life_stage: 'Ageing' });
    expect(await offerRollupTotal()).toBe(before + 1);
  });

  it('voided and merged offers leave the rollups; merge_undone brings them back', async () => {
    const a = offerCreated();
    const b = offerCreated();
    await h.deliver('offer.created.v1', a, { aggregateId: a.offerId });
    await h.deliver('offer.created.v1', b, { aggregateId: b.offerId });
    const total = await offerRollupTotal();
    await h.deliver('records.merged.v1', { mergeId: ids(), aggregateType: 'offer', survivorId: a.offerId, mergedIds: [b.offerId] });
    expect(await offerRollupTotal()).toBe(total - 1);
    expect((await offer(b.offerId))?.['merged_into_id']).toBe(a.offerId);
    await h.deliver('records.merge_undone.v1', { mergeId: ids(), aggregateType: 'offer', restoredIds: [b.offerId] });
    expect(await offerRollupTotal()).toBe(total);
    await h.deliver('offer.voided.v1', { offerId: b.offerId, reason: 'side_changed' }, { aggregateId: b.offerId, version: 5 });
    expect(await offerRollupTotal()).toBe(total - 1);
    expect(await factTotal('records_merged')).toBe(1);
  });

  it('counts photos per property, enquiries and matches', async () => {
    const o = offerCreated();
    await h.deliver('offer.created.v1', o, { aggregateId: o.offerId });
    await h.deliver('photo.added.v1', { photoId: ids(), propertyId: o.propertyId, origin: 'call', isReal: true, storagePath: 'p/1.jpg' });
    await h.deliver('photo.added.v1', { photoId: ids(), propertyId: o.propertyId, origin: 'call', storagePath: 'p/2.jpg' });
    await h.deliver('photo.removed.v1', { photoId: ids(), propertyId: o.propertyId });
    await h.deliver('enquiry.received.v1', { enquiryId: ids(), code: 'ENQ-0001', offerId: o.offerId });
    const d = demandCreated();
    await h.deliver('demand.created.v1', d, { aggregateId: d.demandId });
    const matchId = ids();
    await h.deliver('match.suggested.v1', { matchId, code: 'MAT-0001', demandId: d.demandId, offerIds: [o.offerId], score: 82 }, { aggregateId: matchId, version: 1 });
    await h.deliver('match.confirmed.v1', { matchId, demandId: d.demandId, offerIds: [o.offerId] }, { aggregateId: matchId, version: 2 });
    // duplicate-ish redelivery with a new event id of an older version: status stays, counts don't double
    await h.deliver('match.suggested.v1', { matchId, code: 'MAT-0001', demandId: d.demandId, offerIds: [o.offerId], score: 82 }, { aggregateId: matchId, version: 1 });
    await h.deliver('match.flagged.v1', { matchId, flag: 'reconfirm', cleared: false }, { aggregateId: matchId, version: 3 });
    const row = await offer(o.offerId);
    expect(row).toMatchObject({ photo_count: 1, has_real_photos: true, enquiry_count: 1, match_suggested_count: 1, match_confirmed_count: 1 });
    const m = (await h.rows<Record<string, unknown>>(sql`select * from rm_match where tenant_id = ${T} and id = ${matchId}`))[0];
    expect(m).toMatchObject({ status: 'Confirmed', flags: ['reconfirm'] });
    expect(await demand(d.demandId)).toMatchObject({ match_suggested_count: 1, match_confirmed_count: 1 });
  });
});

describe('demands', () => {
  it('keeps first-touch credit, sourcing time, qualification and exits', async () => {
    const d = demandCreated({ sourceType: 'Digi' });
    await h.deliver('demand.created.v1', d, { aggregateId: d.demandId });
    await h.deliver('demand.touch_added.v1', { demandId: d.demandId, touchId: ids(), sourceType: 'Channel', isFirstTouch: false });
    expect(await demand(d.demandId)).toMatchObject({ source_type: 'Digi', touch_count: 1, commercial_status: 'New' });
    await h.deliver('demand.qualified.v1', { demandId: d.demandId });
    await h.deliver('demand.status_changed.v1', { demandId: d.demandId, from: 'Active', to: 'Sourcing' }, { aggregateId: d.demandId, occurredAt: '2026-09-20T05:00:00.000Z' });
    let row = await demand(d.demandId);
    expect(row?.['commercial_status']).toBe('Sourcing');
    expect(new Date(row?.['sourcing_since'] as string).toISOString()).toBe('2026-09-20T05:00:00.000Z');
    expect(await factTotal('demand_qualified')).toBe(1);
    await h.deliver('demand.exited.v1', { demandId: d.demandId, exit: 'Lost', reason: 'competitor', competingPriceInr: 72_000 });
    row = await demand(d.demandId);
    expect(row).toMatchObject({ exit_type: 'Lost', exit_reason: 'competitor' });
    expect(await factTotal('demand_exit_lost')).toBe(1);
    const prices = await h.rows(sql`select * from rm_market_price where tenant_id = ${T} and source = 'reported'`);
    expect(prices).toHaveLength(1);
    await h.deliver('demand.reactivated.v1', { demandId: d.demandId });
    expect((await demand(d.demandId))?.['exit_type']).toBeNull();
  });
});

describe('deals, market prices, queues and people', () => {
  it('copies offer dimensions onto deals and records closes as market prices (void on cancel)', async () => {
    const o = offerCreated({ segment: 'Commercial', propertyTypes: ['Office'], micromarket: 'Marol', locality: 'Marol' });
    const d = demandCreated({ segment: 'Commercial', ownerUserId: ids() });
    await h.deliver('offer.created.v1', o, { aggregateId: o.offerId });
    await h.deliver('demand.created.v1', d, { aggregateId: d.demandId });
    const dealId = ids();
    await h.deliver('deal.opened.v1', { dealId, code: 'DEAL-0001', demandId: d.demandId, offerId: o.offerId });
    await h.deliver('deal.updated.v1', { dealId, stage: 'Negotiation', followUpDate: '2026-10-05', overdue: true }, { aggregateId: dealId, version: 2 });
    await h.deliver('deal.closed.v1', { dealId, demandId: d.demandId, offerId: o.offerId, closedAt: '2026-10-06T08:00:00.000Z', closingPriceInr: 112_000, dealType: 'Lease' });
    const deal = (await h.rows<Record<string, unknown>>(sql`select * from rm_deal where tenant_id = ${T} and id = ${dealId}`))[0];
    expect(deal).toMatchObject({ status: 'closed', segment: 'Commercial', micromarket: 'Marol', owner_user_id: d.ownerUserId, follow_up_date: '2026-10-05' });
    const price = (await h.rows<Record<string, unknown>>(sql`select * from rm_market_price where tenant_id = ${T} and id = ${dealId}`))[0];
    expect(price).toMatchObject({ source: 'closed_by_us', rent_monthly_inr: 112_000, price_inr: null, void: false });
    await h.deliver('deal.cancelled.v1', { dealId, demandId: d.demandId, offerId: o.offerId, reason: 'client_backed_out' });
    const voided = (await h.rows<Record<string, unknown>>(sql`select void from rm_market_price where tenant_id = ${T} and id = ${dealId}`))[0];
    expect(voided?.['void']).toBe(true);
  });

  it('stores queue counts (newest wins) and users without names', async () => {
    const userId = ids();
    await h.deliver('queue.counts_changed.v1', { userId, counts: { must_call: 4, should_call: 9 } }, { aggregateId: userId, version: 2 });
    await h.deliver('queue.counts_changed.v1', { userId, counts: { must_call: 1 } }, { aggregateId: userId, version: 1 });
    const q = (await h.rows<{ counts: Record<string, number> }>(sql`select counts from rm_queue_counts where tenant_id = ${T} and user_id = ${userId}`))[0];
    expect(q?.counts).toEqual({ must_call: 4, should_call: 9 });
    await h.deliver('user.changed.v1', { userId, role: 'Supply agent', active: true, displayName: 'Test Agent' }, { aggregateId: userId });
    const u = (await h.rows<Record<string, unknown>>(sql`select * from rm_user where tenant_id = ${T} and user_id = ${userId}`))[0];
    expect(u).toMatchObject({ role: 'Supply agent', active: true });
    expect(Object.keys(u ?? {})).not.toContain('display_name');
  });

  it('projects intake uploads, row statistics (no row content) and review items', async () => {
    const uploadId = ids();
    await h.deliver('upload.started.v1', { uploadId, code: 'UPL-0001', mode: 'strict', sourceType: 'Newspaper', rowCount: 3, uploadedBy: ids() });
    await h.deliver('rows.classified.v1', {
      uploadId,
      batchNo: 1,
      rows: [
        { rowId: ids(), externalRef: 'a1b2c3d4e5f6', recordScope: 'Property', side: 'Supply', needsReview: true, reviewReasonCode: 'side_defaulted' },
        { rowId: ids(), externalRef: 'a1b2c3d4e5f7', recordScope: 'Property', side: 'Supply', needsReview: true, reviewReasonCode: 'side_defaulted' },
        { rowId: ids(), externalRef: 'a1b2c3d4e5f8', recordScope: 'Property', side: 'Demand' },
      ],
    });
    await h.deliver('upload.completed.v1', { uploadId, code: 'UPL-0001', counts: { read: 3, accepted: 2, rejected: 1, needsReview: 2 }, rejectionReasons: { 'value-not-in-list': 1 }, sourceType: 'Newspaper', uploadedBy: ids() });
    const reviewItemId = ids();
    await h.deliver('review_item.created.v1', { reviewItemId, uploadId, reasonCode: 'side_defaulted' });
    await h.deliver('review_item.resolved.v1', { reviewItemId, uploadId, rowId: ids(), externalRef: 'a1b2c3d4e5f6', action: 'confirm' });
    const stats = await h.rows<{ review_reason_code: string | null; count: number }>(
      sql`select review_reason_code, count from rm_row_stat where tenant_id = ${T} and upload_id = ${uploadId} order by count desc`,
    );
    expect(stats.map((s) => [s.review_reason_code, s.count])).toEqual([['side_defaulted', 2], [null, 1]]);
    const up = (await h.rows<Record<string, unknown>>(sql`select * from rm_upload where tenant_id = ${T} and id = ${uploadId}`))[0];
    expect(up).toMatchObject({ status: 'completed', accepted: 2, rejected: 1, rejection_reasons: { 'value-not-in-list': 1 } });
    const item = (await h.rows<Record<string, unknown>>(sql`select status from rm_review_item where tenant_id = ${T} and id = ${reviewItemId}`))[0];
    expect(item?.['status']).toBe('resolved');
  });

  it('applies the remaining reference, desk, sourcing, visit and person events', async () => {
    const d = demandCreated();
    await h.deliver('demand.created.v1', d, { aggregateId: d.demandId });
    const srq = ids();
    await h.deliver('sourcing_request.created.v1', { sourcingRequestId: srq, code: 'SRQ-001', demandId: d.demandId, assigneeUserId: ids(), dueDate: '2026-10-10' });
    await h.deliver('sourcing_request.updated.v1', { sourcingRequestId: srq, status: 'fulfilled' }, { aggregateId: srq, version: 2 });
    await h.deliver('demand.sourcing_started.v1', { demandId: d.demandId, postAnonymously: true });
    const proposalId = ids();
    const matchId = ids();
    await h.deliver('proposal.sent.v1', { proposalId, demandId: d.demandId, matchIds: [matchId] });
    await h.deliver('proposal.feedback_recorded.v1', { proposalId, demandId: d.demandId, feedback: [{ matchId, verdict: 'liked' }] });
    const visitId = ids();
    await h.deliver('site_visit.scheduled.v1', { visitId, demandId: d.demandId, offerIds: [ids()], scheduledFor: '2026-10-08T06:00:00.000Z' });
    await h.deliver('site_visit.completed.v1', { visitId, demandId: d.demandId, offerIds: [ids()] });
    await h.deliver('demand.confirmed.v1', { demandId: d.demandId, confirmedAt: '2026-10-06T06:00:00.000Z', how: 'call' });
    await h.deliver('demand.matching_completed.v1', { demandId: d.demandId, runId: ids(), matchCount: 0, bundleCount: 0 });
    await h.deliver('demand.updated.v1', { ...d, bhkMax: 3 }, { aggregateId: d.demandId, version: 2 });
    await h.deliver('demand.voided.v1', { demandId: d.demandId, reason: 'scope_changed' }, { aggregateId: d.demandId, version: 3 });
    const personId = ids();
    await h.deliver('person.flagged.v1', { personId, flag: 'broker' });
    await h.deliver('person.flag_removed.v1', { personId, flag: 'broker' });
    const desk = ids();
    await h.deliver('desk_item.created.v1', { deskItemId: desk, code: 'BIZ-0001', recordScope: 'Business', side: 'Supply', sector: 'Hospitality' });
    await h.deliver('desk_item.updated.v1', { deskItemId: desk, status: 'assigned', assigneeUserId: ids() }, { aggregateId: desk, version: 2 });
    const wl = ids();
    await h.deliver('watchlist_item.created.v1', { watchlistItemId: wl, code: 'WL-0001', signalType: 'Auction', deadlineDate: '2026-10-15' });
    await h.deliver('watchlist_task.completed.v1', { taskId: ids(), watchlistItemId: wl });
    await h.deliver('merge_candidate.raised.v1', { candidateId: ids(), kind: 'price_gap', aggregateType: 'offer' });
    await h.deliver('market_data.recorded.v1', { marketDataId: ids(), kind: 'reported', dealType: 'Lease', segment: 'Commercial', micromarket: 'Marol', priceInr: 95_000 });
    await h.deliver('market_data.recorded.v1', { marketDataId: ids(), kind: 'closed_by_us', dealType: 'Lease', priceInr: 1 });
    const projectId = ids();
    await h.deliver('project.created.v1', { projectId, code: 'PRJ-0031', name: 'Test Heights', micromarket: 'Powai' }, { aggregateId: projectId });
    await h.deliver('project.updated.v1', { projectId, code: 'PRJ-0031', name: 'Test Heights', micromarket: 'Powai', reraNumber: 'P51800000001' }, { aggregateId: projectId, version: 2 });
    await h.deliver('price_sheet.applied.v1', { projectId, priceSheetId: ids(), sheetDate: '2026-10-01' });
    await h.deliver('upload.failed.v1', { uploadId: ids(), code: 'UPL-0002', reason: 'file-unreadable', uploadedBy: ids() });
    await h.deliver('vocabulary.released.v1', { version: 'v0.6', checksum: 'abc' });
    await h.deliver('micromarkets.updated.v1', { version: 2 });
    const callId = ids();
    await h.deliver('call.logged.v1', { callId, subjectType: 'demand', subjectId: d.demandId, outcome: 'confirmed', calledBy: ids() });
    const o = offerCreated();
    await h.deliver('offer.created.v1', o, { aggregateId: o.offerId });
    await h.deliver('offer.retired.v1', { offerId: o.offerId, reason: 'already_gone', knownPriceInr: 60_000 });
    const m = ids();
    await h.deliver('match.suggested.v1', { matchId: m, code: 'MAT-0002', demandId: d.demandId, offerIds: [o.offerId], score: 70 }, { aggregateId: m, version: 1 });
    await h.deliver('match.rejected.v1', { matchId: m, demandId: d.demandId, reason: 'too_far' }, { aggregateId: m, version: 2 });
    await h.deliver('match.reopened.v1', { matchId: m, demandId: d.demandId, reason: 'deal_cancelled' }, { aggregateId: m, version: 3 });
    await h.deliver('match.closed.v1', { matchId: m, demandId: d.demandId, reason: 'offer_retired' }, { aggregateId: m, version: 4 });

    const one = async (table: string, id: string) =>
      (await h.rows<Record<string, unknown>>(sql`select * from ${sql.table(table)} where tenant_id = ${T} and id = ${id}`))[0];
    expect(await one('rm_sourcing_request', srq)).toMatchObject({ status: 'fulfilled' });
    expect(await one('rm_proposal', proposalId)).toMatchObject({ feedback: { [matchId]: 'liked' } });
    expect((await one('rm_site_visit', visitId))?.['completed_at']).not.toBeNull();
    expect(await one('rm_desk_item', desk)).toMatchObject({ status: 'assigned', sector: 'Hospitality' });
    expect(await one('rm_watchlist_item', wl)).toMatchObject({ task_open: false });
    expect(await one('rm_project', projectId)).toMatchObject({ rera_number: 'P51800000001', latest_sheet_date: '2026-10-01' });
    expect(await one('rm_call', callId)).toMatchObject({ outcome: 'confirmed' });
    expect(await one('rm_match', m)).toMatchObject({ status: 'Closed', close_reason: 'offer_retired' });
    expect(await one('rm_market_price', o.offerId)).toMatchObject({ source: 'retired_known', rent_monthly_inr: 60_000 });
    const dm = await demand(d.demandId);
    expect(dm).toMatchObject({ void_reason: 'scope_changed', bhk_max: 3, last_match_count: 0 });
    expect(dm?.['sourcing_since']).not.toBeNull();
    const flags = await h.rows<{ active: boolean }>(sql`select active from rm_person_flag where tenant_id = ${T} and person_id = ${personId}`);
    expect(flags).toEqual([{ active: false }]);
    const closedByUs = await h.rows(sql`select 1 from rm_market_price where tenant_id = ${T} and source = 'closed_by_us' and price_inr = 1`);
    expect(closedByUs).toHaveLength(0);
    const cp = await h.rows<{ cursor: string }>(sql`select cursor from job_checkpoint where tenant_id = ${T} and job = 'vocabulary-refresh'`);
    expect(cp[0]?.cursor).toMatch(/^pending:/);
    const state = await h.rows<{ last_event_at: Date }>(sql`select last_event_at from rm_state where tenant_id = ${T}`);
    expect(state[0]?.last_event_at).toBeInstanceOf(Date);
  });
});

describe('rollup-reconcile', () => {
  it('rebuilds exactly the incremental rollups and corrects drift', async () => {
    const snapshot = async () =>
      h.rows<{ dims_hash: string; n: number }>(
        sql`select dims_hash, n from rm_offer_rollup where tenant_id = ${T} and n <> 0 order by dims_hash`,
      );
    const demandSnap = async () =>
      h.rows<{ dims_hash: string; n: number }>(
        sql`select dims_hash, n from rm_demand_rollup where tenant_id = ${T} and n <> 0 order by dims_hash`,
      );
    const incremental = await snapshot();
    const incrementalDemand = await demandSnap();
    // inject drift
    await sql`update rm_offer_rollup set n = n + 7 where tenant_id = ${T}`.execute(h.db);
    await reconcileRollups(h.db, T);
    expect(await snapshot()).toEqual(incremental);
    expect(await demandSnap()).toEqual(incrementalDemand);
  });

  it('isolates tenants (NFR-15)', async () => {
    const other = randomUUID();
    const o = offerCreated();
    await h.deliver('offer.created.v1', o, { aggregateId: o.offerId, tenant: other });
    expect(await offer(o.offerId)).toBeUndefined();
    const theirs = await h.rows(sql`select 1 from rm_offer where tenant_id = ${other} and id = ${o.offerId}`);
    expect(theirs).toHaveLength(1);
  });
});
