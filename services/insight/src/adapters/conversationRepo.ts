// Conversations and messages (LLD §3.3): redacted text only (PII-possible columns are never logged), private to the
// author (R-17). Lists use keyset cursors on the §3.3 indexes.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { tenantScope } from '@11e/db';
import type { ConversationRepo, ConversationRow, StoredMessage } from '../application/ports.js';
import type { InsightDb } from './db.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ConvDb = {
  id: string;
  code: string;
  user_id: string;
  title: string;
  message_count: number;
  last_message_at: Date;
  created_at: Date;
};
const toConv = (r: ConvDb): ConversationRow => ({
  id: r.id,
  code: r.code,
  userId: r.user_id,
  title: r.title,
  messageCount: r.message_count,
  lastMessageAt: r.last_message_at,
  createdAt: r.created_at,
});

type MsgDb = {
  id: string;
  role: 'user' | 'assistant';
  redacted_text: string;
  cards: unknown;
  how_i_got_this: unknown;
  outcome: string | null;
  fallback_used: boolean;
  model: string | null;
  timings: unknown;
  created_at: Date;
};
const toMsg = (r: MsgDb): StoredMessage => ({
  id: r.id,
  role: r.role,
  text: r.redacted_text,
  cards: Array.isArray(r.cards) ? r.cards : [],
  howIGotThis: r.how_i_got_this ?? null,
  outcome: r.outcome,
  fallbackUsed: r.fallback_used,
  model: r.model,
  timings: (r.timings as Record<string, number> | null) ?? null,
  createdAt: r.created_at,
});

export async function nextCode(db: Kysely<InsightDb>, tenantId: string, prefix: 'CONV' | 'EXP', width: number): Promise<string> {
  const r = await sql<{ v: number }>`
    insert into code_sequence (tenant_id, prefix, next_value) values (${tenantId}, ${prefix}, 2)
    on conflict (tenant_id, prefix) do update set next_value = code_sequence.next_value + 1, updated_at = now()
    returning next_value - 1 as v`.execute(db);
  return `${prefix}-${String(r.rows[0]?.v ?? 1).padStart(width, '0')}`;
}

const CONV_COLS = ['id', 'code', 'user_id', 'title', 'message_count', 'last_message_at', 'created_at'] as const;
const MSG_COLS = ['id', 'role', 'redacted_text', 'cards', 'how_i_got_this', 'outcome', 'fallback_used', 'model', 'timings', 'created_at'] as const;

export function createConversationRepo(db: Kysely<InsightDb>, newId: () => string): ConversationRepo {
  return {
    async create(tenantId, userId, title, now) {
      const code = await nextCode(db, tenantId, 'CONV', 6);
      const id = newId();
      await tenantScope(db, tenantId)
        .insertInto('conversation', { id, code, user_id: userId, title, message_count: 0, last_message_at: now, created_at: now, updated_at: now })
        .execute();
      return { id, code, userId, title, messageCount: 0, lastMessageAt: now, createdAt: now };
    },
    async find(tenantId, idOrCode, includeDeleted = false) {
      let q = tenantScope(db, tenantId).selectFrom('conversation').select([...CONV_COLS, 'deleted_at']);
      if (!includeDeleted) q = q.where('deleted_at', 'is', null);
      q = UUID.test(idOrCode) ? q.where('id', '=', idOrCode) : q.where('code', '=', idOrCode.toUpperCase());
      const r = await q.executeTakeFirst();
      return r ? { ...toConv(r as ConvDb), ...(r.deleted_at ? { deleted: true } : {}) } : null;
    },
    async list(tenantId, userId, limit, after) {
      let q = tenantScope(db, tenantId)
        .selectFrom('conversation')
        .select(CONV_COLS)
        .where('user_id', '=', userId)
        .where('deleted_at', 'is', null);
      if (after) q = q.where(sql<boolean>`(last_message_at, id) < (${new Date(after.k)}, ${after.id}::uuid)`);
      const rows = await q.orderBy('last_message_at', 'desc').orderBy('id', 'desc').limit(limit + 1).execute();
      return rows.map((r) => toConv(r as ConvDb));
    },
    async softDelete(tenantId, id, now) {
      await tenantScope(db, tenantId).updateTable('conversation').set({ deleted_at: now, updated_at: now }).where('id', '=', id).execute();
    },
    async history(tenantId, conversationId, turns) {
      const rows = await tenantScope(db, tenantId)
        .selectFrom('message')
        .select(['role', 'redacted_text'])
        .where('conversation_id', '=', conversationId)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(turns * 2)
        .execute();
      return rows.reverse().map((r) => ({ role: r.role, text: r.redacted_text }));
    },
    async messages(tenantId, conversationId, limit, after) {
      let q = tenantScope(db, tenantId).selectFrom('message').select(MSG_COLS).where('conversation_id', '=', conversationId);
      if (after) q = q.where(sql<boolean>`(created_at, id) > (${new Date(after.k)}, ${after.id}::uuid)`);
      const rows = await q.orderBy('created_at', 'asc').orderBy('id', 'asc').limit(limit + 1).execute();
      return rows.map((r) => toMsg(r as MsgDb));
    },
    async message(tenantId, id) {
      const r = await tenantScope(db, tenantId).selectFrom('message').select(MSG_COLS).where('id', '=', id).executeTakeFirst();
      return r ? toMsg(r as MsgDb) : null;
    },
    async saveExchange(tenantId, conversationId, messages, titleIfDefault, now) {
      await db.transaction().execute(async (trx) => {
        const t = tenantScope(trx, tenantId);
        // user message first, the assistant 1 ms later: the list order is (created_at, id)
        await t
          .insertInto(
            'message',
            messages.map((m, i) => ({
              id: m.id,
              conversation_id: conversationId,
              role: m.role,
              redacted_text: m.text,
              redaction_counts: JSON.stringify(m.redactionCounts ?? {}),
              plan: m.plan === undefined ? null : JSON.stringify(m.plan),
              how_i_got_this: m.howIGotThis === undefined ? null : JSON.stringify(m.howIGotThis),
              cards: JSON.stringify(m.cards ?? []),
              outcome: m.outcome ?? null,
              fallback_used: m.fallbackUsed ?? false,
              model: m.model ?? null,
              timings: m.timings ? JSON.stringify(m.timings) : null,
              idempotency_key: m.role === 'user' ? (m.idempotencyKey ?? null) : null,
              created_at: new Date(now.getTime() + i),
              updated_at: now,
            })),
          )
          .execute();
        await sql`update conversation set message_count = message_count + ${messages.length}, last_message_at = ${now},
            title = case when title = 'New chat' then ${titleIfDefault} else title end, updated_at = now()
          where tenant_id = ${tenantId} and id = ${conversationId}`.execute(trx);
      });
    },
    async purge(now, retentionDays, batch) {
      const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
      const r = await sql<{ tenant_id: string; id: string }>`
        select tenant_id, id from conversation
         where deleted_at is not null or last_message_at < ${cutoff}
         limit ${batch}`.execute(db);
      for (const c of r.rows) {
        await db.transaction().execute(async (trx) => {
          await sql`delete from message where tenant_id = ${c.tenant_id} and conversation_id = ${c.id}`.execute(trx);
          await sql`delete from conversation where tenant_id = ${c.tenant_id} and id = ${c.id}`.execute(trx);
        });
      }
      return r.rows.length;
    },
  };
}
