// Hugging Face planner (LLD §4.2, ADR-0004): OpenAI-compatible chat completion with a JSON-schema response format.
// temperature 0, max_tokens 400; 2.0 s per attempt, one retry only when the first attempt failed in < 1 s (connection
// reset / 5xx), 2.5 s for the whole model phase; circuit breaker 50% over 20 calls → open 30 s; per-instance
// concurrency cap. 402 / quota → credits; 429 → rate limited. The request carries only the redacted prompt.
import { InferenceClient } from '@huggingface/inference';
import { CircuitBreaker } from '@11e/http';
import type { Planner, PlannerRequest, PlannerResult } from '../application/ports.js';
import { PLANNER_JSON_SCHEMA } from '../domain/chat/modelOutput.js';

/** The slice of `@huggingface/inference`'s client the planner uses (tests inject an intercepting fake). */
export interface ChatCompletionClient {
  chatCompletion(
    args: {
      model?: string;
      endpointUrl?: string;
      provider?: string;
      messages: { role: string; content: string }[];
      temperature: number;
      max_tokens: number;
      response_format: { type: 'json_schema'; json_schema: { name: string; schema: object; strict?: boolean } };
    },
    options?: { signal?: AbortSignal; retry_on_error?: boolean },
  ): Promise<{ choices: { message: { content?: string | null } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }>;
}

export interface HfPlannerOptions {
  model: string | null;
  client: ChatCompletionClient | null;
  endpointUrl?: string | undefined;
  attemptTimeoutMs?: number;
  budgetMs?: number;
  concurrency?: number;
}

export function createHfClient(token: string | undefined, baseUrl: string | undefined): ChatCompletionClient | null {
  if (!token) return null;
  return new InferenceClient(token, baseUrl ? { endpointUrl: baseUrl } : {}) as unknown as ChatCompletionClient;
}

const statusOf = (err: unknown): number | undefined => {
  const e = err as { httpResponse?: { status?: number }; status?: number; statusCode?: number };
  return e.httpResponse?.status ?? e.status ?? e.statusCode;
};

export function createHfPlanner(o: HfPlannerOptions): Planner {
  const breaker = new CircuitBreaker({ window: 20, failureRatio: 0.5, openMs: 30_000 });
  const attemptMs = o.attemptTimeoutMs ?? 2_000;
  const budgetMs = o.budgetMs ?? 2_500;
  const cap = o.concurrency ?? 5;
  let inFlight = 0;

  async function attempt(req: PlannerRequest, timeoutMs: number): Promise<PlannerResult & { fast?: boolean }> {
    const client = o.client as ChatCompletionClient;
    const started = Date.now();
    try {
      breaker.before();
    } catch {
      return { ok: false, reason: 'circuit_open' };
    }
    try {
      const out = await client.chatCompletion(
        {
          ...(o.model ? { model: o.model } : {}),
          ...(o.endpointUrl ? { endpointUrl: o.endpointUrl } : {}),
          messages: req.messages,
          temperature: 0,
          max_tokens: 400,
          response_format: { type: 'json_schema', json_schema: { name: 'plan', schema: PLANNER_JSON_SCHEMA } },
        },
        { signal: AbortSignal.timeout(timeoutMs), retry_on_error: false },
      );
      breaker.after(true);
      return {
        ok: true,
        text: out.choices[0]?.message.content ?? '',
        model: o.model ?? 'unknown',
        inputTokens: out.usage?.prompt_tokens ?? 0,
        outputTokens: out.usage?.completion_tokens ?? 0,
      };
    } catch (err) {
      const status = statusOf(err);
      const elapsed = Date.now() - started;
      if (status === 402 || /quota|credit|exceeded your monthly/i.test(String((err as Error)?.message ?? ''))) {
        breaker.after(true); // not an availability failure
        return { ok: false, reason: 'credits' };
      }
      if (status === 429) {
        breaker.after(true);
        return { ok: false, reason: 'rate_limited' };
      }
      breaker.after(false);
      const timeout = (err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError' || elapsed >= timeoutMs;
      return { ok: false, reason: timeout ? 'timeout' : 'error', fast: !timeout && elapsed < 1_000 && (status === undefined || status >= 500) };
    }
  }

  return {
    model: o.model,
    async plan(req) {
      if (!o.client) return { ok: false, reason: 'not_configured' };
      if (inFlight >= cap) return { ok: false, reason: 'busy' };
      inFlight++;
      const started = Date.now();
      try {
        const first = await attempt(req, attemptMs);
        if (first.ok || !first.fast) return strip(first);
        const left = budgetMs - (Date.now() - started);
        if (left < 300) return strip(first);
        return strip(await attempt(req, Math.min(attemptMs, left)));
      } finally {
        inFlight--;
      }
    },
  };
}

function strip(r: PlannerResult & { fast?: boolean }): PlannerResult {
  if (r.ok) return r;
  return { ok: false, reason: r.reason };
}
