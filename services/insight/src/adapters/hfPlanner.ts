// Hugging Face planner (LLD §4.2, ADR-0004): OpenAI-compatible chat completion with a JSON-schema response format.
// temperature 0, max_tokens 400; per-attempt and whole-phase limits from config (CR-016: 5 s / 6.5 s; 2.0 s / 2.5 s
// here when not given), one retry only when the first attempt failed in < 1 s (connection reset / 5xx) or the provider
// rejected json_schema; circuit breaker 50% over 20 calls → open 30 s; per-instance
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
      reasoning_effort?: 'low' | 'medium' | 'high';
      response_format?: { type: 'json_schema'; json_schema: { name: string; schema: object; strict?: boolean } };
    },
    options?: { signal?: AbortSignal; retry_on_error?: boolean },
  ): Promise<{ choices: { message: { content?: string | null } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }>;
}

export interface HfPlannerOptions {
  model: string | null;
  client: ChatCompletionClient | null;
  endpointUrl?: string | undefined;
  /** Pinned inference provider (e.g. groq); undefined lets Hugging Face choose. */
  provider?: string | undefined;
  attemptTimeoutMs?: number;
  budgetMs?: number;
  concurrency?: number;
  /** RED metrics per downstream (libs/observability `obs.onCall`, name "huggingface"). */
  onCall?: (info: { name: string; method: string; path: string; status: number | 'error'; durationMs: number; attempt: number }) => void;
  /** A failed model call: HTTP status and the provider's error text (truncated; the prompt is never included). */
  onError?: (info: { status: number | undefined; reason: string; error: string; attempt: number }) => void;
}

export function createHfClient(token: string | undefined, baseUrl: string | undefined): ChatCompletionClient | null {
  if (!token) return null;
  return new InferenceClient(token, baseUrl ? { endpointUrl: baseUrl } : {}) as unknown as ChatCompletionClient;
}

/** The provider's reason: the library's message is generic, the HTTP body says why (e.g. an unsupported schema). */
const errorText = (err: unknown): string => {
  const e = err as { message?: unknown; httpResponse?: { body?: unknown } };
  const body = e.httpResponse?.body;
  const detail = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return `${String(e.message ?? err)}${detail ? ` | ${detail}` : ''}`.slice(0, 400);
};

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
  // Structured output (json_schema) until a provider says it doesn't support it; then the prompt's "exactly one JSON
  // object" rule and parsePlannerOutput's validation carry the format (providers differ per model).
  let structured = true;
  const reasoning = /gpt-oss/i.test(o.model ?? '');

  const record = (status: number | 'error', started: number, n: number) =>
    o.onCall?.({ name: 'huggingface', method: 'POST', path: '/v1/chat/completions', status, durationMs: Date.now() - started, attempt: n });

  async function attempt(
    req: PlannerRequest,
    timeoutMs: number,
    n = 1,
  ): Promise<PlannerResult & { fast?: boolean; retryNow?: boolean }> {
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
          ...(o.provider ? { provider: o.provider } : {}),
          messages: req.messages,
          temperature: 0,
          // Reasoning models (gpt-oss) spend tokens thinking first: keep it short and leave room for the JSON.
          ...(reasoning ? { reasoning_effort: 'low' as const, max_tokens: 1_000 } : { max_tokens: 400 }),
          ...(structured
            ? { response_format: { type: 'json_schema' as const, json_schema: { name: 'plan', schema: PLANNER_JSON_SCHEMA } } }
            : {}),
        },
        { signal: AbortSignal.timeout(timeoutMs), retry_on_error: false },
      );
      breaker.after(true);
      record(200, started, n);
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
      record(status ?? 'error', started, n);
      if (status === 402 || /quota|credit|exceeded your monthly/i.test(String((err as Error)?.message ?? ''))) {
        breaker.after(true); // not an availability failure
        o.onError?.({ status, reason: 'credits', error: errorText(err), attempt: n });
        return { ok: false, reason: 'credits' };
      }
      if (status === 429) {
        breaker.after(true);
        o.onError?.({ status, reason: 'rate_limited', error: errorText(err), attempt: n });
        return { ok: false, reason: 'rate_limited' };
      }
      if (structured && status !== undefined && [400, 405, 422].includes(status) && /response_format|json_schema/i.test(errorText(err))) {
        structured = false;
        breaker.after(true); // a capability answer, not an availability failure
        o.onError?.({ status, reason: 'format_unsupported', error: errorText(err), attempt: n });
        return { ok: false, reason: 'error', retryNow: true };
      }
      breaker.after(false);
      const timeout = (err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError' || elapsed >= timeoutMs;
      o.onError?.({ status, reason: timeout ? 'timeout' : 'error', error: errorText(err), attempt: n });
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
        if (first.ok || !(first.fast || first.retryNow)) return strip(first);
        const left = budgetMs - (Date.now() - started);
        if (left < 300) return strip(first);
        return strip(await attempt(req, Math.min(attemptMs, left), 2));
      } finally {
        inFlight--;
      }
    },
  };
}

function strip(r: PlannerResult & { fast?: boolean; retryNow?: boolean }): PlannerResult {
  if (r.ok) return r;
  return { ok: false, reason: r.reason };
}
