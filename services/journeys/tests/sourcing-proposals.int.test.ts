// JOU-06 (sourcing requests, sourced-for supply, needs_sourcing) and JOU-07 (proposals: Confirmed-match options,
// async snapshot with MahaRERA, PDF, share link + public page, mark sent, feedback) — incl. AS-D2 and AS-S3 parts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@11e/db';
import type { EventDataMap } from '@11e/contracts/events';
import { buildSnapshot, renderPdf } from '../src/application/proposals.js';
import { RERA_PENDING } from '../src/domain/proposals.js';
import { ensureMigrated, eventProblems, harness, ids } from './helpers.js';

const h = harness();
const supply = ids();
const demandAgent = ids();
const manager = ids();
beforeAll(async () => {
  await ensureMigrated();
  h.clock.day('2026-04-01');
  for (const [userId, role] of [
    [supply, 'Supply agent'],
    [demandAgent, 'Demand agent'],
    [manager, 'Manager'],
  ] as const)
    await h.deliver('user.changed.v1', { userId, role, active: true }, { aggregateId: userId });
});
afterAll(() => h.close());

let n = 0;
async function qualifiedDemand() {
  n++;
  const d: EventDataMap['demand.created.v1'] = {
    demandId: ids(),
    code: `DEM-1${String(n).padStart(5, '0')}`,
    dealTypes: ['Lease'],
    segment: 'Commercial',
    propertyTypes: ['Office'],
    micromarkets: ['Marol'],
    rentMonthlyInrMax: 400000,
    ownerUserId: demandAgent,
    sourceType: 'Digi',
  };
  await h.deliver('demand.created.v1', d, { aggregateId: d.demandId });
  const da = await h.as(demandAgent, 'Demand agent');
  await da.post('/v1/calls', { subjectType: 'demand', subjectId: d.demandId, outcome: 'confirmed' });
  const q = await da.post(`/v1/demands/${d.demandId}/qualify`, {
    checklist: { decisionMakerReached: true, budgetConfirmed: true, timingConfirmed: true, agreesToWork: true },
  });
  expect(q.status).toBe(200);
  return d;
}
async function offer(o: Partial<EventDataMap['offer.created.v1']> = {}) {
  n++;
  const data: EventDataMap['offer.created.v1'] = {
    offerId: ids(),
    code: `INV-6${String(n).padStart(4, '0')}`,
    propertyId: ids(),
    dealType: 'Lease',
    segment: 'Commercial',
    propertyTypes: ['Office'],
    micromarket: 'Marol',
    rentMonthlyInrMin: 350000,
    areaSqftMin: 2000,
    areaBasis: 'Carpet',
    ownerUserId: supply,
    ...o,
  };
  await h.deliver('offer.created.v1', data, { aggregateId: data.offerId });
  h.content.offers.set(data.offerId, {
    id: data.offerId,
    code: data.code,
    propertyId: data.propertyId,
    dealType: data.dealType,
    segment: data.segment ?? null,
    propertyTypes: data.propertyTypes ?? [],
    bhkMin: null,
    areaSqftMin: data.areaSqftMin ?? null,
    areaBasis: 'Carpet',
    micromarket: data.micromarket ?? null,
    rentMonthlyInrMin: data.rentMonthlyInrMin ?? null,
    furnishing: 'Semi Furnished',
    // fields that must never reach a snapshot
    contactName: 'Owner Name',
    phones: ['+91 00000 12345'],
    unit: '1204',
    wing: 'B',
  });
  h.content.properties.set(data.propertyId, { id: data.propertyId, buildingName: 'Marol Business Park', unit: '1204' });
  h.content.photoUrls.set(data.propertyId, [
    { id: ids(), url: 'https://records.test/p1.jpg', caption: 'Reception' },
    { id: ids(), url: 'https://records.test/p2.jpg', caption: null },
  ]);
  return data;
}
async function confirmedMatch(demandId: string, offerIds: string[]) {
  const matchId = ids();
  await h.deliver('match.suggested.v1', { matchId, code: `MAT-${n}`, demandId, offerIds, score: 80, isBundle: offerIds.length > 1 }, { aggregateId: matchId });
  await h.deliver('match.confirmed.v1', { matchId, demandId, offerIds, confirmedBy: demandAgent }, { aggregateId: matchId });
  return matchId;
}
const openItems = (subjectId: string) =>
  h.rows<{ section: string; reason: string; priority: number; assignee_user_id: string }>(
    sql`select * from queue_items where tenant_id = ${h.tenantId} and (subject_id = ${subjectId} or demand_id = ${subjectId}) and status = 'open' order by created_at`,
  );
const events = async (type: Parameters<typeof h.outbox>[0], aggregateId: string) =>
  (await h.outbox(type)).filter((e) => e.aggregate_id === aggregateId).map((e) => e.payload);

describe('sourcing (JOU-06, AS-D2 / AS-S3)', () => {
  it('no inventory → needs_sourcing; SRQ → Sourcing with anonymous demand post; sourced-for supply is a top-priority Must call', async () => {
    const d = await qualifiedDemand();
    await h.deliver('demand.matching_completed.v1', { demandId: d.demandId, runId: ids(), matchCount: 0, bundleCount: 0 }, { aggregateId: d.demandId });
    expect((await openItems(d.demandId)).map((i) => i.section)).toEqual(['needs_sourcing']);

    const da = await h.as(demandAgent, 'Demand agent');
    const r = await da.post('/v1/sourcing-requests', {
      demandId: d.demandId,
      assigneeUserId: supply,
      dueDate: '2026-04-08',
      priority: 'High',
      postAnonymously: true,
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ code: expect.stringMatching(/^SRQ-\d{3}$/), status: 'Open', demandCode: d.code, postAnonymously: true });
    const srqId = r.body['id'] as string;
    expect((await openItems(d.demandId)).map((i) => i.section).sort()).toEqual(['in_sourcing', 'sourcing_requests', 'sourcing_requests_open']);
    expect((await da.get(`/v1/demands/${d.demandId}/journey`)).body).toMatchObject({ commercialStatus: 'Sourcing', openSourcingRequestIds: [srqId] });
    expect((await events('demand.sourcing_started.v1', d.demandId))[0]?.['data']).toEqual({ demandId: d.demandId, postAnonymously: true, sourcingRequestId: srqId });
    expect((await events('sourcing_request.created.v1', srqId))[0]?.['data']).toMatchObject({ demandId: d.demandId, assigneeUserId: supply, priority: 'High' });

    // Add supply ×3 for the demand (records creates offers with sourcedForDemandId)
    const sourced = [];
    for (let i = 0; i < 3; i++) sourced.push(await offer({ sourcedForDemandId: d.demandId }));
    const items = await openItems(sourced[0]?.offerId as string);
    expect(items).toMatchObject([{ section: 'must_call', reason: 'sourced_for', priority: 1 }]);
    const srq = await da.get(`/v1/sourcing-requests/${r.body['code']}`);
    expect(srq.body['offerIds']).toHaveLength(3);

    // assignee: status only
    const sup = await h.as(supply, 'Supply agent');
    expect((await sup.patch(`/v1/sourcing-requests/${srqId}`, { dueDate: '2026-04-20' })).body['code']).toBe('not-owner');
    expect((await sup.patch(`/v1/sourcing-requests/${srqId}`, { status: 'In progress' }, { 'if-match': '99' })).status).toBe(412);
    const inProgress = await sup.patch(`/v1/sourcing-requests/${srqId}`, { status: 'In progress' });
    expect(inProgress.body['status']).toBe('In progress');

    // a match on sourced supply moves the demand on (Sourcing is skipped once the CRM holds a match)
    await confirmedMatch(d.demandId, [sourced[1]?.offerId as string]);
    expect((await da.get(`/v1/demands/${d.demandId}/journey`)).body['commercialStatus']).toBe('Matched');
    expect((await openItems(d.demandId)).map((i) => i.section)).not.toContain('in_sourcing');
    const done = await sup.patch(`/v1/sourcing-requests/${srqId}`, { status: 'Fulfilled' });
    expect(done.body).toMatchObject({ status: 'Fulfilled' });
    expect((await events('sourcing_request.updated.v1', srqId)).map((e) => e['data']['status'])).toEqual(['in_progress', 'fulfilled']);
    expect((await sup.patch(`/v1/sourcing-requests/${srqId}`, { status: 'In progress' })).body['code']).toBe('invalid-transition');
    const list = await (await h.as(manager, 'Manager')).get(`/v1/sourcing-requests?demandId=${d.demandId}`);
    expect(list.body.items).toHaveLength(1);
  });

  it('SRQs need a qualified demand', async () => {
    const demandId = ids();
    await h.deliver('demand.created.v1', { demandId, code: 'DEM-NQ', dealTypes: ['Sale'], ownerUserId: demandAgent }, { aggregateId: demandId });
    const r = await (await h.as(demandAgent, 'Demand agent')).post('/v1/sourcing-requests', { demandId, assigneeUserId: supply, dueDate: '2026-04-10', priority: 'Normal' });
    expect(r.status).toBe(409);
    expect(r.body['code']).toBe('invalid-transition');
  });
});

describe('proposals (JOU-07)', () => {
  let demand: EventDataMap['demand.created.v1'];
  let matchA: string;
  let matchB: string;
  let offersA: string[];
  let proposalId: string;
  let code: string;

  it('options must be Confirmed matches of the demand (409 match-not-confirmed); the snapshot builds async', async () => {
    demand = await qualifiedDemand();
    const a = await offer();
    const b1 = await offer();
    const b2 = await offer();
    offersA = [a.offerId];
    matchA = await confirmedMatch(demand.demandId, [a.offerId]);
    matchB = await confirmedMatch(demand.demandId, [b1.offerId, b2.offerId]); // a bundle is one match
    const suggestedOnly = ids();
    await h.deliver('match.suggested.v1', { matchId: suggestedOnly, code: 'MAT-S', demandId: demand.demandId, offerIds: [b1.offerId], score: 50 }, { aggregateId: suggestedOnly });

    const da = await h.as(demandAgent, 'Demand agent');
    const bad = await da.post('/v1/proposals', { demandId: demand.demandId, options: [{ matchId: suggestedOnly }] });
    expect(bad.status).toBe(409);
    expect(bad.body['code']).toBe('match-not-confirmed');

    const r = await da.post('/v1/proposals', { demandId: demand.demandId, options: [{ matchId: matchA }, { matchId: matchB }], coverNote: 'Two options near Marol metro' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'Preparing', code: expect.stringMatching(/^PROP-\d{4}$/), pdf: { status: 'none' }, activeLink: null });
    proposalId = r.body['id'] as string;
    code = r.body['code'] as string;
    expect((await da.post(`/v1/proposals/${code}/share-link`, {})).body['code']).toBe('proposal-not-ready');

    // MahaRERA number absent in the pilot → "registration pending" (questionnaire A7)
    await buildSnapshot({ runner: h.runner, integrations: h.integrations }, { kind: 'build_snapshot', tenantId: h.tenantId, proposalId, correlationId: 't' }, 1);
    const [row] = await h.rows<{ status: string; snapshot: { agentRera: string; options: Record<string, unknown>[] } }>(sql`select status, snapshot from proposals where id = ${proposalId}`);
    expect(row?.status).toBe('Ready');
    expect(row?.snapshot.agentRera).toBe(RERA_PENDING);
    expect(row?.snapshot.options[1]).toMatchObject({ bundleOf: 2, buildingName: 'Marol Business Park', carpetAreaSqft: 2000 });
    const text = JSON.stringify(row?.snapshot);
    for (const leak of ['Owner Name', '12345', '1204', '"wing"', '"unit"']) expect(text).not.toContain(leak);
    expect(h.storage.files.has(`${h.tenantId}/${proposalId}/1-1.jpg`)).toBe(true);
  });

  it('PDF is generated off the request path and served as a 5-minute signed URL', async () => {
    const da = await h.as(demandAgent, 'Demand agent');
    const r = await da.post(`/v1/proposals/${proposalId}/pdf`);
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ status: 'queued' });
    expect((await da.get(`/v1/proposals/${proposalId}/pdf`)).body).toEqual({ status: 'queued', url: null, expiresAt: null });
    h.content.rera = 'A51900012345';
    await renderPdf({ runner: h.runner, integrations: h.integrations }, { kind: 'render_pdf', tenantId: h.tenantId, proposalId, correlationId: 't' }, 1);
    const pdf = await da.get(`/v1/proposals/${code}/pdf`);
    expect(pdf.body).toMatchObject({ status: 'ready', url: expect.stringContaining(`${proposalId}/${code}.pdf?exp=300`) });
    expect(h.content.rendered.at(-1)?.photoUrls[1]).toHaveLength(2);
  });

  it('share link: 14 days max, token shown once, public page with no-store/noindex; revoke → 410; unknown → 404', async () => {
    const da = await h.as(demandAgent, 'Demand agent');
    const link = await da.post(`/v1/proposals/${proposalId}/share-link`, { expiresInDays: 14 });
    expect(link.status).toBe(201);
    const token = String(link.body['url']).split('/p/')[1] as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [stored] = await h.rows<{ token_hash: Buffer }>(sql`select token_hash from proposal_links where proposal_id = ${proposalId}`);
    expect(stored?.token_hash.toString('hex')).not.toContain(Buffer.from(token).toString('hex'));

    const page = await h.app.request(`/p/${token}`, { headers: { accept: 'application/json', 'x-forwarded-for': '203.0.113.9' } });
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('x-robots-tag')).toBe('noindex');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    const body = (await page.json()) as { agentRera: string; options: { photos: { url: string }[]; title: string }[]; coverNote: string };
    expect(body.agentRera).toBe(RERA_PENDING); // frozen in the snapshot
    expect(body.options[0]?.photos[0]?.url).toContain('?exp=600');
    expect(body.coverNote).toBe('Two options near Marol metro');
    const html = await h.app.request(`/p/${token}`, { headers: { accept: 'text/html' } });
    expect(await html.text()).toContain('Marol Business Park');
    const view = await da.get(`/v1/proposals/${proposalId}`);
    expect(view.body['activeLink']).toMatchObject({ opens: 2, urlHint: `…/p/${token.slice(0, 6)}…` });
    const [notification] = await h.rows<{ kind: string }>(sql`select kind from notifications where tenant_id = ${h.tenantId} and user_id = ${demandAgent} and kind = 'proposal_opened'`);
    expect(notification).toBeDefined();
    const [open] = await h.rows<{ ip_hash: Buffer | null }>(sql`select ip_hash from proposal_link_opens where tenant_id = ${h.tenantId} order by opened_at limit 1`);
    expect(open?.ip_hash?.length).toBe(32);

    expect((await h.app.request(`/p/${'x'.repeat(43)}`)).status).toBe(404);
    expect((await da.del(`/v1/proposals/${proposalId}/share-link`)).status).toBe(204);
    const gone = await h.app.request(`/p/${token}`);
    expect(gone.status).toBe(410);
    expect(((await gone.json()) as { code: string }).code).toBe('link-expired');
    expect((await h.outbox('audit.recorded.v1')).map((e) => e.payload.data['action'])).toEqual(
      expect.arrayContaining(['proposal.share_link_created', 'proposal.share_link_revoked']),
    );
  });

  it('mark sent → offers In proposal, demand Proposal shared, proposals_out; feedback per option closes it', async () => {
    const da = await h.as(demandAgent, 'Demand agent');
    const sent = await da.post(`/v1/proposals/${code}/mark-sent`, { channel: 'WhatsApp' });
    expect(sent.status).toBe(200);
    expect(sent.body['status']).toBe('Sent');
    expect((await da.post(`/v1/proposals/${code}/mark-sent`, { channel: 'Email' })).body['code']).toBe('proposal-already-sent');
    expect((await da.patch(`/v1/proposals/${code}`, { coverNote: 'x' })).body['code']).toBe('proposal-already-sent');
    expect((await da.get(`/v1/offers/${offersA[0]}/journey`)).body['commercialStatus']).toBe('In proposal');
    expect((await da.get(`/v1/demands/${demand.demandId}/journey`)).body['commercialStatus']).toBe('Proposal shared');
    expect((await events('proposal.sent.v1', proposalId))[0]?.['data']).toEqual({ proposalId, demandId: demand.demandId, matchIds: [matchA, matchB] });
    expect((await openItems(proposalId)).map((i) => i.section)).toEqual(['proposals_out']);

    await da.post(`/v1/proposals/${code}/feedback`, { options: [{ position: 1, feedback: 'visit_requested' }] });
    expect((await openItems(proposalId)).map((i) => i.section)).toEqual(['proposals_out']);
    const fb = await da.post(`/v1/proposals/${code}/feedback`, { options: [{ position: 2, feedback: 'rejected', note: 'too far' }] });
    expect(fb.body['options']).toMatchObject([{ feedback: 'visit_requested' }, { feedback: 'rejected', feedbackNote: 'too far' }]);
    expect(await openItems(proposalId)).toEqual([]);
    const fbEvents = await events('proposal.feedback_recorded.v1', proposalId);
    expect(fbEvents.at(-1)?.['data']).toEqual({ proposalId, demandId: demand.demandId, feedback: [{ matchId: matchB, verdict: 'rejected' }] });
    expect((await da.get(`/v1/proposals?demandId=${demand.demandId}`)).body.items).toHaveLength(1);
    for (const e of await h.outbox()) expect(eventProblems(e.payload)).toBeNull();
  });

  it('records unavailable: retried, then Failed after 3 attempts with a notification', async () => {
    const d = await qualifiedDemand();
    const o = await offer();
    const m = await confirmedMatch(d.demandId, [o.offerId]);
    const da = await h.as(demandAgent, 'Demand agent');
    const p = await da.post('/v1/proposals', { demandId: d.demandId, options: [{ matchId: m }] });
    const msg = { kind: 'build_snapshot' as const, tenantId: h.tenantId, proposalId: p.body['id'] as string, correlationId: 't' };
    h.content.failing = true;
    await expect(buildSnapshot({ runner: h.runner, integrations: h.integrations }, msg, 1)).rejects.toThrow();
    await buildSnapshot({ runner: h.runner, integrations: h.integrations }, msg, 3);
    h.content.failing = false;
    expect((await da.get(`/v1/proposals/${p.body['id']}`)).body['status']).toBe('Failed');
    // CR-012: its own notification kind (was the proposal_opened stand-in)
    const bell = await da.get('/v1/notifications');
    const failed = bell.body.items?.filter((i) => i['subjectId'] === p.body['id']);
    expect(failed).toMatchObject([{ kind: 'proposal_failed', subjectType: 'proposal', title: `${p.body['code']}: content could not be prepared` }]);
  });

  it('maybe feedback (CR-012): stored, shown and emitted as a neutral verdict; the proposal still waits for the rest', async () => {
    const d = await qualifiedDemand();
    const [o1, o2] = [await offer(), await offer()];
    const m1 = await confirmedMatch(d.demandId, [o1.offerId]);
    const m2 = await confirmedMatch(d.demandId, [o2.offerId]);
    const da = await h.as(demandAgent, 'Demand agent');
    const p = await da.post('/v1/proposals', { demandId: d.demandId, options: [{ matchId: m1 }, { matchId: m2 }] });
    const id = p.body['id'] as string;
    await buildSnapshot({ runner: h.runner, integrations: h.integrations }, { kind: 'build_snapshot', tenantId: h.tenantId, proposalId: id, correlationId: 't' }, 1);
    expect((await da.post(`/v1/proposals/${id}/mark-sent`, { channel: 'Email' })).status).toBe(200);
    const journeyBefore = (await da.get(`/v1/demands/${d.demandId}/journey`)).body;

    const fb = await da.post(`/v1/proposals/${id}/feedback`, { options: [{ position: 1, feedback: 'maybe', note: 'will think' }] });
    expect(fb.status).toBe(200);
    expect(fb.body['options']).toMatchObject([{ position: 1, feedback: 'maybe', feedbackNote: 'will think' }, { position: 2, feedback: null }]);
    const [stored] = await h.rows<{ feedback: string }>(sql`select feedback from proposal_options where proposal_id = ${id} and position = 1`);
    expect(stored?.feedback).toBe('maybe');
    expect((await da.get(`/v1/proposals/${id}`)).body['options'][0]).toMatchObject({ feedback: 'maybe' });
    const emitted = (await events('proposal.feedback_recorded.v1', id)).at(-1);
    expect(emitted?.['data']).toEqual({ proposalId: id, demandId: d.demandId, feedback: [{ matchId: m1, verdict: 'maybe' }] });
    expect(eventProblems(emitted)).toBeNull();

    // neutral: no commercial change, and the follow-up stays open until every option has a verdict
    const journeyAfter = (await da.get(`/v1/demands/${d.demandId}/journey`)).body;
    expect(journeyAfter['commercialStatus']).toBe(journeyBefore['commercialStatus']);
    expect((await da.get(`/v1/offers/${o1.offerId}/journey`)).body['commercialStatus']).toBe('In proposal');
    expect((await openItems(id)).map((i) => i.section)).toEqual(['proposals_out']);
    await da.post(`/v1/proposals/${id}/feedback`, { options: [{ position: 2, feedback: 'maybe' }] });
    expect(await openItems(id)).toEqual([]);
  });
});
