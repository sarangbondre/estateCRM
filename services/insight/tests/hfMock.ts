// Intercepting mock of the Hugging Face chat-completion client (B5: no real calls, no HF_TOKEN). Every outbound
// request is checked for PII before a recorded reply is returned: no known raw test value, no phone or e-mail
// (libs/redaction containsContact), and nothing but placeholders where the question had contact details.
import { containsContact } from '@11e/redaction';
import type { ChatCompletionClient } from '../src/adapters/hfPlanner.js';
import { APPENDIX_A } from './appendixA.js';

/** Synthetic PII used in the chat tests (never real): must never reach the model. */
export const TEST_PII = ['90000 01234', '9000001234', 'sanjay.test@example.com', 'Sanjay Testkar', 'Flat 1203'];

export type Reply = object | ((question: string) => object) | { fail: 402 | 429 | 500 | 'timeout' | 'garbage'; delayMs?: number };

export class HfMock implements ChatCompletionClient {
  requests: { role: string; content: string }[][] = [];
  replies = new Map<string, Reply>();
  fallbackReply: Reply = { kind: 'refusal' };
  delayMs = 0;

  /** The recorded model replies for PRD Appendix A (the expected plans), keyed by the question. */
  recordAppendixA(): this {
    for (const c of APPENDIX_A) {
      const { exportRequested, planId, templateVersion: _v, ...params } = c.expected;
      void _v;
      this.replies.set(c.question, { kind: 'plan', planId, params: { ...params, ...(exportRequested ? { export: true } : {}) } });
    }
    return this;
  }

  async chatCompletion(args: Parameters<ChatCompletionClient['chatCompletion']>[0], options?: { signal?: AbortSignal }) {
    this.requests.push(args.messages);
    for (const m of args.messages) {
      for (const pii of TEST_PII) if (m.content.includes(pii)) throw new Error(`PII leaked to the model: ${m.role} message contains a test PII value`);
      if (m.role !== 'system' && containsContact(m.content)) throw new Error(`PII leaked to the model: ${m.role} message contains a contact`);
    }
    const question = args.messages.at(-1)?.content ?? '';
    const reply = this.replies.get(question) ?? this.fallbackReply;
    const delay = (typeof reply === 'object' && 'fail' in reply ? reply.delayMs : undefined) ?? this.delayMs;
    if (delay) await sleep(delay, options?.signal);
    if (typeof reply === 'object' && 'fail' in reply) {
      if (reply.fail === 'timeout') await sleep(60_000, options?.signal);
      if (reply.fail === 'garbage') return { choices: [{ message: { content: 'Sure! Here are some offers: INV-1, INV-2' } }] };
      throw Object.assign(new Error(reply.fail === 402 ? 'You have exceeded your monthly included credits' : `HTTP ${reply.fail}`), {
        httpResponse: { status: reply.fail },
      });
    }
    const body = typeof reply === 'function' ? reply(question) : reply;
    return { choices: [{ message: { content: JSON.stringify(body) } }], usage: { prompt_tokens: 900, completion_tokens: 40 } };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    });
  });
}

/** Parses an SSE body into frames. */
export function parseSse(text: string): { event: string; id: string; data: Record<string, unknown> }[] {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const get = (k: string) => lines.filter((l) => l.startsWith(`${k}:`)).map((l) => l.slice(k.length + 1).trim()).join('\n');
      return { event: get('event'), id: get('id'), data: JSON.parse(get('data') || '{}') as Record<string, unknown> };
    });
}
