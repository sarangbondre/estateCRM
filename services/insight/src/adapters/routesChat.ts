// Chat routes (contract tag chat): conversations private to their author (R-17), the SSE answer stream with a stored
// replay for the same Idempotency-Key, 413 for text over 2,000 characters, and a 15 s stream cap.
import type { MiddlewareHandler } from 'hono';
import { streamSSE } from 'hono/streaming';
import { beginIdempotent, completeIdempotent, hashRequest, releaseIdempotent } from '@11e/db';
import type { operations } from '@11e/contracts/insight';
import { HttpError, conflict, decodeCursor, forbidden, idempotent, notFound, pageLimit, toPage } from '@11e/http';
import type { Service, ServiceContext, ServiceEnv } from '@11e/http';
import { askQuestion } from '../application/chat.js';
import type { StreamEvent } from '../application/chat.js';
import type { ConversationRow, StoredMessage } from '../application/ports.js';
import type { AppDeps } from '../deps.js';
import { callerOf } from './routes.js';
import type { Wired } from './wiring.js';

export const STREAM_CAP_MS = 15_000;
const MAX_TEXT = 2_000;

const conversationJson = (c: ConversationRow) => ({
  conversationId: c.id,
  code: c.code,
  title: c.title,
  createdAt: c.createdAt.toISOString(),
  lastMessageAt: c.lastMessageAt.toISOString(),
  messageCount: c.messageCount,
});

const statusOf = (outcome: string | null) => (outcome === 'refused' ? 'refused' : outcome === 'error' ? 'error' : 'complete');

const messageJson = (m: StoredMessage) => ({
  messageId: m.id,
  role: m.role,
  text: m.text,
  cards: m.cards,
  howIGotThis: m.howIGotThis ?? null,
  fallbackUsed: m.fallbackUsed,
  ...(m.role === 'assistant' ? { status: statusOf(m.outcome) } : {}),
  createdAt: m.createdAt.toISOString(),
});

/** 413 payload-too-large before contract validation (which would otherwise answer 400 for maxLength). */
const textLimit: MiddlewareHandler<ServiceEnv> = async (c, next) => {
  try {
    const body = JSON.parse(await c.req.text()) as { text?: unknown };
    if (typeof body.text === 'string' && body.text.length > MAX_TEXT)
      throw new HttpError(413, 'payload-too-large', { detail: 'text is longer than 2,000 characters' });
  } catch (err) {
    if (err instanceof HttpError) throw err;
  }
  await next();
};

export function registerChatRoutes(svc: Service<operations>, deps: AppDeps, wired: Wired): void {
  const repo = wired.conversations;

  /** The caller's own conversation: 404 unknown, 403 another user's (R-17). */
  async function own(c: ServiceContext, idOrCode: string) {
    const caller = callerOf(c);
    const conv = await repo.find(caller.tenantId, idOrCode);
    if (!conv) throw notFound();
    if (conv.userId !== caller.userId) throw forbidden('conversations are private to their author');
    return { caller, conv };
  }

  svc.op('listConversations', async (c, { query }) => {
    const caller = callerOf(c);
    const limit = pageLimit(query.limit);
    const after = decodeCursor<{ k: string; id: string }>(query.cursor);
    const rows = await repo.list(caller.tenantId, caller.userId, limit, after);
    const page = toPage(rows, limit, (r) => ({ k: r.lastMessageAt.toISOString(), id: r.id }));
    return c.json({ items: page.items.map(conversationJson), nextCursor: page.nextCursor }, 200);
  });

  svc.op('createConversation', async (c, { body }) => {
    const caller = callerOf(c);
    return idempotent(c, deps.db, caller, body ?? {}, async () => {
      const raw = body?.title?.trim();
      const title = raw ? wired.chat.redactor.redact(raw, []).text : 'New chat';
      const conv = await repo.create(caller.tenantId, caller.userId, title, deps.clock.now());
      return { status: 201, body: conversationJson(conv) };
    });
  });

  svc.op('getConversation', async (c, { params }) => {
    const { conv } = await own(c, params.conversationId);
    return c.json(conversationJson(conv), 200);
  });

  svc.op('deleteConversation', async (c, { params }) => {
    const caller = callerOf(c);
    const conv = await repo.find(caller.tenantId, params.conversationId, true);
    if (!conv) throw notFound();
    if (conv.userId !== caller.userId) throw forbidden('conversations are private to their author');
    if (!conv.deleted) await repo.softDelete(caller.tenantId, conv.id, deps.clock.now());
    return c.body(null, 204);
  });

  svc.op('listMessages', async (c, { params, query }) => {
    const { caller, conv } = await own(c, params.conversationId);
    const limit = pageLimit(query.limit);
    const after = decodeCursor<{ k: string; id: string }>(query.cursor);
    const rows = await repo.messages(caller.tenantId, conv.id, limit, after);
    const page = toPage(rows, limit, (r) => ({ k: r.createdAt.toISOString(), id: r.id }));
    return c.json({ items: page.items.map(messageJson), nextCursor: page.nextCursor }, 200);
  });

  svc.op(
    'postMessage',
    async (c, { params, body }) => {
      const { caller, conv } = await own(c, params.conversationId);
      const key = c.req.header('idempotency-key');
      const ref = key ? { tenantId: caller.tenantId, userId: caller.userId, route: 'POST /v1/chat/conversations/{conversationId}/messages', key } : null;
      let replay: StoredMessage | null = null;
      if (ref) {
        const begin = await beginIdempotent(deps.db, ref, hashRequest({ conversationId: conv.id, body }));
        if (begin.outcome === 'conflict') throw conflict('idempotency-key-reused');
        if (begin.outcome === 'in-progress')
          throw new HttpError(409, 'conflict', { detail: 'this message is still being answered', headers: { 'retry-after': '1' } });
        if (begin.outcome === 'replay') {
          const id = (begin.body as { messageId?: string } | null)?.messageId;
          replay = id ? await repo.message(caller.tenantId, id) : null;
          if (!replay) throw notFound();
        }
      }
      const correlationId = c.get('correlationId');
      const log = deps.obs.loggerFor(c);
      return streamSSE(c, async (stream) => {
        let seq = 0;
        let closed = false;
        let chain = Promise.resolve();
        const emit = (e: StreamEvent) => {
          if (closed) return;
          const id = String(++seq);
          chain = chain.then(() => stream.writeSSE({ event: e.type, data: JSON.stringify(e), id }));
        };
        if (replay) {
          // A replay never re-runs the model or the query: plan → card(s) → token (whole text) → done.
          const how = replay.howIGotThis as Extract<StreamEvent, { type: 'plan' }>['howIGotThis'] | null;
          if (how) emit({ type: 'plan', howIGotThis: how });
          for (const card of replay.cards as Record<string, unknown>[]) emit({ type: 'card', card });
          if (replay.text) emit({ type: 'token', text: replay.text.slice(0, 400) });
          emit({
            type: 'done',
            messageId: replay.id,
            outcome: (['answered', 'action_proposed', 'clarify', 'refused'].includes(replay.outcome ?? '') ? replay.outcome : 'answered') as 'answered',
            fallbackUsed: replay.fallbackUsed,
            model: replay.model,
            timings: { redactMs: 0, planMs: 0, queryMs: 0, firstTokenMs: 0, totalMs: 0, ...(replay.timings ?? {}) },
          });
          await chain;
          return;
        }
        const deadline = Date.now() + STREAM_CAP_MS;
        let timer: NodeJS.Timeout | undefined;
        const cap = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), STREAM_CAP_MS);
        });
        const run = askQuestion(
          wired.chat,
          caller,
          conv,
          { text: body.text, context: body.context, idempotencyKey: key ?? null, correlationId, deadline },
          emit,
        );
        try {
          const r = await Promise.race([run, cap]);
          if (r === 'timeout') {
            emit({ type: 'error', code: 'query-timeout', title: 'The answer took too long', correlationId });
            closed = true;
            if (ref) await releaseIdempotent(deps.db, ref);
            void run.catch(() => undefined);
          } else {
            if (ref) await completeIdempotent(deps.db, ref, 200, { messageId: r.messageId });
            log.info({ outcome: r.outcome }, 'chat answered');
          }
        } catch (err) {
          log.error({ err: err as Error, code: 'chat-failed' }, 'chat stream failed');
          emit({ type: 'error', code: 'internal', title: 'Something went wrong', correlationId });
          if (ref) await releaseIdempotent(deps.db, ref);
        } finally {
          clearTimeout(timer);
          await chain;
        }
      });
    },
    textLimit,
  );
}
