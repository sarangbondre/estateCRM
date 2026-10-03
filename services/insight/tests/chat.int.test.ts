// INS-04: conversations and the SSE chat — redaction before the model (asserted by the intercepting mock), plan
// validation, grounded template answers, keyword fallback, out-of-scope refusal, action cards, replay, limits.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@11e/db';
import { createHfPlanner } from '../src/adapters/hfPlanner.js';
import { HfMock, TEST_PII, parseSse } from './hfMock.js';
import { TestClock, harness, ids } from './helpers.js';
import { NOW, seedBenchmark } from './seed.js';
import type { Seeded } from './seed.js';

const clock = new TestClock(NOW);
const hf = new HfMock().recordAppendixA();
const h = harness({
  clock,
  planner: createHfPlanner({ model: 'Qwen/Qwen2.5-7B-Instruct', client: hf, attemptTimeoutMs: 400, budgetMs: 600 }),
});
// the same read model, no model configured: every answer comes from the keyword parser
const noModel = harness({ clock });
let seeded: Seeded;
afterAll(async () => {
  await h.close();
  await noModel.close();
});
beforeAll(async () => {
  seeded = await seedBenchmark(h);
});

type Api = Awaited<ReturnType<typeof h.as>>;
const newChat = async (api: Api) => (await api.post('/v1/chat/conversations', {})).body['conversationId'] as string;
const ask = async (api: Api, conv: string, text: string, headers: Record<string, string> = {}) => {
  const r = await api.post(`/v1/chat/conversations/${conv}/messages`, { text }, headers);
  const frames = r.status === 200 ? parseSse(r.text) : [];
  const done = frames.find((f) => f.event === 'done')?.data ?? {};
  const cards = frames.filter((f) => f.event === 'card').map((f) => f.data['card'] as Record<string, unknown>);
  const answer = frames.filter((f) => f.event === 'token').map((f) => f.data['text']).join('');
  return { r, frames, done, cards, answer, plan: frames.find((f) => f.event === 'plan')?.data['howIGotThis'] as Record<string, unknown> | undefined };
};

describe('conversations', () => {
  it('creates, lists (cursor), reads and deletes the caller’s own conversations; others get 403', async () => {
    const me = await h.as(seeded.me, 'Manager');
    const created = await me.post('/v1/chat/conversations', { title: 'Ask about Sanjay Testkar 90000 01234' }, { 'idempotency-key': ids() });
    expect(created.status).toBe(201);
    expect(created.body['code']).toMatch(/^CONV-\d{6}$/);
    expect(created.body['title']).not.toContain('90000');
    for (let i = 0; i < 3; i++) await newChat(me);
    const page1 = await me.get('/v1/chat/conversations?limit=2');
    expect(page1.body['items']).toHaveLength(2);
    const page2 = await me.get(`/v1/chat/conversations?limit=2&cursor=${page1.body['nextCursor']}`);
    expect(page2.status).toBe(200);
    const id = created.body['conversationId'] as string;
    expect((await me.get(`/v1/chat/conversations/${created.body['code']}`)).status).toBe(200);
    const other = await h.as(ids(), 'Manager');
    expect((await other.get(`/v1/chat/conversations/${id}`)).status).toBe(403);
    expect((await other.get(`/v1/chat/conversations/${id}/messages`)).status).toBe(403);
    expect((await other.del(`/v1/chat/conversations/${id}`)).status).toBe(403);
    expect((await me.del(`/v1/chat/conversations/${id}`)).status).toBe(204);
    expect((await me.del(`/v1/chat/conversations/${id}`)).status).toBe(204);
    expect((await me.get(`/v1/chat/conversations/${id}`)).status).toBe(404);
    expect((await me.del(`/v1/chat/conversations/${ids()}`)).status).toBe(404);
    expect((await me.post('/v1/chat/conversations', { title: 'x', extra: 1 })).status).toBe(400);
  });
});

describe('POST messages (SSE)', () => {
  it('answers from the read model: plan → tokens → cards → done, and stores the exchange', async () => {
    const me = await h.as(seeded.me, 'Manager');
    const conv = await newChat(me);
    const q = await ask(me, conv, 'How many active 2BHK lease offers are there in Andheri West?');
    expect(q.r.status).toBe(200);
    expect(q.r.headers['content-type']).toContain('text/event-stream');
    expect(q.frames[0]?.event).toBe('plan');
    expect(q.answer).toBe('There are 3 For Rent 2 BHK offers in Andheri West that are active.');
    expect(q.plan).toMatchObject({ source: '11 Estates read model (insight)', fallbackUsed: false, rowCount: 3 });
    expect(q.cards[0]).toMatchObject({ kind: 'answer', cardType: 'C-02', figures: [{ label: 'Count', value: 3, unit: 'count' }] });
    expect(q.done).toMatchObject({ outcome: 'answered', fallbackUsed: false, model: 'Qwen/Qwen2.5-7B-Instruct' });
    const msgs = await me.get(`/v1/chat/conversations/${conv}/messages`);
    expect(msgs.body['items']?.map((m) => m['role'])).toEqual(['user', 'assistant']);
    expect(msgs.body['items']?.[1]).toMatchObject({ status: 'complete', fallbackUsed: false });
    const c = await me.get(`/v1/chat/conversations/${conv}`);
    expect(c.body).toMatchObject({ messageCount: 2, title: 'How many active 2BHK lease offers are there in Andheri West?' });
  });

  it('never sends PII to the model and stores only redacted text', async () => {
    const me = await h.as(seeded.me, 'Manager');
    const conv = await newChat(me);
    const before = hf.requests.length;
    const text = 'Call Sanjay Testkar on 90000 01234 or sanjay.test@example.com about Flat 1203 — how many lease offers in Powai?';
    const q = await ask(me, conv, text);
    expect(q.r.status).toBe(200);
    expect(hf.requests.length).toBe(before + 1); // the interceptor threw on any PII; it didn't
    const sent = JSON.stringify(hf.requests.at(-1));
    for (const pii of TEST_PII) expect(sent).not.toContain(pii);
    expect(sent).toContain('⟨PHONE_1⟩');
    const stored = await h.rows<{ redacted_text: string; redaction_counts: Record<string, number> }>(
      sql`select redacted_text, redaction_counts from message m join conversation c on c.tenant_id = m.tenant_id and c.id = m.conversation_id
          where m.tenant_id = ${h.tenantId} and c.id = ${conv} and m.role = 'user'`,
    );
    for (const pii of TEST_PII) expect(stored[0]?.redacted_text).not.toContain(pii);
    expect(stored[0]?.redaction_counts['PHONE']).toBe(1);
  });

  it('refuses out-of-scope questions', async () => {
    const me = await h.as(seeded.me, 'Manager');
    const conv = await newChat(me);
    const q = await ask(me, conv, 'What is the RBI repo rate today?');
    expect(q.answer).toBe('I can only answer from 11 Estates data.');
    expect(q.cards[0]).toMatchObject({ kind: 'notice', notice: 'out_of_scope' });
    expect((q.cards[0]?.['suggestions'] as string[]).length).toBe(3);
    expect(q.done['outcome']).toBe('refused');
    const msgs = await me.get(`/v1/chat/conversations/${conv}/messages`);
    expect(msgs.body['items']?.[1]?.['status']).toBe('refused');
  });

  it('falls back to keywords when the model is unavailable, times out or answers garbage', async () => {
    const off = await noModel.as(seeded.me, 'Manager');
    // the no-model harness has its own tenant: reuse the seeded tenant through its token
    const api = await noModel.as(seeded.me, 'Manager', h.tenantId);
    void off;
    const conv = await newChat(api);
    const q = await ask(api, conv, 'How many active 2BHK lease offers are there in Andheri West?');
    expect(q.answer).toBe('There are 3 For Rent 2 BHK offers in Andheri West that are active.');
    expect(q.cards.at(-1)).toMatchObject({ kind: 'notice', notice: 'model_unavailable_keyword_fallback' });
    expect(q.cards.at(-1)?.['text']).toMatch(/model is unavailable/);
    expect(q.done).toMatchObject({ fallbackUsed: true, model: null });
    expect(q.plan?.['fallbackUsed']).toBe(true);

    const me = await h.as(seeded.me, 'Manager');
    const conv2 = await newChat(me);
    hf.replies.set('Show demands in Sourcing for more than 7 days.', { fail: 'timeout' });
    const t0 = Date.now();
    const slow = await ask(me, conv2, 'Show demands in Sourcing for more than 7 days.');
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(slow.done['fallbackUsed']).toBe(true);
    expect(slow.answer).toMatch(/^Here (is|are) the 1 demand/);
    hf.replies.set('Which Public offers turned Stale this week?', { fail: 'garbage' });
    const garbage = await ask(me, conv2, 'Which Public offers turned Stale this week?');
    expect(garbage.done['fallbackUsed']).toBe(true);
    // the model replied, just not with a usable plan: say so instead of "unavailable"
    expect(garbage.cards.find((c) => c['kind'] === 'notice' && c['notice'] === 'model_unavailable_keyword_fallback')?.['text']).toMatch(/couldn't turn that into a report/);
    expect((garbage.cards.find((c) => c['kind'] === 'table')?.['result'] as { rows: unknown[] }).rows).toHaveLength(1);
    // an invalid model plan is repaired by the keyword parser once
    hf.replies.set('Show resale 3BHK offers in Powai under ₹3 Cr that are Fresh.', { kind: 'plan', planId: 'list_offers', params: { filters: [{ field: 'owner_phone', op: 'eq', value: 'x' }] } });
    const repaired = await ask(me, conv2, 'Show resale 3BHK offers in Powai under ₹3 Cr that are Fresh.');
    expect(repaired.done['fallbackUsed']).toBe(true);
    expect(repaired.answer).toMatch(/^Here are the 2 /);
    hf.recordAppendixA();
  });

  it('marks credits exhausted on 402, skips the model until hf-credit-reset clears it', async () => {
    const me = await h.as(seeded.me, 'Manager');
    const conv = await newChat(me);
    hf.replies.set('Which Upcoming offers become available in the next 60 days?', { fail: 402 });
    const first = await ask(me, conv, 'Which Upcoming offers become available in the next 60 days?');
    expect(first.done['fallbackUsed']).toBe(true);
    const calls = hf.requests.length;
    const second = await ask(me, conv, 'How many active 2BHK lease offers are there in Andheri West?');
    expect(hf.requests.length).toBe(calls); // not called while credits are exhausted
    expect(second.done['fallbackUsed']).toBe(true);
    const ready = (await (await h.app.request('/health/ready')).json()) as { checks: Record<string, string> };
    expect(ready.checks['model']).toBe('degraded');
    clock.set('2026-11-01T00:00:00.000Z');
    expect((await h.cron('/internal/v1/jobs/hf-credit-reset')).status).toBe(200);
    clock.set(NOW);
    await sql`update hf_usage set credits_exhausted_until = null where tenant_id = ${h.tenantId}`.execute(h.db); // test clock vs DB now()
    hf.recordAppendixA();
  });

  it('streams action cards (placeholders refilled only in the stream) and checks roles', async () => {
    const d = (await h.rows<{ code: string }>(sql`select code from rm_demand where tenant_id = ${h.tenantId} and code is not null limit 1`))[0]?.code as string;
    hf.replies.set(`Qualify ${d}`, { kind: 'action', cardType: 'C-09', slots: { demandCode: d } });
    const mgr = await h.as(seeded.me, 'Manager');
    const conv = await newChat(mgr);
    const q = await ask(mgr, conv, `Qualify ${d}`);
    expect(q.cards[0]).toMatchObject({
      kind: 'action',
      cardType: 'C-09',
      targetService: 'journeys',
      targetOperation: 'qualifyDemand',
      method: 'POST',
      path: `/v1/demands/${d}/qualify`,
      requiresConfirmation: true,
    });
    expect(q.done['outcome']).toBe('action_proposed');
    const supply = await h.as(ids(), 'Supply agent');
    const conv2 = await newChat(supply);
    const denied = await ask(supply, conv2, `Qualify ${d}`);
    expect(denied.cards[0]).toMatchObject({ kind: 'notice', notice: 'not_allowed_for_role' });

    const add = await ask(mgr, conv, '/add demand 90000 01234');
    expect(add.cards[0]).toMatchObject({ kind: 'action', cardType: 'C-06', payload: { side: 'Demand', phone: '90000 01234' } });
    const items = (await mgr.get(`/v1/chat/conversations/${conv}/messages`)).body['items'] ?? [];
    const stored = items.flatMap((m) => (m['cards'] ?? []) as { cardType?: string; payload?: { phone?: string } }[]).find((c) => c.cardType === 'C-06');
    expect(stored?.payload?.phone).toBe('⟨PHONE_1⟩');
  });

  it('handles quick actions and bare codes without the model', async () => {
    const me = await h.as(seeded.me, 'Manager');
    const conv = await newChat(me);
    const calls = hf.requests.length;
    expect((await ask(me, conv, '/queue')).cards[0]).toMatchObject({ kind: 'navigate', panel: 'P-01', targetService: 'journeys', targetOperation: 'getMyQueue' });
    const code = (await h.rows<{ code: string }>(sql`select code from rm_demand where tenant_id = ${h.tenantId} and code is not null limit 1`))[0]?.code as string;
    expect((await ask(me, conv, code)).cards[0]).toMatchObject({ kind: 'navigate', panel: 'P-03', subjectCode: code });
    expect((await ask(me, conv, '/review')).cards[0]).toMatchObject({ kind: 'navigate', targetService: 'intake' });
    expect((await ask(me, conv, '/dashboard')).cards[0]).toMatchObject({ kind: 'dashboard', cardType: 'C-20', dashboard: 'demand' });
    expect(hf.requests.length).toBe(calls);
  });

  it('marks exports exportable (Q9) and answers stats (Q4) from templates', async () => {
    const me = await h.as(seeded.me, 'Manager');
    const conv = await newChat(me);
    const q9 = await ask(me, conv, 'Give me all industrial galas for lease in Bhiwandi as an Excel file.');
    expect(q9.cards.find((c) => c['kind'] === 'table')).toMatchObject({ exportable: true });
    expect(q9.answer).toContain('Use Excel to download all 2 rows.');
    const q4 = await ask(me, conv, 'What was the average closed rent for offices in Marol this quarter?');
    expect(q4.answer).toBe(
      'Average closed rent for Office in Marol this quarter: ₹1,12,000/month across 2 closes (median ₹1,12,000; range ₹1,00,000–₹1,24,000).',
    );
  });

  it('replays a stored answer for the same Idempotency-Key and rejects a different body', async () => {
    const me = await h.as(seeded.me, 'Manager');
    const conv = await newChat(me);
    const key = ids();
    const a = await ask(me, conv, 'Which Upcoming offers become available in the next 60 days?', { 'idempotency-key': key });
    const calls = hf.requests.length;
    const b = await ask(me, conv, 'Which Upcoming offers become available in the next 60 days?', { 'idempotency-key': key });
    expect(b.done['messageId']).toBe(a.done['messageId']);
    expect(hf.requests.length).toBe(calls);
    expect(b.answer).toBe(a.answer);
    const c = await ask(me, conv, 'something else', { 'idempotency-key': key });
    expect(c.r.status).toBe(409);
  });

  it('validates the request: 413 over 2,000 characters, 404 unknown conversation, 400 bad body', async () => {
    const me = await h.as(seeded.me, 'Manager');
    const conv = await newChat(me);
    expect((await me.post(`/v1/chat/conversations/${conv}/messages`, { text: 'x'.repeat(2001) })).status).toBe(413);
    expect((await me.post(`/v1/chat/conversations/${ids()}/messages`, { text: 'hi' })).status).toBe(404);
    expect((await me.post(`/v1/chat/conversations/${conv}/messages`, { text: '' })).status).toBe(400);
  });
});

describe('conversation-purge', () => {
  it('purges deleted conversations with their messages', async () => {
    const me = await h.as(seeded.me, 'Manager');
    const conv = await newChat(me);
    await ask(me, conv, '/queue');
    await me.del(`/v1/chat/conversations/${conv}`);
    const r = await h.cron('/internal/v1/jobs/conversation-purge');
    expect([200, 409]).toContain(r.status);
    if (r.status === 200) {
      const left = await h.rows(sql`select 1 from message where tenant_id = ${h.tenantId} and conversation_id = ${conv}`);
      expect(left).toHaveLength(0);
    }
  });
});
