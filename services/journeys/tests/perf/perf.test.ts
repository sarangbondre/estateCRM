// Local performance measurements (JOU-03 "My queue p95 ≤ 1 s", JOU-11 "life-curve job on 5M subjects < 2 h").
// Opt-in: PERF_SUBJECTS=1000000 pnpm --filter @11e/journeys exec vitest run tests/perf
// Seeds a synthetic tenant with SQL (offer projections, journeys, curves, queue items), measures, then deletes it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@11e/db';
import pg from 'pg';
import { ensureMigrated, env, harness, ids } from '../helpers.js';

const SUBJECTS = Number(process.env['PERF_SUBJECTS'] ?? 0);
const DUE_SHARE = Number(process.env['PERF_DUE_SHARE'] ?? 0.03);
const run = SUBJECTS > 0 ? describe : describe.skip;

const h = harness();
const agent = ids();
const report: Record<string, unknown> = { subjects: SUBJECTS, dueShare: DUE_SHARE };

const p = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(q * xs.length) - 1)] ?? 0;

async function seed() {
  const t = h.tenantId;
  const started = Date.now();
  const chunk = 250_000;
  for (let from = 1; from <= SUBJECTS; from += chunk) {
    const to = Math.min(SUBJECTS, from + chunk - 1);
    // ~4% of offers belong to the measured agent (≈ 40k items at 1M); the rest spread over 25 other agents.
    await sql`insert into offer_view (id, tenant_id, code, property_id, deal_type, market, segment, property_types, micromarket,
        sale_price_inr_min, rent_monthly_inr_min, area_sqft_min, record_stage, source_type, owner_user_id, captured_on, last_seen_on, facts_version)
      select md5(${t}::text || 'o' || g)::uuid, ${t}, 'INV-' || g, md5('p' || g)::uuid,
        (array['Sale','Lease','Sale','Lease','Pagdi'])[1 + g % 5], (array['Primary','Secondary'])[1 + g % 2],
        (array['Residential','Commercial','Residential','Industrial'])[1 + g % 4], array['Apartment'],
        'MM-' || (g % 400), 10000000 + (g % 97) * 100000, 50000 + (g % 89) * 1000, 500 + g % 2000, 'Enriched', 'Channel',
        case when g % 25 = 0 then ${agent}::uuid else md5('u' || (g % 25))::uuid end,
        date '2026-01-01' - (g % 300), date '2026-01-01' - (g % 60), 1
      from generate_series(${from}::int, ${to}::int) g`.execute(h.db);
    await sql`insert into offer_journey (id, tenant_id, commercial_status, commercial_changed_at)
      select md5(${t}::text || 'o' || g)::uuid, ${t}, 'Available', now() from generate_series(${from}::int, ${to}::int) g`.execute(h.db);
    // DUE_SHARE of the curves can change today; the rest have a future next_change_on (or none).
    await sql`insert into life_curve (id, tenant_id, subject_type, subject_id, category_key, stage, day_count, clock_floor, next_change_on)
      select md5(${t}::text || 'c' || g)::uuid, ${t}, 'offer', md5(${t}::text || 'o' || g)::uuid,
        'offer.sale_secondary', 'Fresh', 10, date '2026-01-01' - 46,
        case when (g % 1000) < ${Math.round(DUE_SHARE * 1000)} then date '2026-01-01' else date '2026-01-01' + 1 + g % 90 end
      from generate_series(${from}::int, ${to}::int) g`.execute(h.db);
    await sql`insert into queue_items (id, tenant_id, team, section, subject_type, subject_id, subject_code, offer_id, assignee_user_id,
        reason, priority, due_at, rank_score, rank_factors)
      select md5(${t}::text || 'q' || g)::uuid, ${t}, 'supply', case when g % 50 = 0 then 'must_call' else 'should_call' end, 'offer',
        md5(${t}::text || 'o' || g)::uuid, 'INV-' || g, md5(${t}::text || 'o' || g)::uuid,
        case when g % 25 = 0 then ${agent}::uuid else md5('u' || (g % 25))::uuid end,
        case when g % 50 = 0 then 'enquiry' else 'new_capture' end, 0,
        case when g % 50 = 0 then now() + ((g % 48) || ' hours')::interval else null end,
        case when g % 50 = 0 then null else (g % 9000) / 100.0 end,
        '{"freshness":1,"demandGap":0.2,"sourceQuality":0.5,"priceBand":0.5,"boost":0}'::jsonb
      from generate_series(${from}::int, ${to}::int) g`.execute(h.db);
  }
  await sql`insert into queue_counters (id, tenant_id, user_id, section, open_count, changed_at)
    select gen_random_uuid(), ${t}, assignee_user_id, section, count(*), now() from queue_items where tenant_id = ${t}
    group by assignee_user_id, section`.execute(h.db);
  // Planner statistics as autovacuum would have them (ANALYZE needs the owner role).
  const owner = new pg.Client({ connectionString: env.MIGRATOR_DATABASE_URL });
  await owner.connect();
  await owner.query('analyze journeys.offer_view; analyze journeys.offer_journey; analyze journeys.life_curve; analyze journeys.queue_items; analyze journeys.queue_counters');
  await owner.end();
  report['seedSeconds'] = Math.round((Date.now() - started) / 1000);
}

async function cleanup(t = h.tenantId) {
  for (const table of ['queue_items', 'queue_counters', 'life_curve', 'offer_journey', 'offer_view', 'outbox', 'aggregate_versions', 'job_runs', 'notifications']) {
    await sql`delete from ${sql.ref(table)} where tenant_id = ${t}`.execute(h.db);
  }
}

run('performance (local)', () => {
  beforeAll(async () => {
    await ensureMigrated();
    await seed();
  }, 3_600_000);
  afterAll(async () => {
    if (process.env['PERF_KEEP']) report['keptTenant'] = h.tenantId;
    else await cleanup();
    report['agent'] = agent;
    process.stdout.write(`\nPERF REPORT ${JSON.stringify(report)}\n`);
    await h.close();
  }, 3_600_000);

  it('My queue: summary and section pages, p95 ≤ 1 s (NFR-8)', async () => {
    h.clock.day('2026-01-01');
    const me = await h.as(agent, 'Supply agent');
    const timings: Record<string, number[]> = { summary: [], must_call: [], should_call: [], should_call_page2: [], planned: [] };
    for (let i = 0; i < 60; i++) {
      let t0 = performance.now();
      expect((await me.get('/v1/queues/me')).status).toBe(200);
      timings['summary']?.push(performance.now() - t0);
      t0 = performance.now();
      await me.get('/v1/queues/me/sections/must_call?limit=50');
      timings['must_call']?.push(performance.now() - t0);
      t0 = performance.now();
      const page = await me.get('/v1/queues/me/sections/should_call?limit=50');
      timings['should_call']?.push(performance.now() - t0);
      t0 = performance.now();
      await me.get(`/v1/queues/me/sections/should_call?limit=50&cursor=${page.body.nextCursor}`);
      timings['should_call_page2']?.push(performance.now() - t0);
      t0 = performance.now();
      await me.get('/v1/queues/me/sections/should_call?plannedOnly=true');
      timings['planned']?.push(performance.now() - t0);
    }
    const q = Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, { p50: Math.round(p(v, 0.5)), p95: Math.round(p(v, 0.95)) }]));
    const items = await h.rows<{ n: number }>(sql`select count(*)::int as n from queue_items where tenant_id = ${h.tenantId} and assignee_user_id = ${agent}`);
    report['myQueueMs'] = q;
    report['agentOpenItems'] = items[0]?.n;
    for (const v of Object.values(q)) expect(v.p95).toBeLessThan(1000);
  }, 600_000);

  it('life-curve-nightly touches only due rows; rows/second extrapolated to 5M subjects', async () => {
    h.clock.day('2026-01-01');
    const due = await h.rows<{ n: number }>(sql`select count(*)::int as n from life_curve where tenant_id = ${h.tenantId}
      and not frozen and next_change_on <= '2026-01-01'`);
    const started = Date.now();
    const r = await h.runJob('life-curve-nightly', 50_000);
    const seconds = (Date.now() - started) / 1000;
    const perSecond = r.processed / seconds;
    const dueAt5M = 5_000_000 * DUE_SHARE;
    report['nightly'] = {
      dueRows: due[0]?.n,
      processed: r.processed,
      seconds: Math.round(seconds),
      rowsPerSecond: Math.round(perSecond),
      extrapolated5M: { dueRows: dueAt5M, minutes: Math.round(dueAt5M / perSecond / 60) },
    };
    expect(r.processed).toBe(due[0]?.n);
    expect(dueAt5M / perSecond).toBeLessThan(2 * 3600);
  }, 3_600_000);
});
