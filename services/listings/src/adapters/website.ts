// Website clients (R-1, LLD §4.10, §8): X-Api-Key resolution with a 30 s positive cache per instance, and the per-key
// token bucket in listings.rate_limit_bucket, leased in blocks of 10 tokens per DB round trip.
import { sql, withTransaction } from '@11e/db';
import type { Kysely } from '@11e/db';
import { hashApiKey } from '@11e/auth';
import { looksLikeApiKey } from '../application/admin.js';
import type { ListingsDb } from './db.js';

interface CachedKey {
  tenantId: string;
  keyId: string;
  rps: number;
  burst: number;
  expires: number;
}

export interface WebsiteAuth {
  verify(key: string): Promise<{ tenantId: string; keyId: string } | null>;
  limitsOf(keyId: string): { rps: number; burst: number } | undefined;
  /** Drops cached entries (revoke/rotate on this instance). */
  invalidate(): void;
}

export function createWebsiteAuth(
  db: Kysely<ListingsDb>,
  options: { cacheTtlMs?: number; now?: () => number } = {},
): WebsiteAuth {
  const ttl = options.cacheTtlMs ?? 30_000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CachedKey>();
  const byId = new Map<string, CachedKey>();
  const lastUsedWrite = new Map<string, number>();
  return {
    async verify(key) {
      if (!looksLikeApiKey(key)) return null;
      const hash = hashApiKey(key);
      const hit = cache.get(hash);
      if (hit && hit.expires > now()) return { tenantId: hit.tenantId, keyId: hit.keyId };
      const row = await db
        .selectFrom('api_key')
        .select(['id', 'tenant_id', 'status', 'grace_ends_at', 'rate_limit_rps', 'burst'])
        .where('key_hash', '=', hash)
        .executeTakeFirst();
      const valid =
        row &&
        (row.status === 'active' ||
          (row.status === 'rotating' && row.grace_ends_at !== null && row.grace_ends_at.getTime() > now()));
      if (!row || !valid) {
        cache.delete(hash);
        return null;
      }
      const entry = {
        tenantId: row.tenant_id,
        keyId: row.id,
        rps: row.rate_limit_rps,
        burst: row.burst,
        expires: now() + ttl,
      };
      cache.set(hash, entry);
      byId.set(row.id, entry);
      // last_used_at at most once a minute per instance.
      if ((lastUsedWrite.get(row.id) ?? 0) < now() - 60_000) {
        lastUsedWrite.set(row.id, now());
        await db
          .updateTable('api_key')
          .set({ last_used_at: new Date(now()) })
          .where('id', '=', row.id)
          .execute();
      }
      return { tenantId: row.tenant_id, keyId: row.id };
    },
    limitsOf: (keyId) => byId.get(keyId),
    invalidate() {
      cache.clear();
    },
  };
}

export interface RateDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

export interface RateLimiter {
  take(tenantId: string, keyId: string, limits: { rps: number; burst: number }): Promise<RateDecision>;
}

const LEASE = 10;

/** Postgres token bucket (R-1). Each instance leases up to 10 tokens per round trip to cut writes. */
export function createRateLimiter(db: Kysely<ListingsDb>): RateLimiter {
  const leases = new Map<string, number>();
  return {
    async take(tenantId, keyId, { rps, burst }) {
      const local = leases.get(keyId) ?? 0;
      if (local > 0) {
        leases.set(keyId, local - 1);
        return { allowed: true, remaining: local - 1, retryAfterSec: 0 };
      }
      const left = await withTransaction(db, async (trx) => {
        await sql`insert into rate_limit_bucket (api_key_id, tenant_id, tokens, refilled_at)
                  values (${keyId}, ${tenantId}, ${burst}, now()) on conflict (api_key_id) do nothing`.execute(
          trx,
        );
        const r = await sql<{ tokens: string }>`
          update rate_limit_bucket
             set tokens = least(${burst}::numeric, tokens + extract(epoch from (now() - refilled_at)) * ${rps}),
                 refilled_at = now()
           where api_key_id = ${keyId}
          returning tokens`.execute(trx);
        const available = Math.floor(Number(r.rows[0]?.tokens ?? 0));
        const granted = Math.min(LEASE, available);
        if (granted > 0)
          await sql`update rate_limit_bucket set tokens = tokens - ${granted} where api_key_id = ${keyId}`.execute(
            trx,
          );
        return { granted, bucket: available - granted };
      });
      if (left.granted === 0)
        return { allowed: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil(1 / rps)) };
      leases.set(keyId, left.granted - 1);
      return { allowed: true, remaining: left.granted - 1 + left.bucket, retryAfterSec: 0 };
    },
  };
}
