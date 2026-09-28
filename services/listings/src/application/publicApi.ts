// Public website API (US-33, LLD §4.8, §8): reads only public_item and change_feed. Filters work on stored values
// (vocabulary-validated, labels rejected); cursors are opaque and bound to the query; the change feed has 30 days.
import { canonicalValue } from '@11e/vocabulary';
import type { VocabularyField } from '@11e/vocabulary';
import { periodEnd } from '../domain/projection.js';
import type { PublicSubjectType } from '../domain/types.js';
import { AppError } from './context.js';
import type { Services } from './context.js';
import type { ChangeRow, PublicCursor, PublicItemRow, PublicListFilter } from './ports.js';

export const FEED_RETENTION_DAYS = 30;

const vocab = (field: VocabularyField, param: string, raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  const v = canonicalValue(field, raw);
  if (!v) {
    throw new AppError(400, 'unknown-vocabulary-value', `${param} is not a value of the active vocabulary`, [
      { field: param, code: 'unknown-vocabulary-value' },
    ]);
  }
  return v;
};

export interface RawListQuery {
  dealType?: string | undefined;
  market?: string | undefined;
  segment?: string | undefined;
  propertyType?: string | undefined;
  city?: string | undefined;
  micromarket?: string | undefined;
  locality?: string | undefined;
  bhkMin?: number | undefined;
  bhkMax?: number | undefined;
  areaSqftMin?: number | undefined;
  areaSqftMax?: number | undefined;
  salePriceInrMax?: number | undefined;
  rentMonthlyInrMax?: number | undefined;
  priceInrMax?: number | undefined;
  possessionBy?: string | undefined;
  saleMode?: string | undefined;
  tenancyStatus?: string | undefined;
  furnishing?: string | undefined;
  level?: 'Anonymous' | 'Public' | undefined;
  projectPublicId?: string | undefined;
  sort?: 'newest' | 'priceAsc' | 'priceDesc' | undefined;
}

/** Validates and canonicalises the filters of a public list (400 unknown-vocabulary-value, sort-requires-deal-type). */
export function listFilter(subjectType: PublicSubjectType, q: RawListQuery): PublicListFilter {
  const sort = q.sort ?? 'newest';
  if (sort !== 'newest' && !q.dealType)
    throw new AppError(400, 'sort-requires-deal-type', 'priceAsc/priceDesc need dealType', [
      { field: 'sort', code: 'sort-requires-deal-type' },
    ]);
  let possessionBy: string | undefined;
  if (q.possessionBy !== undefined) {
    const end = periodEnd(q.possessionBy);
    if (!end)
      throw new AppError(400, 'validation-failed', 'possessionBy must be YYYY, YYYY-MM or YYYY-MM-DD', [
        { field: 'possessionBy', code: 'format' },
      ]);
    possessionBy = end;
  }
  return {
    subjectType,
    dealType: vocab('deal_type', 'dealType', q.dealType),
    market: vocab('market', 'market', q.market),
    segment: vocab('segment', 'segment', q.segment),
    propertyType: vocab('property_type', 'propertyType', q.propertyType),
    city: q.city,
    micromarket: q.micromarket,
    locality: q.locality,
    bhkMin: q.bhkMin,
    bhkMax: q.bhkMax,
    areaSqftMin: q.areaSqftMin,
    areaSqftMax: q.areaSqftMax,
    salePriceInrMax: q.salePriceInrMax,
    rentMonthlyInrMax: q.rentMonthlyInrMax,
    priceInrMax: q.priceInrMax,
    possessionBy,
    saleMode: vocab('sale_mode', 'saleMode', q.saleMode),
    tenancyStatus: vocab('tenancy_status', 'tenancyStatus', q.tenancyStatus),
    furnishing: vocab('furnishing', 'furnishing', q.furnishing),
    level: q.level,
    projectPublicId: q.projectPublicId,
    sort,
  };
}

/** Short fingerprint of a filter: a cursor from another query is rejected (invalid-cursor). */
export const queryFingerprint = (s: Services, f: PublicListFilter) =>
  s.sha256(JSON.stringify({ ...f, sort: f.sort })).slice(0, 12);

export interface PublicPage {
  items: PublicItemRow[];
  next: PublicCursor | null;
}

export async function listPublic(
  s: Services,
  tenantId: string,
  correlationId: string,
  filter: PublicListFilter,
  limit: number,
  after: PublicCursor | undefined,
): Promise<PublicPage> {
  return s.uow.run(tenantId, correlationId, async (store) => {
    const rows = await store.listPublicItems(filter, limit + 1, after);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    let next: PublicCursor | null = null;
    if (rows.length > limit && last) {
      next =
        filter.sort === 'newest'
          ? { t: last.publishedAt.toISOString(), id: last.id }
          : {
              p: last.priceSortInr === null ? null : String(last.priceSortInr),
              t: last.publishedAt.toISOString(),
              id: last.id,
            };
    }
    return { items, next };
  });
}

export async function getPublic(
  s: Services,
  tenantId: string,
  correlationId: string,
  subjectType: PublicSubjectType,
  publicId: string,
): Promise<PublicItemRow> {
  return s.uow.run(tenantId, correlationId, async (store) => {
    const item = await store.getPublicItemByPublicId(subjectType, publicId);
    if (!item) throw new AppError(404, 'not-found', 'not currently published');
    return item;
  });
}

// ---- change feed ---------------------------------------------------------------------------------------------------

export interface FeedPosition {
  /** Resume after this sequence number. */
  seq: number;
  /** When the position was taken (retention check). */
  at: string;
}

export interface FeedPage {
  items: ChangeRow[];
  next: FeedPosition;
  hasMore: boolean;
}

/**
 * `since` is the previous nextCursor (preferred) or an ISO date-time. Older than 30 days → 410 change-feed-expired.
 * Rows younger than `settleMs` are held back so a transaction that committed late can't be skipped.
 */
export async function listChanges(
  s: Services,
  tenantId: string,
  correlationId: string,
  since: FeedPosition | { time: Date },
  limit: number,
  settleMs: number,
): Promise<FeedPage> {
  const now = s.clock.now();
  const horizon = new Date(now.getTime() - FEED_RETENTION_DAYS * 86_400_000);
  const sinceTime = 'time' in since ? since.time : new Date(since.at);
  if (sinceTime < horizon)
    throw new AppError(410, 'change-feed-expired', 'older than 30 days: resync from the list endpoints');
  return s.uow.run(tenantId, correlationId, async (store) => {
    let after: number;
    if ('time' in since) {
      const first = await store.firstChangeAtOrAfter(since.time);
      after = first === undefined ? await store.lastChangeSeq() : first - 1;
    } else {
      after = since.seq;
    }
    const notAfter = new Date(now.getTime() - settleMs);
    const rows = await store.changesAfter(after, limit + 1, notAfter);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      next: { seq: last ? last.seq : after, at: (last ? last.occurredAt : notAfter).toISOString() },
      hasMore: rows.length > limit,
    };
  });
}
