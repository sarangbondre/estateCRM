// Chat client for the Answer card (C-02, PRD §5.1): create the insight conversation once per UI conversation, post a
// question and read the Server-Sent Events answer incrementally through web's gateway (/v1/chat, SSE passthrough).
// insight: createConversation, postMessage. Client cap 16 s (server stops at 15 s with event error query-timeout).
import { ApiError, call, newIdempotencyKey } from '../../lib/api';
import type { Problem } from '../../lib/api';
import type { operations } from '@11e/contracts/insight';
import type { Body, Ok } from '../../lib/contract';
import { answerFromMessage, createSseParser, toStreamEvent } from './logic';
import type { AnswerState, StreamEvent } from './logic';

type Conversation = Ok<operations['createConversation']>;

/** UI conversation id → insight conversation id (in memory; each answer card also keeps it in its props). */
const remoteIds = new Map<string, Promise<string>>();

export function rememberRemote(localId: string, remoteId: string): void {
  if (!remoteIds.has(localId)) remoteIds.set(localId, Promise.resolve(remoteId));
}

export function ensureConversation(localId: string, title: string): Promise<string> {
  const known = remoteIds.get(localId);
  if (known) return known;
  const created = call<Conversation>('POST', '/v1/chat/conversations', {
    body: { title: title.slice(0, 120) } satisfies Body<operations['createConversation']>,
    idempotencyKey: newIdempotencyKey(),
  }).then((r) => r.data.conversationId || r.data.code);
  remoteIds.set(localId, created);
  created.catch(() => remoteIds.delete(localId));
  return created;
}

export const CLIENT_TIMEOUT_MS = 16_000;

export class ChatTimeout extends Error {
  constructor() {
    super('client-timeout');
  }
}

/**
 * POST the question and feed every stream event to `onEvent` as it arrives. Resolves when the stream ends (or on the
 * final `done` / `error` event). Throws ApiError for HTTP errors (e.g. 429 one stream at a time) and ChatTimeout.
 * If the server answers with JSON instead of a stream (non-streaming mode), the stored message is returned instead.
 */
export async function streamAnswer(
  remoteId: string,
  text: string,
  idempotencyKey: string,
  onEvent: (ev: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<AnswerState | null> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, CLIENT_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);

  try {
    let res: Response;
    try {
      res = await fetch(`/v1/chat/conversations/${encodeURIComponent(remoteId)}/messages`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          accept: 'text/event-stream, application/json',
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ text } satisfies Body<operations['postMessage']>),
        signal: ctrl.signal,
      });
    } catch (err) {
      if (timedOut) throw new ChatTimeout();
      if ((err as Error).name === 'AbortError') throw err;
      throw new ApiError(0, { code: 'network-error', detail: 'Network error. Check your connection and try again.' });
    }

    const type = res.headers.get('content-type') ?? '';
    if (!res.ok) {
      const problem = ((await res.json().catch(() => undefined)) as Problem | undefined) ?? {
        status: res.status,
        code: `http-${res.status}`,
      };
      // Let the shell's 401 handler run (it listens on `call`): a cheap re-check of the session.
      if (res.status === 401) await call('GET', '/v1/me').catch(() => undefined);
      throw new ApiError(res.status, problem);
    }
    if (type.includes('application/json')) return answerFromMessage(await res.json().catch(() => null));
    if (!res.body) return answerFromMessage(null);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser();
    let final = false;
    const handle = (frames: ReturnType<typeof parser.push>) => {
      for (const f of frames) {
        const ev = toStreamEvent(f);
        if (!ev) continue;
        onEvent(ev);
        if (ev.type === 'done' || ev.type === 'error') final = true;
      }
    };
    try {
      while (!final) {
        const { value, done } = await reader.read();
        if (done) break;
        handle(parser.push(decoder.decode(value, { stream: true })));
      }
      if (!final) handle(parser.push(decoder.decode()).concat(parser.flush()));
    } catch (err) {
      if (timedOut) throw new ChatTimeout();
      throw err;
    } finally {
      if (final) reader.cancel().catch(() => undefined);
    }
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
