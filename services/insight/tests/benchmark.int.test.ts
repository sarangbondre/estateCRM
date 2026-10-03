// INS-06: the M7 chat benchmark (PRD Appendix A, 13 questions; target ≥ 85% correct). Each question goes through the
// real chat pipeline (POST /v1/chat/conversations/{id}/messages): redaction → planner → validation → execution →
// template answer. A case is correct when the plan the service ran matches the expected plan (plan id, every expected
// filter, the period preset, export flag) AND its rows give the seeded answer.
//   - "model" run: the intercepting HF mock returning the recorded replies (B5: no real calls, no token); every
//     outbound request — including PII-laden variants of the questions — is asserted PII-free by the mock.
//   - "fallback" run: no model (credits exhausted / unavailable) — the keyword parser alone.
//   - INSIGHT_BENCHMARK_LIVE=1 with HF_TOKEN (optionally HF_MODEL / HF_PROVIDER / HF_BASE_URL): the real model, for choosing it
//     (A-I6). Skipped otherwise; never in CI.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHfClient, createHfPlanner } from '../src/adapters/hfPlanner.js';
import type { Planner } from '../src/application/ports.js';
import { APPENDIX_A } from './appendixA.js';
import type { BenchmarkCase } from './appendixA.js';
import { HfMock, TEST_PII, parseSse } from './hfMock.js';
import { TestClock, harness } from './helpers.js';
import type { Harness } from './helpers.js';
import { NOW, seedBenchmark } from './seed.js';
import type { Seeded } from './seed.js';

const M7_TARGET = 0.85;
const clock = new TestClock(NOW);
const mock = new HfMock().recordAppendixA();
const live = process.env['INSIGHT_BENCHMARK_LIVE'] === '1' && !!process.env['HF_TOKEN'];

interface CaseResult {
  id: string;
  planOk: boolean;
  answerOk: boolean;
  fallbackUsed: boolean;
  firstTokenMs: number;
  totalMs: number;
  planId: string | null;
}

const lower = (v: unknown): unknown => (typeof v === 'string' ? v.toLowerCase() : Array.isArray(v) ? v.map(lower) : v);

function planMatches(c: BenchmarkCase, ran: Record<string, unknown> | undefined, exportable: boolean): boolean {
  if (!ran || ran['planId'] !== c.expected.planId) return false;
  const filters = (ran['filters'] as { field: string; op: string; value: unknown }[] | undefined) ?? [];
  for (const f of c.expected.filters ?? []) {
    const got = filters.find((x) => x.field === f.field);
    if (!got || got.op !== f.op) return false;
    const want = f.field === 'follow_up_date' && f.value === 'today' ? got.value : f.value; // 'today' resolves to the IST date
    if (JSON.stringify(lower(got.value)) !== JSON.stringify(lower(want))) return false;
  }
  const period = ran['period'] as { preset?: string } | undefined;
  if (c.expected.period?.preset && period?.preset !== c.expected.period.preset) return false;
  if (c.expected.exportRequested && !exportable) return false;
  return true;
}

async function runBenchmark(h: Harness, seeded: Seeded & { tenantId: string }, label: string): Promise<CaseResult[]> {
  const api = await h.as(seeded.me, 'Manager', seeded.tenantId);
  const conv = (await api.post('/v1/chat/conversations', {})).body['conversationId'] as string;
  const results: CaseResult[] = [];
  for (const c of APPENDIX_A) {
    const r = await api.post(`/v1/chat/conversations/${conv}/messages`, { text: c.question });
    const frames = parseSse(r.text);
    const how = frames.find((f) => f.event === 'plan')?.data['howIGotThis'] as Record<string, unknown> | undefined;
    const done = frames.find((f) => f.event === 'done')?.data ?? {};
    const cards = frames.filter((f) => f.event === 'card').map((f) => f.data['card'] as Record<string, unknown>);
    const table = cards.find((x) => x['kind'] === 'table');
    const ran = how?.['plan'] as Record<string, unknown> | undefined;
    if (!ran) process.stdout.write(`  ${c.id} stream without a plan: ${r.status} ${r.text.slice(0, 300)}\n`);
    const planOk = planMatches(c, ran, table?.['exportable'] === true);
    let answerOk = false;
    if (ran) {
      // the full answer set of the plan that ran (the chat shows 25 rows inline)
      const q = await api.post('/v1/queries', { plan: ran, ...(String(ran['planId']).startsWith('list_') ? { limit: 100 } : {}) });
      answerOk = q.status === 200 && c.check(q.body['rows'] as Record<string, unknown>[], seeded, q.body['howIGotThis']?.rowCount as number);
    }
    const timings = (done['timings'] ?? {}) as Record<string, number>;
    results.push({
      id: c.id,
      planOk,
      answerOk,
      fallbackUsed: done['fallbackUsed'] === true,
      firstTokenMs: timings['firstTokenMs'] ?? 0,
      totalMs: timings['totalMs'] ?? 0,
      planId: (ran?.['planId'] as string | undefined) ?? null,
    });
  }
  const correct = results.filter((x) => x.planOk && x.answerOk).length;
  const worstFirst = Math.max(...results.map((x) => x.firstTokenMs));
  process.stdout.write(
    `\nM7 benchmark (${label}): ${correct}/${results.length} correct = ${Math.round((correct / results.length) * 1000) / 10}% (target ≥ ${M7_TARGET * 100}%); slowest first token ${worstFirst} ms\n` +
      results.map((x) => `  ${x.id.padEnd(4)} ${x.planOk && x.answerOk ? 'ok  ' : 'MISS'} plan=${x.planId ?? '-'} planOk=${x.planOk} answerOk=${x.answerOk} fallback=${x.fallbackUsed}`).join('\n') +
      '\n',
  );
  return results;
}

let seeded: Seeded & { tenantId: string };
const withModel = harness({ clock, planner: createHfPlanner({ model: 'Qwen/Qwen2.5-7B-Instruct', client: mock }) });
const withoutModel = harness({ clock });
afterAll(async () => {
  await withModel.close();
  await withoutModel.close();
});
beforeAll(async () => {
  seeded = { ...(await seedBenchmark(withModel)), tenantId: withModel.tenantId };
});

describe('M7 chat benchmark (PRD Appendix A)', () => {
  it('model run (recorded replies through the intercepting mock) scores ≥ 85%', async () => {
    const results = await runBenchmark(withModel, seeded, 'model: recorded Hugging Face replies');
    const score = results.filter((x) => x.planOk && x.answerOk).length / results.length;
    expect(score).toBeGreaterThanOrEqual(M7_TARGET);
    expect(results.every((x) => !x.fallbackUsed)).toBe(true);
    expect(results.every((x) => x.firstTokenMs < 3000)).toBe(true); // NFR-7 first token ≤ 3 s
    expect(mock.requests.length).toBeGreaterThanOrEqual(13);
  });

  it('fallback run (no model, keyword parser only) scores ≥ 85%', async () => {
    const results = await runBenchmark(withoutModel, seeded, 'fallback: keyword parser');
    const score = results.filter((x) => x.planOk && x.answerOk).length / results.length;
    expect(results.every((x) => x.fallbackUsed)).toBe(true);
    expect(score).toBeGreaterThanOrEqual(M7_TARGET);
  });

  it('outbound model requests stay PII-free for PII-laden questions', async () => {
    const api = await withModel.as(seeded.me, 'Manager', seeded.tenantId);
    const conv = (await api.post('/v1/chat/conversations', {})).body['conversationId'] as string;
    const before = mock.requests.length;
    for (const c of APPENDIX_A) {
      const text = `Client Sanjay Testkar (90000 01234, sanjay.test@example.com, Flat 1203) asks: ${c.question}`;
      const r = await api.post(`/v1/chat/conversations/${conv}/messages`, { text });
      expect(r.status).toBe(200);
      expect(parseSse(r.text).some((f) => f.event === 'error')).toBe(false); // the mock throws on any PII → error frame
    }
    const sent = JSON.stringify(mock.requests.slice(before));
    expect(mock.requests.length - before).toBe(APPENDIX_A.length);
    for (const pii of TEST_PII) expect(sent).not.toContain(pii);
  });

  it.skipIf(!live)('live run against the configured Hugging Face model (INSIGHT_BENCHMARK_LIVE=1)', async () => {
    const planner: Planner = createHfPlanner({
      // the production defaults (src/config.ts, CR-016) unless overridden
      model: process.env['HF_MODEL'] ?? 'openai/gpt-oss-120b',
      provider: process.env['HF_PROVIDER'] ?? (process.env['HF_MODEL'] ? undefined : 'groq'),
      client: createHfClient(process.env['HF_TOKEN'], process.env['HF_BASE_URL']),
      endpointUrl: process.env['HF_BASE_URL'],
      attemptTimeoutMs: Number(process.env['HF_ATTEMPT_MS'] ?? 5_000),
      budgetMs: Number(process.env['HF_BUDGET_MS'] ?? 6_500),
      onError: (e) => process.stdout.write(`  model call failed: ${e.reason} ${e.status ?? ''} ${e.error}\n`),
    });
    const h = harness({ clock, planner });
    try {
      const results = await runBenchmark(h, seeded, `live: ${planner.model ?? ''}`);
      expect(results.length).toBe(13);
    } finally {
      await h.close();
    }
  });
});
