// Classification review queue (LLD §4.11, US-07a AC5, C-05): list and group by reason code, resolve one or many.
// set = apply the given classification (merged over current, validated against the vocabulary); confirm = accept
// current; discard = not a real record (records voids it); all three → resolved + review_item.resolved.v1 with the
// final classification. skip → skipped, no event. raw_rows are never modified by review (US-01 AC5).
import { validateClassification } from '@11e/vocabulary';
import { IntakeError, notFound } from '../domain/errors.js';
import type { FieldIssue } from '../domain/errors.js';
import type { App, StaffActor } from './context.js';
import type { Position, ReviewItem, ReviewListFilter, Tx } from './ports.js';

export interface ClassificationInput {
  recordScope?: string | null | undefined;
  side?: string | null | undefined;
  dealTypes?: string[] | undefined;
  market?: string | null | undefined;
  segment?: string | null | undefined;
  propertyTypes?: string[] | undefined;
}

export type ResolveAction = 'set' | 'confirm' | 'discard' | 'skip';

export async function listReviewItems(
  app: App,
  tenantId: string,
  filter: ReviewListFilter,
  after: Position | undefined,
  limit: number,
): Promise<{ items: ReviewItem[]; codes: Map<string, string> }> {
  const items = await app.uow.repos.reviews.list(tenantId, filter, after, limit + 1);
  const codes = await app.uow.repos.uploads.codes(
    tenantId,
    items.map((i) => i.uploadId),
  );
  return { items, codes };
}

export async function getReviewItem(app: App, tenantId: string, id: string) {
  const item = await app.uow.repos.reviews.find(tenantId, id);
  if (!item) throw notFound('review item');
  const codes = await app.uow.repos.uploads.codes(tenantId, [item.uploadId]);
  return { item, uploadCode: codes.get(item.uploadId) };
}

export const getReviewSummary = (app: App, tenantId: string, uploadId: string | undefined) =>
  app.uow.repos.reviews.summary(tenantId, uploadId);

/** current merged with the set fields, then the BRD §4.2 cross-field rules (400 classification-invalid). */
export function finalClassification(current: Record<string, unknown>, set: ClassificationInput | undefined) {
  const merged: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(set ?? {})) if (v !== undefined) merged[k] = v;
  const r = validateClassification({
    recordScope: (merged['recordScope'] as string | null) ?? null,
    dealType: ((merged['dealTypes'] as string[] | undefined) ?? []).join('|') || null,
    market: (merged['market'] as string | null) ?? null,
    segment: (merged['segment'] as string | null) ?? null,
    propertyType: ((merged['propertyTypes'] as string[] | undefined) ?? []).join('|') || null,
    landUse: (merged['landUse'] as string | null) ?? null,
    side: (merged['side'] as string | null) ?? null,
  });
  if (!r.ok) {
    const errors: FieldIssue[] = r.issues.map((i) => ({ field: i.field, code: i.code, message: i.message }));
    throw new IntakeError('classification-invalid', 'the classification breaks the vocabulary rules', errors);
  }
  return {
    recordScope: r.value.recordScope,
    side: r.value.side,
    dealTypes: [...r.value.dealTypes],
    market: r.value.market,
    segment: r.value.segment,
    propertyTypes: [...r.value.propertyTypes],
  };
}

async function resolveInTx(
  tx: Tx,
  actor: StaffActor,
  id: string,
  action: ResolveAction,
  set: ClassificationInput | undefined,
  note: string | undefined,
  ifMatch: number | undefined,
): Promise<ReviewItem> {
  const item = await tx.repos.reviews.find(actor.tenantId, id, { forUpdate: true });
  if (!item) throw notFound('review item');
  if (ifMatch !== undefined && ifMatch !== item.version) throw new IntakeError('version-mismatch');
  if (item.status !== 'open')
    throw new IntakeError('review-item-closed', `the review item is ${item.status}`);
  if (action === 'skip') {
    return tx.repos.reviews.close(actor.tenantId, id, {
      status: 'skipped',
      resolution: { action: 'skip' },
      note: note ?? null,
      resolvedBy: actor.userId,
    });
  }
  if (action === 'set' && !set) {
    throw new IntakeError('validation-failed', 'classification is required for set', [
      { field: 'classification', code: 'required' },
    ]);
  }
  const final = finalClassification(item.current, action === 'set' ? set : undefined);
  const closed = await tx.repos.reviews.close(actor.tenantId, id, {
    status: 'resolved',
    resolution: { action, classification: final },
    note: note ?? null,
    resolvedBy: actor.userId,
  });
  const data: Record<string, unknown> = {
    reviewItemId: item.id,
    uploadId: item.uploadId,
    rowId: item.rowId,
    externalRef: item.externalRef,
    action,
    dealTypes: final.dealTypes,
    propertyTypes: final.propertyTypes,
    resolvedBy: actor.userId,
  };
  if (final.recordScope) data['recordScope'] = final.recordScope;
  if (final.side) data['side'] = final.side;
  if (final.market) data['market'] = final.market;
  if (final.segment) data['segment'] = final.segment;
  await tx.events.emit({
    eventType: 'review_item.resolved.v1',
    tenantId: actor.tenantId,
    aggregateType: 'review_item',
    aggregateId: item.id,
    aggregateVersion: closed.version,
    correlationId: actor.correlationId,
    data: data as never,
  });
  return closed;
}

export function resolveReviewItem(
  app: App,
  actor: StaffActor,
  id: string,
  input: {
    action: ResolveAction;
    classification?: ClassificationInput | undefined;
    note?: string | undefined;
  },
  ifMatch: number | undefined,
): Promise<ReviewItem> {
  return app.uow.transaction((tx) =>
    resolveInTx(tx, actor, id, input.action, input.classification, input.note, ifMatch),
  );
}

/** ≤ 100 items, one transaction per item so one failure does not block the others; one event per resolved item. */
export async function bulkResolve(
  app: App,
  actor: StaffActor,
  input: {
    ids: string[];
    action: 'set' | 'confirm' | 'discard';
    classification?: ClassificationInput | undefined;
  },
): Promise<{ resolved: string[]; failed: { id: string; code: string }[] }> {
  const resolved: string[] = [];
  const failed: { id: string; code: string }[] = [];
  for (const id of [...new Set(input.ids)]) {
    try {
      await app.uow.transaction((tx) =>
        resolveInTx(tx, actor, id, input.action, input.classification, undefined, undefined),
      );
      resolved.push(id);
    } catch (err) {
      if (!(err instanceof IntakeError)) throw err;
      failed.push({ id, code: err.code });
    }
  }
  return { resolved, failed };
}
