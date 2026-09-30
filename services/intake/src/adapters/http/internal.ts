// Internal routes (service tokens; x-callers enforced by libs/auth): batch rows and the migration map for records,
// the crm_notes text of one row for journeys (CR-012). PII, never cached. The response is never logged (the logger has no body fields).
import { toPage } from '@11e/http';
import type { Service } from '@11e/http';
import type { components, operations } from '@11e/contracts/intake';
import type { App } from '../../application/context.js';
import { getBatchRows, getInternalMigrationMap, getRowNote } from '../../application/internal.js';
import type { RawRowRecord } from '../../application/ports.js';
import type { Upload } from '../../domain/upload.js';
import { cursorOf, guard, serviceActor } from './support.js';

type IntakeRow = components['schemas']['IntakeRow'];

/** raw_rows → IntakeRow (Appendix C fields in camelCase + identity and review metadata). */
export function presentIntakeRow(r: RawRowRecord, upload: Upload): IntakeRow {
  const f = { ...r.normalised };
  delete f['reviewReasonCode'];
  return {
    ...(f as Partial<IntakeRow>),
    rowId: r.id,
    rowNo: r.rowNo,
    sheetName: r.sheetName,
    externalSource: r.externalSource,
    externalRef: r.externalRef,
    parentExternalRef: r.parentExternalRef,
    contentHash: r.contentHash,
    needsReview: r.needsReview,
    reviewReasonCode: r.needsReview
      ? ((r.primaryReasonCode ?? 'other') as IntakeRow['reviewReasonCode'])
      : null,
    sourceType: upload.sourceType,
    captureMode: 'uploaded',
    anonymised: r.anonymised,
  } as IntakeRow;
}

export function registerInternalRoutes(svc: Service<operations>, app: App): void {
  svc.op('internalGetUploadRows', (c, { params, query }) =>
    guard(async () => {
      const actor = serviceActor(c);
      const v = await getBatchRows(app, actor.tenantId, params.uploadId, query.batch);
      c.header('cache-control', 'no-store');
      return c.json({
        uploadId: v.upload.id,
        batchNo: v.batchNo,
        anonymised: v.upload.anonymise,
        vocabularyVersion: v.upload.vocabularyVersion ?? '',
        rows: v.rows.map((r) => presentIntakeRow(r, v.upload)),
      });
    }),
  );

  svc.op('internalGetRowNote', (c, { params }) =>
    guard(async () => {
      const actor = serviceActor(c);
      const v = await getRowNote(app, actor.tenantId, params.uploadId, params.rowNo);
      c.header('cache-control', 'no-store');
      return c.json({ uploadId: v.upload.id, uploadCode: v.upload.code, rowNo: v.rowNo, note: v.note });
    }),
  );

  svc.op('internalGetMigrationMap', (c, { params, query }) =>
    guard(async () => {
      const actor = serviceActor(c);
      const limit = Math.min(1000, Math.max(1, query.limit ?? 1000));
      const after = cursorOf(query.cursor, { e: 'number' });
      const rows = await getInternalMigrationMap(app, actor.tenantId, params.uploadId, after?.e, limit);
      const page = toPage(rows, limit, (e) => ({ e: e.entryNo }));
      return c.json({ uploadId: params.uploadId, items: page.items, nextCursor: page.nextCursor });
    }),
  );
}
