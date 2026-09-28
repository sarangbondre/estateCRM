// HuggingFaceModelClassifier (LLD §2 adapters/model, §4.8, ADR-0004): @huggingface/inference chat completion over
// an OpenAI-compatible endpoint (HF router in the pilot, a dedicated endpoint later). Receives REDACTED text only
// (the application redacts first). 2 s timeout, no retry, a circuit breaker and a concurrency cap (5 pilot / 20 paid).
// Any failure → ModelUnavailableError, which the application turns into needs_review `model_unavailable`.
import { InferenceClient } from '@huggingface/inference';
import { CircuitBreaker, CircuitOpenError } from '@11e/http';
import { ModelUnavailableError } from '../application/ports.js';
import type { ModelClassifier, ModelOutput } from '../application/ports.js';

export interface HfOptions {
  token: string;
  model: string;
  /** Base URL of an OpenAI-compatible endpoint; the client posts to `<endpointUrl>/v1/chat/completions`. */
  endpointUrl: string;
  timeoutMs?: number;
  concurrency?: number;
  fetch?: typeof fetch;
}

const SYSTEM = [
  'You classify Indian real-estate and business ads. Placeholders like [PHONE_1] replace removed contact details.',
  'Answer ONLY with a JSON array, one object per input item, in the same order:',
  '{"id": string, "recordScope": "Property"|"Business"|"Capital"|"Equipment"|"Market Participant"|"Market Signal"|null,',
  '"dealTypes": string[], "market": "Primary"|"Secondary"|"Any"|null, "segment": "Residential"|"Commercial"|"Industrial"|"Land"|null,',
  '"propertyTypes": string[], "side": "Supply"|"Demand"|"None"|null, "confidence": number between 0 and 1}.',
  'dealTypes values: Sale, Lease, JV, Pagdi, Partnership, Distribution, Equity, Debt, Project Funding, Asset Sale.',
  'Use null or [] when the text does not say.',
].join('\n');

class Semaphore {
  #active = 0;
  readonly #waiters: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.#active >= this.max) await new Promise<void>((r) => this.#waiters.push(r));
    this.#active++;
    try {
      return await fn();
    } finally {
      this.#active--;
      this.#waiters.shift()?.();
    }
  }
}

/** Parses the model's JSON array (tolerates a fenced code block or text around it). */
export function parseModelJson(content: string): ModelOutput[] {
  const start = content.indexOf('[');
  const end = content.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(content.slice(start, end + 1)) as unknown;
    return Array.isArray(parsed) ? (parsed.filter((x) => x && typeof x === 'object') as ModelOutput[]) : [];
  } catch {
    return [];
  }
}

export function huggingFaceClassifier(o: HfOptions): ModelClassifier {
  const client = new InferenceClient(o.token, {
    endpointUrl: o.endpointUrl,
    retry_on_error: false,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  const breaker = new CircuitBreaker();
  const gate = new Semaphore(o.concurrency ?? 5);
  const timeoutMs = o.timeoutMs ?? 2000;
  return {
    async classify(items) {
      if (!items.length) return [];
      const user = JSON.stringify(items.map((i) => ({ id: i.id, text: i.text })));
      try {
        return await gate.run(() =>
          (async () => {
            breaker.before();
            let ok = false;
            try {
              const res = await client.chatCompletion(
                {
                  model: o.model,
                  messages: [
                    { role: 'system', content: SYSTEM },
                    { role: 'user', content: user },
                  ],
                  temperature: 0,
                  max_tokens: 150 * items.length,
                },
                { signal: AbortSignal.timeout(timeoutMs) },
              );
              const content = res.choices?.[0]?.message?.content;
              if (typeof content !== 'string') throw new Error('model returned no content');
              const out = parseModelJson(content);
              ok = true;
              return out;
            } finally {
              breaker.after(ok);
            }
          })(),
        );
      } catch (err) {
        if (err instanceof CircuitOpenError)
          throw new ModelUnavailableError('model circuit open', { cause: err });
        throw new ModelUnavailableError('model call failed', { cause: err });
      }
    },
  };
}

/** No token configured (tests, local, credits exhausted): every call is unavailable. */
export const unavailableClassifier: ModelClassifier = {
  classify: () => Promise.reject(new ModelUnavailableError('no Hugging Face token configured')),
};
