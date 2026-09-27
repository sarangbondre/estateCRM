// Upload routes (intake.yaml tag Uploads): create, list, get, patch, cancel, progress, row errors, rejected rows,
// migration map. Validation happens at the edge (libs/http, Ajv against the contract).
import { idempotent, ifMatchVersion, pageLimit, toPage } from '@11e/http';
import type { Service } from '@11e/http';
import type { operations } from '@11e/contracts/intake';
import type { IntakeDb } from '../db.js';
import type { Kysely } from '@11e/db';
import type { App } from '../../application/context.js';
import * as uploads from '../../application/uploads.js';
import { presentRowError, presentUpload } from './presenters.js';
import { cursorOf, guard, staffActor } from './support.js';

export function registerUploadRoutes(svc: Service<operations>, app: App, db: Kysely<IntakeDb>): void {
  svc.op('createUpload', (c, { body }) => {
    const actor = staffActor(c);
    return idempotent(c, db, actor, body, () =>
      guard(async () => {
        const r = await uploads.createUpload(app, actor, body);
        return {
          status: 201,
          body: {
            upload: presentUpload(r.upload),
            uploadUrl: r.uploadUrl.url,
            uploadUrlExpiresAt: r.uploadUrl.expiresAt.toISOString(),
          },
        };
      }),
    );
  });

  svc.op('listUploads', (c, { query }) =>
    guard(async () => {
      const actor = staffActor(c);
      const limit = pageLimit(query.limit);
      const after = cursorOf(query.cursor, { k: 'string', id: 'string' });
      const rows = await uploads.listUploads(
        app,
        actor.tenantId,
        {
          status: query.status,
          sourceType: query.sourceType,
          uploadedBy: query.uploadedBy,
          mode: query.mode,
        },
        after,
        limit,
      );
      const page = toPage(rows, limit, (u) => ({ k: u.createdAt.toISOString(), id: u.id }));
      return c.json({ items: page.items.map(presentUpload), nextCursor: page.nextCursor });
    }),
  );

  svc.op('getUpload', (c, { params }) =>
    guard(async () => {
      const actor = staffActor(c);
      const u = await uploads.getUpload(app, actor.tenantId, params.idOrCode);
      c.header('etag', `"${u.version}"`);
      return c.json(presentUpload(u));
    }),
  );

  svc.op('patchUpload', (c, { params, body }) =>
    guard(async () => {
      const actor = staffActor(c);
      const u = await uploads.patchUpload(app, actor, params.idOrCode, body, ifMatchVersion(c));
      c.header('etag', `"${u.version}"`);
      return c.json(presentUpload(u));
    }),
  );

  svc.op('cancelUpload', (c, { params }) => {
    const actor = staffActor(c);
    return idempotent(c, db, actor, { idOrCode: params.idOrCode }, () =>
      guard(async () => ({
        status: 200,
        body: presentUpload(await uploads.cancelUpload(app, actor, params.idOrCode)),
      })),
    );
  });

  svc.op('getUploadProgress', (c, { params }) =>
    guard(async () => {
      const actor = staffActor(c);
      const { upload: u, etaSeconds } = await uploads.getProgress(app, actor.tenantId, params.idOrCode);
      return c.json({
        uploadId: u.id,
        status: u.status,
        stage: u.stage,
        chunkCount: u.chunkCount,
        chunksDone: u.chunksDone,
        chunksFailed: u.chunksFailed,
        batchesEmitted: u.batchesEmitted,
        counts: { ...u.counts, migrationEntries: u.migrationEntries },
        etaSeconds,
        updatedAt: u.updatedAt.toISOString(),
      });
    }),
  );

  svc.op('listRowErrors', (c, { params, query }) =>
    guard(async () => {
      const actor = staffActor(c);
      const limit = pageLimit(query.limit);
      const after = cursorOf(query.cursor, { rowNo: 'number', id: 'string' });
      const rows = await uploads.listRowErrors(
        app,
        actor.tenantId,
        params.idOrCode,
        { field: query.field, code: query.code },
        after,
        limit,
      );
      const page = toPage(rows, limit, (e) => ({ rowNo: e.rowNo, id: e.id }));
      return c.json({ items: page.items.map(presentRowError), nextCursor: page.nextCursor });
    }),
  );

  svc.op('getRejectedRowsLink', (c, { params }) =>
    guard(async () => {
      const actor = staffActor(c);
      const r = await uploads.getRejectedRowsLink(app, actor, params.idOrCode);
      c.header('cache-control', 'no-store');
      return c.json({ url: r.link.url, expiresAt: r.link.expiresAt.toISOString(), rowCount: r.rowCount });
    }),
  );

  svc.op('getUploadMigrationMap', (c, { params, query }) =>
    guard(async () => {
      const actor = staffActor(c);
      const limit = pageLimit(query.limit);
      const after = cursorOf(query.cursor, { e: 'number' });
      const view = await uploads.getMigrationMap(
        app,
        actor.tenantId,
        params.idOrCode,
        query.action,
        after?.e,
        limit,
      );
      const page = toPage(view.items, limit, (e) => ({ e: e.entryNo }));
      return c.json({
        uploadId: view.upload.id,
        entries: view.upload.migrationEntries,
        byAction: view.byAction,
        items: page.items,
        nextCursor: page.nextCursor,
      });
    }),
  );
}
