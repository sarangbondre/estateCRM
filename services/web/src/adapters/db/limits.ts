// Rate limits and chat stream leases in Postgres (web LLD §4.4, D-6: no Redis). The `api` bucket takes tokens in blocks
// of 5 per round trip; a DB error or a round trip over 50 ms falls back to an in-memory bucket at half the rates
// (fail-open, A-W4) and is counted as `ratelimit_fallback`.
import { randomUUID } from 'node:crypto';
import { sql, tenantScope } from '@11e/db';
import type { Kysely } from '@11e/db';
import type { RateLimiter, StreamLeases } from '../../application/ports';
import { BUCKETS, retryAfterSec } from '../../domain/routes';
import type { Bucket } from '../../domain/routes';
import type { WebDb } from './schema';

const BLOCK: Partial<Record<Bucket, number>> = { api: 5 };

/** In-memory token bucket (fallback, and the per-instance lease block). */
export class MemoryBucket {
  private readonly state = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly scale = 0.5,
    private readonly now: () => number = Date.now,
  ) {}
  take(key: string, bucket: Bucket, cost = 1): { allowed: boolean; tokens: number } {
    const { rate, burst } = BUCKETS[bucket];
    const r = rate * this.scale;
    const b = Math.max(1, burst * this.scale);
    const t = this.now();
    const s = this.state.get(key) ?? { tokens: b, at: t };
    const tokens = Math.min(b, s.tokens + ((t - s.at) / 1000) * r);
    if (this.state.size > 10_000) this.state.clear();
    if (tokens >= cost) {
      this.state.set(key, { tokens: tokens - cost, at: t });
      return { allowed: true, tokens: tokens - cost };
    }
    this.state.set(key, { tokens, at: t });
    return { allowed: false, tokens };
  }
}

export interface PgRateLimiterOptions {
  timeoutMs?: number;
  onFallback?: (bucket: Bucket) => void;
}

export class PgRateLimiter implements RateLimiter {
  private readonly fallback = new MemoryBucket(0.5);
  /** Tokens this instance already took from the store (lease block), and the store's balance after that take. */
  private readonly blocks = new Map<string, { held: number; store: number }>();
  private readonly timeoutMs: number;

  constructor(
    private readonly db: Kysely<WebDb>,
    private readonly o: PgRateLimiterOptions = {},
  ) {
    this.timeoutMs = o.timeoutMs ?? 50;
  }

  private async takeDb(tenantId: string, subject: string, bucket: Bucket, cost: number) {
    const { rate, burst } = BUCKETS[bucket];
    const q = sql<{ allowed: boolean; tokens: string }>`
      select allowed, tokens from web.take_token(${tenantId}::uuid, ${subject}, ${bucket}, ${rate}, ${burst}, ${cost})`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('rate limit store slow')), this.timeoutMs);
    });
    try {
      const { rows } = await Promise.race([q.execute(this.db), timeout]);
      const row = rows[0];
      return { allowed: Boolean(row?.allowed), tokens: Number(row?.tokens ?? 0) };
    } finally {
      clearTimeout(timer);
    }
  }

  async take(tenantId: string, subject: string, bucket: Bucket, cost = 1) {
    const { burst } = BUCKETS[bucket];
    const key = `${tenantId}|${subject}|${bucket}`;
    const block = BLOCK[bucket] ?? 1;
    const held = this.blocks.get(key);
    if (held && held.held >= cost) {
      held.held -= cost;
      return { allowed: true, remaining: held.store + held.held, limit: burst, retryAfterSec: 0 };
    }
    try {
      let r = await this.takeDb(tenantId, subject, bucket, block > cost ? block : cost);
      if (!r.allowed && block > cost) r = await this.takeDb(tenantId, subject, bucket, cost);
      else if (r.allowed && block > cost) this.blocks.set(key, { held: block - cost, store: r.tokens });
      if (this.blocks.size > 10_000) this.blocks.clear();
      return {
        allowed: r.allowed,
        remaining: r.tokens + (this.blocks.get(key)?.held ?? 0),
        limit: burst,
        retryAfterSec: r.allowed ? 0 : retryAfterSec(bucket, r.tokens, cost),
      };
    } catch {
      this.o.onFallback?.(bucket);
      const r = this.fallback.take(key, bucket, cost);
      return {
        allowed: r.allowed,
        remaining: r.tokens,
        limit: burst,
        retryAfterSec: r.allowed ? 0 : retryAfterSec(bucket, r.tokens, cost),
      };
    }
  }

  /** rate-limit-prune: rows idle > 1 h, bounded. */
  async prune(before: Date, limit: number): Promise<number> {
    const r = await sql<{ n: string }>`
      with doomed as (
        select tenant_id, subject_key, bucket from web.rate_limit_bucket where refilled_at < ${before} limit ${limit}
      )
      delete from web.rate_limit_bucket b using doomed d
       where b.tenant_id = d.tenant_id and b.subject_key = d.subject_key and b.bucket = d.bucket
      returning 1 as n`.execute(this.db);
    return r.rows.length;
  }
}

export class PgStreamLeases implements StreamLeases {
  constructor(private readonly db: Kysely<WebDb>) {}

  async acquire(tenantId: string, userId: string, ttlMs: number): Promise<string | null> {
    const leaseId = randomUUID();
    const expires = new Date(Date.now() + ttlMs);
    const row = await this.db
      .insertInto('chat_stream_lease')
      .values({ tenant_id: tenantId, user_id: userId, lease_id: leaseId, expires_at: expires })
      .onConflict((oc) =>
        oc
          .columns(['tenant_id', 'user_id'])
          .doUpdateSet({ lease_id: leaseId, expires_at: expires })
          .where('chat_stream_lease.expires_at', '<', new Date()),
      )
      .returning('lease_id')
      .executeTakeFirst();
    return row?.lease_id === leaseId ? leaseId : null;
  }

  async release(tenantId: string, userId: string, leaseId: string): Promise<void> {
    await tenantScope(this.db, tenantId)
      .deleteFrom('chat_stream_lease')
      .where('user_id', '=', userId)
      .where('lease_id', '=', leaseId)
      .execute();
  }
}
