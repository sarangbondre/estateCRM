// INT-06: AI for leftovers through the real Hugging Face adapter with an INTERCEPTING fetch mock (no network, no
// HF_TOKEN, no spend, B5). The mock records every request and the test asserts that no PII of the uploaded rows ever
// leaves: names, phones and e-mails are redacted before the call; text failing the post-check is never sent.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { huggingFaceClassifier, parseModelJson } from '../src/adapters/model.js';
import { mergeSuggestion, validateModelOutput } from '../src/domain/model-output.js';
import { createHarness, newTenant } from './support/harness.js';
import type { Harness } from './support/harness.js';
import { csv } from './support/files.js';
import { processAll, uploadAndSplit } from './support/flows.js';

const ENDPOINT = 'https://model.test';
const requests: { url: string; body: string }[] = [];
let mode: 'ok' | 'down' = 'ok';

/** Answers like a chat-completion endpoint: a JSON array, one object per input item. */
const interceptingFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const body = typeof init?.body === 'string' ? init.body : '';
  requests.push({ url, body });
  if (mode === 'down') return new Response('overloaded', { status: 503 });
  const req = JSON.parse(body) as { messages: { role: string; content: string }[] };
  const items = JSON.parse(req.messages.find((m) => m.role === 'user')?.content ?? '[]') as {
    id: string;
    text: string;
  }[];
  const answer = items.map((i) => {
    const t = i.text.toLowerCase();
    if (t.includes('vague'))
      return { id: i.id, recordScope: 'Property', dealTypes: ['Sale'], side: 'Supply', confidence: 0.4 };
    if (t.includes('godown')) {
      return {
        id: i.id,
        recordScope: 'Property',
        dealTypes: ['Lease', 'Rent'],
        segment: 'Industrial',
        propertyTypes: ['Warehouse'],
        side: 'Supply',
        confidence: 0.9,
      };
    }
    return { id: i.id, recordScope: 'Property', dealTypes: ['Sale'], side: 'Demand', confidence: 0.85 };
  });
  return new Response(
    JSON.stringify({
      id: 'x',
      object: 'chat.completion',
      created: 0,
      model: 'test',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: `Here:\n${JSON.stringify(answer)}` },
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};

let h: Harness;
beforeAll(async () => {
  // paid-plan mode (no anonymisation), so the test checks redaction of real-looking synthetic contacts
  h = await createHarness({
    env: { PILOT_MODE: 'false', CHUNK_SIZE: '500' },
    model: huggingFaceClassifier({
      token: 'test-token',
      model: 'test/model',
      endpointUrl: ENDPOINT,
      fetch: interceptingFetch,
    }),
  });
});
afterAll(() => h.close());

const PII = [
  'Rahul Sharma',
  'Rahul',
  'Sharma',
  '90000 12345',
  '9000012345',
  'rahul.s@example.com',
  'Priya Nair',
  '90000 54321',
];

const FILE = csv([
  ['Lead ID', 'Name', 'Mobile', 'Message'],
  [
    'M-1',
    'Rahul Sharma',
    '9000012345',
    'Godown near Bhiwandi, contact Mr Rahul Sharma 90000 12345, rahul.s@example.com',
  ],
  ['M-2', 'Priya Nair', '9000054321', 'Something in Thane, call Priya Nair 90000 54321'],
  ['M-3', 'Test Person', '9000011111', 'vague enquiry, please ring back'],
  ['M-4', 'Test Person', '9000022222', 'priced @ 22 each'],
]);
const mapping = {
  columnMap: { 'Lead ID': 'external_id', Name: 'contact_name', Mobile: 'phones', Message: 'free_text' },
};

describe('leftovers → redaction → Hugging Face (intercepted)', () => {
  it('sends only redacted text in batches, merges confident answers, flags low confidence and uncertain text', async () => {
    requests.length = 0;
    mode = 'ok';
    const t = newTenant();
    const u = await uploadAndSplit(h, t, FILE, {
      fileName: 'leads.csv',
      contentType: 'text/csv',
      sourceType: 'Direct',
      mapping,
    });
    await processAll(h, t, u.id);

    expect(requests.length).toBe(1);
    expect(requests[0]?.url).toBe(`${ENDPOINT}/v1/chat/completions`);
    const sent = requests.map((r) => r.body).join('\n');
    for (const value of PII) expect(sent).not.toContain(value);
    expect(sent).toContain('[PHONE_1]');
    expect(sent).not.toContain('@ 22'); // failed the post-check: never sent

    const raw = await h.db
      .selectFrom('raw_rows')
      .select(['row_no', 'normalised', 'used_model', 'reason_codes', 'primary_reason_code', 'detail_code'])
      .where('upload_id', '=', u.id)
      .orderBy('row_no')
      .execute();
    expect(raw[0]?.used_model).toBe(true);
    // invalid model values are dropped ("Rent"); the rest is merged into blank fields only
    expect(raw[0]?.normalised).toMatchObject({
      recordScope: 'Property',
      dealTypes: ['Lease'],
      propertyTypes: ['Warehouse'],
      side: 'Supply',
    });
    expect(raw[1]?.normalised).toMatchObject({ side: 'Demand', dealTypes: ['Sale'] });
    expect(raw[2]).toMatchObject({ used_model: false, primary_reason_code: 'low_confidence' });
    expect(raw[3]).toMatchObject({
      used_model: false,
      primary_reason_code: 'other',
      detail_code: 'redaction_uncertain',
    });
    const item = await h.db
      .selectFrom('review_items')
      .select(['suggested', 'detail_code'])
      .where('row_no', '=', 3)
      .where('upload_id', '=', u.id)
      .executeTakeFirst();
    expect(item?.suggested).toMatchObject({ recordScope: 'Property', confidence: 0.4 });
  });

  it('falls back to model_unavailable when the endpoint fails; the upload still processes', async () => {
    requests.length = 0;
    mode = 'down';
    const t = newTenant();
    const u = await uploadAndSplit(h, t, FILE, {
      fileName: 'leads.csv',
      contentType: 'text/csv',
      sourceType: 'Direct',
      mapping,
    });
    await processAll(h, t, u.id);
    mode = 'ok';
    expect(requests.length).toBe(1); // no retry
    const codes = await h.db
      .selectFrom('raw_rows')
      .select('reason_codes')
      .where('upload_id', '=', u.id)
      .execute();
    expect(codes.filter((c) => c.reason_codes?.includes('model_unavailable'))).toHaveLength(3);
    const up = await h.db
      .selectFrom('uploads')
      .select(['chunks_done', 'rows_accepted'])
      .where('id', '=', u.id)
      .executeTakeFirst();
    expect(up).toEqual({ chunks_done: 1, rows_accepted: 4 });
  });
});

describe('model output validation', () => {
  it('parses a JSON array out of surrounding text and validates against the vocabulary', () => {
    expect(parseModelJson('```json\n[{"id":"1"}]\n```')).toEqual([{ id: '1' }]);
    expect(parseModelJson('no json')).toEqual([]);
    const s = validateModelOutput({
      recordScope: 'property',
      dealTypes: ['sale', 'Barter'],
      side: 'Buyer',
      confidence: 2,
    });
    expect(s).toEqual({
      classification: {
        recordScope: 'Property',
        dealTypes: ['Sale'],
        market: null,
        segment: null,
        propertyTypes: [],
        landUse: null,
        side: null,
      },
      confidence: 1,
    });
  });

  it('merges only blanks and refuses a merge that breaks the cross-field rules', () => {
    const current = {
      recordScope: 'Property' as const,
      dealTypes: ['Lease'],
      market: null,
      segment: null,
      propertyTypes: [],
      landUse: null,
      side: null,
    };
    expect(mergeSuggestion(current, { ...current, dealTypes: ['Sale'], side: 'Demand' })).toMatchObject({
      dealTypes: ['Lease'],
      side: 'Demand',
    });
    expect(mergeSuggestion(current, { ...current, market: 'Primary' })).toBeUndefined();
  });
});
