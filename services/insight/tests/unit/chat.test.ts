// Domain/adapter unit tests for the chat: model output parsing, the keyword parser on Appendix A, Indian formatting,
// action cards and the Hugging Face planner's timeout / retry / breaker / credit handling.
import { describe, expect, it } from 'vitest';
import { createHfPlanner } from '../../src/adapters/hfPlanner.js';
import { nextMonthIst } from '../../src/adapters/chatAdapters.js';
import { libraryVocabulary } from '../../src/adapters/reference.js';
import { chunks } from '../../src/domain/answers/composer.js';
import { formatInr, groupIndian } from '../../src/domain/answers/indianFormat.js';
import { buildActionCard } from '../../src/domain/cards/cardBuilder.js';
import { parsePlannerOutput } from '../../src/domain/chat/modelOutput.js';
import { buildPlannerMessages } from '../../src/domain/chat/prompt.js';
import { parseKeywords } from '../../src/domain/plans/keywordParser.js';
import { APPENDIX_A } from '../appendixA.js';

const vocab = libraryVocabulary().values;
const kw = (text: string) =>
  parseKeywords(text, { now: new Date('2026-10-07T06:30:00.000Z'), vocabulary: vocab, locations: ['andheri west', 'powai', 'marol', 'bhiwandi', 'bkc'] });

describe('model output', () => {
  it('accepts the five kinds and rejects anything else', () => {
    expect(parsePlannerOutput('{"kind":"refusal"}')).toEqual({ kind: 'refusal' });
    expect(parsePlannerOutput('```json\n{"kind":"plan","planId":"count_offers","params":{"filters":[{"field":"bhk","op":"eq","value":2}]}}\n```')).toMatchObject({
      kind: 'plan',
      plan: { planId: 'count_offers', filters: [{ field: 'bhk', op: 'eq', value: 2 }] },
    });
    expect(parsePlannerOutput('{"kind":"plan","planId":"export_list","params":{"listPlanId":"list_offers"}}')).toMatchObject({ exportRequested: true, plan: { planId: 'list_offers' } });
    expect(parsePlannerOutput('{"kind":"plan","planId":"x","params":{"filters":[{"field":"a","op":"drop"}]}}')).toBeNull();
    expect(parsePlannerOutput('Here are the offers')).toBeNull();
    expect(parsePlannerOutput('{"kind":"sql","query":"select *"}')).toBeNull();
  });
});

describe('keyword parser', () => {
  for (const c of APPENDIX_A) {
    it(`${c.id} → ${c.expected.planId}`, () => {
      const d = kw(c.question);
      expect(d?.kind).toBe('plan');
      if (d?.kind !== 'plan') return;
      expect(d.plan.planId).toBe(c.expected.planId);
      for (const f of c.expected.filters ?? []) {
        const got = d.plan.filters?.find((x) => x.field === f.field);
        expect(got, `${c.id} ${f.field}`).toBeDefined();
        expect(got?.op).toBe(f.op);
        if (typeof f.value === 'string' && f.field === 'location') expect(String(got?.value).toLowerCase()).toBe(f.value.toLowerCase());
        else expect(got?.value).toEqual(f.value);
      }
      expect(d.exportRequested).toBe(!!c.expected.exportRequested);
      if (c.expected.period) expect(d.plan.period?.preset).toBe(c.expected.period.preset);
    });
  }
  it('returns null for questions that are not about our data', () => {
    expect(kw('What is the RBI repo rate today?')).toBeNull();
    expect(kw('What is the weather in Powai?')).toBeNull();
    expect(kw('Tell me a joke')).toBeNull();
  });
});

describe('formatting and prompt', () => {
  it('uses Indian grouping and crore', () => {
    expect(groupIndian(112000)).toBe('1,12,000');
    expect(groupIndian(12345678)).toBe('1,23,45,678');
    expect(formatInr(30_000_000)).toBe('₹3 Cr');
    expect(formatInr(98_000)).toBe('₹98,000');
  });
  it('chunks tokens at ~40 characters and never above 400', () => {
    const parts = chunks('word '.repeat(100));
    expect(parts.join('')).toBe('word '.repeat(100));
    expect(Math.max(...parts.map((p) => p.length))).toBeLessThanOrEqual(45);
    expect(chunks('x'.repeat(1000)).every((p) => p.length <= 400)).toBe(true);
  });
  it('sends the redacted question, 2 prior turns, the role catalogue and today — no rows', () => {
    const msgs = buildPlannerMessages({
      question: 'Call ⟨NAME_1⟩ on ⟨PHONE_1⟩',
      history: [
        { role: 'user', text: 'a' },
        { role: 'assistant', text: 'b' },
        { role: 'user', text: 'c' },
      ],
      role: 'Data operator',
      today: '2026-10-07',
      vocabulary: vocab,
    });
    expect(msgs).toHaveLength(4);
    expect(msgs[0]?.content).toContain('Today (IST): 2026-10-07');
    expect(msgs[0]?.content).toContain('upload_quality');
    expect(msgs[0]?.content).not.toContain('list_offers'); // not in the Data operator's catalogue
  });
});

describe('action cards', () => {
  const subjects = new Map([['DEM-000127', { kind: 'demand' as const, id: '11111111-1111-4111-8111-111111111111', code: 'DEM-000127', merged: false, version: 4 }]]);
  const ctx = { role: 'Manager', cardId: '22222222-2222-4222-8222-222222222222', idempotencyKey: '33333333-3333-4333-8333-333333333333', now: new Date('2026-10-07T06:30:00.000Z') };
  it('builds the owner operation with a 30-minute expiry', () => {
    const r = buildActionCard('C-16', { demandCode: 'dem-000127', exit: 'lost' }, subjects, ctx);
    expect(r).toMatchObject({ ok: true, card: { path: '/v1/demands/DEM-000127/exit', payload: { exit: 'Lost' }, expiresAt: '2026-10-07T07:00:00.000Z' } });
  });
  it('refuses merged subjects, unknown codes, bad values and roles', () => {
    expect(buildActionCard('C-09', { demandCode: 'DEM-000999' }, subjects, ctx)).toMatchObject({ ok: false, notice: 'clarify' });
    const merged = new Map([['DEM-000127', { ...subjects.get('DEM-000127')!, merged: true }]]);
    expect(buildActionCard('C-09', { demandCode: 'DEM-000127' }, merged, ctx)).toMatchObject({ ok: false });
    expect(buildActionCard('C-16', { demandCode: 'DEM-000127', exit: 'Vanished' }, subjects, ctx)).toMatchObject({ ok: false });
    expect(buildActionCard('C-09', { demandCode: 'DEM-000127' }, subjects, { ...ctx, role: 'Data operator' })).toMatchObject({ notice: 'not_allowed_for_role' });
    expect(buildActionCard('C-99', {}, subjects, ctx)).toMatchObject({ ok: false });
  });
});

describe('Hugging Face planner', () => {
  const req = { tenantId: 't', messages: [{ role: 'user' as const, content: 'q' }] };
  const reply = { choices: [{ message: { content: '{"kind":"refusal"}' } }] };
  it('retries once only after a fast 5xx, not after a timeout', async () => {
    let calls = 0;
    const p = createHfPlanner({
      model: 'm',
      client: {
        chatCompletion: async () => {
          calls++;
          if (calls === 1) throw Object.assign(new Error('bad gateway'), { httpResponse: { status: 502 } });
          return reply;
        },
      },
    });
    expect((await p.plan(req)).ok).toBe(true);
    expect(calls).toBe(2);
    let slowCalls = 0;
    const slow = createHfPlanner({
      model: 'm',
      attemptTimeoutMs: 50,
      client: {
        chatCompletion: (_a, o) => {
          slowCalls++;
          return new Promise((_, reject) => o?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('t'), { name: 'TimeoutError' }))));
        },
      },
    });
    expect(await slow.plan(req)).toEqual({ ok: false, reason: 'timeout' });
    expect(slowCalls).toBe(1);
  });
  it('maps 402 to credits, 429 to rate_limited, and opens the breaker after repeated failures', async () => {
    const status = (s: number) => createHfPlanner({ model: 'm', client: { chatCompletion: async () => Promise.reject(Object.assign(new Error('x'), { httpResponse: { status: s } })) } });
    expect(await status(402).plan(req)).toEqual({ ok: false, reason: 'credits' });
    expect(await status(429).plan(req)).toEqual({ ok: false, reason: 'rate_limited' });
    const failing = createHfPlanner({ model: 'm', client: { chatCompletion: async () => Promise.reject(Object.assign(new Error('x'), { httpResponse: { status: 400 } })) } });
    const reasons = [];
    for (let i = 0; i < 25; i++) reasons.push((await failing.plan(req)) as { reason?: string });
    expect(reasons.some((r) => r.reason === 'circuit_open')).toBe(true);
    expect(await createHfPlanner({ model: null, client: null }).plan(req)).toEqual({ ok: false, reason: 'not_configured' });
  });
  it('credits reset on the 1st of next month, 00:00 IST', () => {
    expect(nextMonthIst(new Date('2026-10-07T06:30:00.000Z')).toISOString()).toBe('2026-10-31T18:30:00.000Z');
  });
});
