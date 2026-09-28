// Public website API routes (US-33): per-key rate limit (R-1), edge-cache headers, cursors bound to the query.
import type { operations } from '@11e/contracts/listings';
import { HttpError } from '@11e/http';
import type { Service, ServiceContext } from '@11e/http';
import { principalOf } from '@11e/auth';
import type { PublicCursor } from '../application/ports.js';
import {
  getPublic,
  listChanges,
  listFilter,
  listPublic,
  queryFingerprint,
} from '../application/publicApi.js';
import type { FeedPosition, RawListQuery } from '../application/publicApi.js';
import type { PublicSubjectType } from '../domain/types.js';
import type { AppDeps } from '../deps.js';
import { decode, encode, invalidCursor, run } from './http-support.js';

const EDGE_CACHE = 'public, s-maxage=20, stale-while-revalidate=10';
const FEED_CACHE = 'public, s-maxage=5';

export function registerPublicRoutes(svc: Service<operations>, deps: AppDeps): void {
  const s = deps.services;

  // --- public website API
  const website = async (c: ServiceContext) => {
    const p = principalOf(c);
    if (p.kind !== 'website') throw new HttpError(401, 'unauthenticated');
    const limits = deps.website.limitsOf(p.keyId) ?? { rps: 50, burst: 100 };
    const d = await deps.rateLimiter.take(p.tenantId, p.keyId, limits);
    if (!d.allowed)
      throw new HttpError(429, 'rate-limited', { headers: { 'retry-after': String(d.retryAfterSec) } });
    c.header('x-ratelimit-remaining', String(d.remaining));
    return p.tenantId;
  };
  const cacheable = (c: ServiceContext, value = EDGE_CACHE) => {
    c.header('cache-control', value);
    c.header('vary', 'X-Api-Key');
  };

  const publicList = async (
    c: ServiceContext,
    subjectType: PublicSubjectType,
    raw: RawListQuery,
    limitParam: number | undefined,
    cursor: string | undefined,
  ) => {
    const tenantId = await website(c);
    const filter = await run(async () => listFilter(subjectType, raw));
    const q = queryFingerprint(s, filter);
    const pos = decode(cursor);
    let after: PublicCursor | undefined;
    if (pos) {
      if (pos['q'] !== q || typeof pos['id'] !== 'string' || typeof pos['t'] !== 'string')
        throw invalidCursor();
      after = {
        t: pos['t'],
        id: pos['id'],
        ...(filter.sort !== 'newest' ? { p: (pos['p'] as string | null) ?? null } : {}),
      };
    }
    const limit = Math.min(50, Math.max(1, limitParam ?? 25));
    const page = await run(() => listPublic(s, tenantId, c.get('correlationId'), filter, limit, after));
    cacheable(c);
    return c.json({
      items: page.items.map((i) => i.payload),
      nextCursor: page.next ? encode({ q, ...page.next }) : null,
    });
  };

  svc.op('publicListOffers', (c, { query }) => {
    const { limit, cursor, ...raw } = query;
    return publicList(c, 'listing', raw, limit, cursor);
  });
  svc.op('publicListProjects', (c, { query }) => {
    const { limit, cursor, ...raw } = query;
    return publicList(c, 'project', raw, limit, cursor);
  });
  svc.op('publicListDemandPosts', (c, { query }) => {
    const { limit, cursor, ...raw } = query;
    return publicList(c, 'demand_post', raw, limit, cursor);
  });
  const publicGet = async (c: ServiceContext, type: PublicSubjectType, publicId: string) => {
    const tenantId = await website(c);
    const item = await run(() => getPublic(s, tenantId, c.get('correlationId'), type, publicId));
    cacheable(c);
    return c.json(item.payload);
  };
  svc.op('publicGetOffer', (c, { params }) => publicGet(c, 'listing', params.publicId));
  svc.op('publicGetProject', (c, { params }) => publicGet(c, 'project', params.publicId));

  svc.op('publicListChanges', async (c, { query }) => {
    const tenantId = await website(c);
    const since = parseSince(query.since);
    const page = await run(() =>
      listChanges(s, tenantId, c.get('correlationId'), since, query.limit ?? 100, deps.config.feedSettleMs),
    );
    cacheable(c, FEED_CACHE);
    return c.json({
      items: page.items.map((r) => ({
        changeType: r.changeType,
        subjectType: r.subjectType,
        publicId: r.publicId,
        level: r.level,
        occurredAt: r.occurredAt.toISOString(),
      })),
      nextCursor: encode({ s: page.next.seq, t: page.next.at }),
      hasMore: page.hasMore,
    });
  });
}

/** `since` = a previous nextCursor, or an ISO date-time for the first call. */
function parseSince(since: string): FeedPosition | { time: Date } {
  if (/^\d{4}-\d{2}-\d{2}T/.test(since)) {
    const t = Date.parse(since);
    if (Number.isNaN(t)) throw invalidCursor();
    return { time: new Date(t) };
  }
  const v = decode(since);
  if (!v || typeof v['s'] !== 'number' || typeof v['t'] !== 'string' || Number.isNaN(Date.parse(v['t'])))
    throw invalidCursor();
  return { seq: v['s'], at: v['t'] };
}
