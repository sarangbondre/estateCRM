// Review queue routes (intake.yaml tag Review; roles Admin, Manager, Data operator via x-roles).
import { idempotent, ifMatchVersion, pageLimit, toPage } from '@11e/http';
import type { Service } from '@11e/http';
import type { Kysely } from '@11e/db';
import type { components, operations } from '@11e/contracts/intake';
import type { App } from '../../application/context.js';
import type { ReviewItem } from '../../application/ports.js';
import * as review from '../../application/review.js';
import type { IntakeDb } from '../db.js';
import { cursorOf, guard, iso, staffActor } from './support.js';

type S = components['schemas'];

export function presentReviewItem(i: ReviewItem, uploadCode: string | undefined): S['ReviewItem'] {
  const cls = (c: Record<string, unknown> | null) =>
    c
      ? ({
          recordScope: c['recordScope'] ?? null,
          side: c['side'] ?? null,
          dealTypes: c['dealTypes'] ?? [],
          market: c['market'] ?? null,
          segment: c['segment'] ?? null,
          propertyTypes: c['propertyTypes'] ?? [],
        } as S['Classification'])
      : null;
  const ctx = i.context;
  return {
    id: i.id,
    uploadId: i.uploadId,
    ...(uploadCode ? { uploadCode } : {}),
    rowId: i.rowId,
    rowNo: i.rowNo,
    externalRef: i.externalRef,
    reasonCode: i.reasonCode as S['ReviewItem']['reasonCode'],
    detailCode: i.detailCode as NonNullable<S['ReviewItem']['detailCode']>,
    reviewReasonText: i.reviewReasonText,
    current: cls(i.current) as S['Classification'],
    suggested: cls(i.suggested),
    context: {
      locality: (ctx['locality'] as string | null) ?? null,
      city: (ctx['city'] as string | null) ?? null,
      priceText: (ctx['priceText'] as string | null) ?? null,
      areaText: (ctx['areaText'] as string | null) ?? null,
      sideEvidence: (ctx['sideEvidence'] as string | null) ?? null,
      redactedText: (ctx['redactedText'] as string | null) ?? null,
    },
    status: i.status,
    resolution:
      i.status === 'resolved' ? ((i.resolution?.action as S['ReviewItem']['resolution']) ?? null) : null,
    resolvedBy: i.resolvedBy,
    resolvedAt: iso(i.resolvedAt),
    createdAt: i.createdAt.toISOString(),
    version: i.version,
  };
}

export function registerReviewRoutes(svc: Service<operations>, app: App, db: Kysely<IntakeDb>): void {
  svc.op('listReviewItems', (c, { query }) =>
    guard(async () => {
      const actor = staffActor(c);
      const limit = pageLimit(query.limit);
      const after = cursorOf(query.cursor, { k: 'string', id: 'string' });
      const { items, codes } = await review.listReviewItems(
        app,
        actor.tenantId,
        {
          status: query.status ?? 'open',
          reasonCode: query.reasonCode,
          detailCode: query.detailCode,
          uploadId: query.uploadId,
        },
        after,
        limit,
      );
      const page = toPage(items, limit, (i) => ({ k: i.createdAt.toISOString(), id: i.id }));
      return c.json({
        items: page.items.map((i) => presentReviewItem(i, codes.get(i.uploadId))),
        nextCursor: page.nextCursor,
      });
    }),
  );

  svc.op('getReviewSummary', (c, { query }) =>
    guard(async () => {
      const actor = staffActor(c);
      const groups = await review.getReviewSummary(app, actor.tenantId, query.uploadId);
      return c.json({
        groups: groups.map((g) => ({
          reasonCode: g.reasonCode as S['ReviewSummary']['groups'][number]['reasonCode'],
          open: g.open,
          oldestAt: iso(g.oldestAt),
        })),
      });
    }),
  );

  svc.op('getReviewItem', (c, { params }) =>
    guard(async () => {
      const actor = staffActor(c);
      const { item, uploadCode } = await review.getReviewItem(app, actor.tenantId, params.id);
      c.header('etag', `"${item.version}"`);
      return c.json(presentReviewItem(item, uploadCode));
    }),
  );

  svc.op('resolveReviewItem', (c, { params, body }) => {
    const actor = staffActor(c);
    const ifMatch = ifMatchVersion(c);
    return idempotent(c, db, actor, { id: params.id, ...body }, () =>
      guard(async () => {
        const item = await review.resolveReviewItem(app, actor, params.id, body, ifMatch);
        const codes = await app.uow.repos.uploads.codes(actor.tenantId, [item.uploadId]);
        return { status: 200, body: presentReviewItem(item, codes.get(item.uploadId)) };
      }),
    );
  });

  svc.op('bulkResolveReviewItems', (c, { body }) => {
    const actor = staffActor(c);
    return idempotent(c, db, actor, body, () =>
      guard(async () => ({ status: 200, body: await review.bulkResolve(app, actor, body) })),
    );
  });
}
