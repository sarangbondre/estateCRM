// ENG-06: nightly re-score, micromarket refresh, projection reconcile + retention, and proposal feedback (M6).
import { randomUUID } from 'node:crypto';
import { sql } from '@11e/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jobDeps, runJob } from '../../src/adapters/jobs.js';
import {
  FULL_RESCORE_ALL,
  MICROMARKET_REFRESH,
  runFullRescore,
  runMicromarketRefresh,
  runReconcile,
} from '../../src/application/jobs.js';
import { harness } from '../helpers.js';
import type { Harness } from '../helpers.js';
import {
  deliver,
  envelopeFor,
  matchesOf,
  officeDemandFacts,
  officeFacts,
  settle,
} from '../pipeline-helpers.js';
import { MM, SOURCE } from '../unit/fixtures.js';

let h: Harness;
beforeAll(async () => {
  h = await harness({ now: new Date('2026-10-01T06:30:00Z') }); // Thursday in IST
  await h.tx((s) => s.hierarchy.replace(h.tenant, SOURCE, 1));
  h.micromarkets.nodes = [...SOURCE];
});
afterAll(() => h.close());

const pending = async () =>
  (
    await h.tx((_s, trx) =>
      sql<{
        subject_id: string;
        reasons: string[];
      }>`select subject_id, reasons from ${sql.table('rescore_pending')} where tenant_id = ${h.tenant}`.execute(
        trx,
      ),
    )
  ).rows;
async function newDemand(over: Record<string, unknown> = {}) {
  const id = randomUUID();
  await deliver(h, envelopeFor(h, 'demand.created.v1', id, 1, officeDemandFacts(id, over)));
  return id;
}
async function newOffer(over: Record<string, unknown> = {}) {
  const id = randomUUID();
  await deliver(h, envelopeFor(h, 'offer.created.v1', id, 1, officeFacts(id, over)));
  return id;
}

describe('full-rescore', () => {
  it('nightly: only time-sensitive live demands (move_in_by ≤ today + 90); Sunday: every live demand', async () => {
    const soon = await newDemand({ moveInBy: '2026-11-15' });
    const later = await newDemand({ moveInBy: '2027-06-01' });
    const open = await newDemand();
    await settle(h);
    const d = jobDeps(h.deps);
    const r = await runFullRescore(d, h.tenant);
    expect(r).toMatchObject({ remaining: 0 });
    expect((await pending()).map((p) => p.subject_id)).toEqual([soon]);
    await settle(h);
    h.now.value = new Date('2026-10-04T06:30:00Z'); // Sunday
    await runFullRescore(d, h.tenant);
    expect((await pending()).map((p) => p.subject_id).sort()).toEqual([soon, later, open].sort());
    await settle(h);
    // same day again: already done
    await runFullRescore(d, h.tenant);
    expect(await pending()).toEqual([]);
    h.now.value = new Date('2026-10-01T06:30:00Z');
  });

  it('after a weights change every live demand is re-scored once per weights version', async () => {
    await settle(h);
    const put = await h.app.request('/v1/weights', {
      method: 'PUT',
      headers: { ...(await h.staff('Admin')), 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 0,
        factors: { micromarket: 0.3, price: 0.25, area: 0.2, bhk: 0.1, timing: 0.1, furnishing: 0.05 },
        tuning: {},
      }),
    });
    expect(put.status).toBe(200);
    const d = jobDeps(h.deps);
    await runJob(d, FULL_RESCORE_ALL, h.tenant);
    const dirty = await pending();
    expect(dirty.length).toBeGreaterThanOrEqual(3);
    expect(dirty.every((p) => p.reasons[0]?.startsWith(`${FULL_RESCORE_ALL}@w1`))).toBe(true);
    await settle(h);
  });

  it('continues past the budget: unfinished tenants report remaining work', async () => {
    const r = await runFullRescore(jobDeps(h.deps, 0), h.tenant);
    expect(r.remaining).toBe(1);
  });

  it('the scheduler endpoint returns the batch job result shape (projection-reconcile: light for every tenant)', async () => {
    h.subjectStates.items = [];
    const r = await h.app.request('/internal/v1/jobs/projection-reconcile', {
      method: 'POST',
      headers: h.cron,
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      job: 'projection-reconcile',
      done: expect.any(Boolean),
      processed: expect.any(Number),
    });
    // a second call while nothing is running is accepted again (single-flight lease released)
    expect(
      (await h.app.request('/internal/v1/jobs/projection-reconcile', { method: 'POST', headers: h.cron }))
        .status,
    ).toBe(200);
  });
});

describe('micromarket-refresh (R-13)', () => {
  it('reloads the hierarchy, recomputes paths, marks changed offers dirty and queues a full re-score', async () => {
    const o = await newOffer({ micromarket: 'Andheri East', locality: 'Andheri Station' }); // unknown locality today
    expect((await h.tx((s) => s.mx.getOffer(h.tenant, o)))?.mmPath).toEqual([MM.andheriEast]);
    await settle(h);
    h.micromarkets.nodes = [
      ...SOURCE,
      {
        id: 'loc-andheri-station',
        parentId: MM.andheriEast,
        level: 'locality',
        name: 'Andheri Station',
        aliases: [],
        adjacentIds: [],
        inLaunchArea: true,
      },
    ];
    await deliver(h, envelopeFor(h, 'micromarkets.updated.v1', randomUUID(), 2, { version: 2 }));
    const r = await runMicromarketRefresh(jobDeps(h.deps), h.tenant);
    expect(r.remaining).toBe(0);
    expect((await h.tx((s) => s.mx.getOffer(h.tenant, o)))?.mmPath).toEqual([
      'loc-andheri-station',
      MM.andheriEast,
    ]);
    expect((await pending()).map((p) => p.subject_id)).toContain(o);
    const state = await h.tx((s) => s.jobs.get(MICROMARKET_REFRESH, '2026-10-01', h.tenant));
    expect(state).toMatchObject({ done: true, cursor: 'done' });
    await settle(h);
  });

  it('an unchanged tree finishes at once; records unreachable fails without touching the copy', async () => {
    await deliver(h, envelopeFor(h, 'micromarkets.updated.v1', randomUUID(), 3, { version: 3 }));
    const r = await runMicromarketRefresh(jobDeps(h.deps), h.tenant);
    expect(r).toMatchObject({ remaining: 0 });
    expect(await h.tx((s) => s.jobs.get(MICROMARKET_REFRESH, '2026-10-01', h.tenant))).toMatchObject({
      cursor: 'unchanged',
    });
    await deliver(h, envelopeFor(h, 'micromarkets.updated.v1', randomUUID(), 4, { version: 4 }));
    const broken = {
      ...jobDeps(h.deps),
      micromarkets: { fetchAll: () => Promise.reject(new Error('records down')) },
    };
    await expect(runMicromarketRefresh(broken, h.tenant)).rejects.toThrow('records down');
    expect((await h.tx((s) => s.hierarchy.load(h.tenant))).node('loc-andheri-station')).toBeDefined();
  });
});

describe('projection-reconcile', () => {
  it("repairs journeys axes from subject states (with the events' match effects) and applies retention", async () => {
    const d = await newDemand({ micromarkets: ['Powai'], localities: [] });
    const o = await newOffer({ micromarket: 'Powai', locality: null });
    const d2 = await newDemand({ micromarkets: ['Powai'], localities: [] });
    await settle(h);
    expect((await matchesOf(h, d)).find((m) => m.offer_ids.includes(o))?.status).toBe('Suggested');
    h.subjectStates.items = [
      {
        subjectType: 'offer',
        subjectId: o,
        commercialStatus: 'Closed',
        exit: null,
        lifeStage: 'Fresh',
        version: 9,
      },
      {
        subjectType: 'offer',
        subjectId: randomUUID(),
        commercialStatus: 'Available',
        exit: null,
        lifeStage: 'Fresh',
        version: 1,
      },
      {
        subjectType: 'demand',
        subjectId: d2,
        commercialStatus: 'New',
        exit: 'Dormant',
        lifeStage: 'Paused',
        version: 5,
      },
    ];
    // an old closed match beyond the 24-month window
    const old = await h.tx(async (s) => {
      const [m] = await s.matches.listForDemand(h.tenant, d, 10);
      return s.matches.update({
        ...(m as NonNullable<typeof m>),
        status: 'Rejected',
        rejectedReason: 'other',
      });
    });
    await h.tx((_s, trx) =>
      sql`update ${sql.table('matches')} set updated_at = now() - interval '3 years' where id = ${old.id}`.execute(
        trx,
      ),
    );
    // the scheduler test above already ran today's reconcile for every tenant: start a fresh run
    await h.tx((s) =>
      s.jobs.save('projection-reconcile', '2026-10-01', h.tenant, {
        cursor: null,
        processed: 0,
        done: false,
      }),
    );
    const r = await runReconcile(jobDeps(h.deps), h.tenant);
    expect(r.remaining).toBe(0);
    expect(await h.tx((s) => s.mx.getOffer(h.tenant, o))).toMatchObject({
      commercialStatus: 'Closed',
      commercialVersion: 9,
    });
    expect(await h.tx((s) => s.mx.getDemand(h.tenant, d2))).toMatchObject({
      exitType: 'Dormant',
      lifeStage: 'Paused',
    });
    expect((await matchesOf(h, d2)).find((m) => m.offer_ids.includes(o))).toMatchObject({ status: 'Closed' });
    expect(await h.tx((s) => s.matches.get(h.tenant, old.id))).toBeNull();
  });
});

describe('proposal feedback (M6)', () => {
  it('records one feedback row per verdict with the score and weights version; "maybe" is neutral (no row, CR-012); the match stays as it is', async () => {
    const d = await newDemand({
      micromarkets: ['Andheri East'],
      localities: ['Chakala'],
      areaSqftMin: 100,
      areaSqftMax: 200,
    });
    await newOffer({ locality: 'Chakala', areaSqftMin: 150, areaSqftMax: 150 });
    await newOffer({ locality: 'Chakala', areaSqftMin: 160, areaSqftMax: 160 });
    await settle(h);
    const [a, b] = await matchesOf(h, d);
    await deliver(
      h,
      envelopeFor(
        h,
        'proposal.feedback_recorded.v1',
        randomUUID(),
        1,
        {
          proposalId: randomUUID(),
          demandId: d,
          feedback: [
            { matchId: a?.id as string, verdict: 'liked' },
            { matchId: b?.id as string, verdict: 'rejected' },
            { matchId: randomUUID(), verdict: 'visit_requested' },
            // CR-012: "maybe" is neutral — accepted, but nothing is learnt from it
            { matchId: a?.id as string, verdict: 'maybe' },
            { matchId: b?.id as string, verdict: 'maybe' },
          ],
        },
        'journeys',
      ),
    );
    const rows = await h.tx((_s, trx) =>
      sql<{ match_id: string; action: string; source: string; score: number; weights_version: number }>`
        select match_id, action, source, score, weights_version from ${sql.table('feedback')}
        where tenant_id = ${h.tenant} and demand_id = ${d} order by action`.execute(trx),
    );
    expect(rows.rows).toEqual([
      { match_id: a?.id, action: 'client_liked', source: 'proposal', score: a?.score, weights_version: 1 },
      { match_id: b?.id, action: 'client_rejected', source: 'proposal', score: b?.score, weights_version: 1 },
    ]);
    expect((await matchesOf(h, d)).find((m) => m.id === b?.id)?.status).toBe('Suggested');
  });
});
