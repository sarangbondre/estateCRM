// Hugging Face planner adapter: providers that reject json_schema structured output (seen on the pilot: Together's
// Llama 3.1 8B answers 405) get one immediate retry without response_format, and later calls skip it.
import { describe, expect, it } from 'vitest';
import { createHfPlanner } from '../src/adapters/hfPlanner.js';
import type { ChatCompletionClient } from '../src/adapters/hfPlanner.js';
import type { PlannerRequest } from '../src/application/ports.js';

const req: PlannerRequest = { tenantId: 't', messages: [{ role: 'user', content: 'How many offers?' }] };
const unsupported = () =>
  Object.assign(new Error('Failed to perform inference: an HTTP error occurred when requesting the provider.'), {
    httpResponse: {
      status: 405,
      body: { error: { message: 'json_schema response format is not supported for model: x', param: 'response_format' } },
    },
  });

describe('createHfPlanner', () => {
  it('retries without response_format when the provider rejects json_schema, and keeps it off', async () => {
    const formats: (string | undefined)[] = [];
    const client: ChatCompletionClient = {
      chatCompletion: async (args) => {
        formats.push(args.response_format?.type);
        if (args.response_format) throw unsupported();
        return { choices: [{ message: { content: '{"kind":"refusal"}' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } };
      },
    };
    const errors: string[] = [];
    const planner = createHfPlanner({ model: 'm', client, onError: (e) => errors.push(e.reason) });
    expect(await planner.plan(req)).toMatchObject({ ok: true, text: '{"kind":"refusal"}' });
    expect(await planner.plan(req)).toMatchObject({ ok: true });
    expect(formats).toEqual(['json_schema', undefined, undefined]);
    expect(errors).toEqual(['format_unsupported']);
  });

  it('other 4xx answers are errors without a retry', async () => {
    let calls = 0;
    const client: ChatCompletionClient = {
      chatCompletion: async () => {
        calls++;
        throw Object.assign(new Error('bad'), { httpResponse: { status: 400, body: { error: { code: 'model_not_supported' } } } });
      },
    };
    const planner = createHfPlanner({ model: 'm', client });
    expect(await planner.plan(req)).toEqual({ ok: false, reason: 'error' });
    expect(calls).toBe(1);
  });

  it('waits for a short rate-limit hint and retries once', async () => {
    let calls = 0;
    const client: ChatCompletionClient = {
      chatCompletion: async () => {
        calls++;
        if (calls === 1)
          throw Object.assign(new Error('rate'), {
            httpResponse: { status: 429, body: { error: { message: 'Rate limit reached ... Please try again in 134.48ms.' } } },
          });
        return { choices: [{ message: { content: '{"kind":"refusal"}' } }] };
      },
    };
    const started = Date.now();
    expect(await createHfPlanner({ model: 'm', client }).plan(req)).toMatchObject({ ok: true });
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(130);
  });
});
