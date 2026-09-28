// Template routes (intake.yaml tag Templates).
import { idempotent, ifMatchVersion, pageLimit, toPage } from '@11e/http';
import type { Service } from '@11e/http';
import type { Kysely } from '@11e/db';
import type { components, operations } from '@11e/contracts/intake';
import type { App } from '../../application/context.js';
import * as templates from '../../application/templates.js';
import type { Template } from '../../domain/template.js';
import type { IntakeDb } from '../db.js';
import { cursorOf, guard, staffActor } from './support.js';

export function presentTemplate(t: Template): components['schemas']['Template'] {
  return {
    id: t.id,
    name: t.name,
    sourceType: t.sourceType,
    sourceDetail: t.sourceDetail,
    headerFingerprint: t.headerFingerprint,
    columnMap: t.columnMap,
    constants: (t.constants ?? {}) as Record<string, never>,
    createdBy: t.createdBy,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    version: t.version,
  };
}

export function registerTemplateRoutes(svc: Service<operations>, app: App, db: Kysely<IntakeDb>): void {
  svc.op('listTemplates', (c, { query }) =>
    guard(async () => {
      const actor = staffActor(c);
      const limit = pageLimit(query.limit);
      const after = cursorOf(query.cursor, { k: 'string', id: 'string' });
      const rows = await templates.listTemplates(
        app,
        actor.tenantId,
        { sourceType: query.sourceType, headerFingerprint: query.headerFingerprint },
        after,
        limit,
      );
      const page = toPage(rows, limit, (t) => ({ k: t.name.toLowerCase(), id: t.id }));
      return c.json({ items: page.items.map(presentTemplate), nextCursor: page.nextCursor });
    }),
  );

  svc.op('createTemplate', (c, { body }) => {
    const actor = staffActor(c);
    return idempotent(c, db, actor, body, () =>
      guard(async () => ({
        status: 201,
        body: presentTemplate(await templates.createTemplate(app, actor, body)),
      })),
    );
  });

  svc.op('getTemplate', (c, { params }) =>
    guard(async () => {
      const actor = staffActor(c);
      const t = await templates.getTemplate(app, actor.tenantId, params.id);
      c.header('etag', `"${t.version}"`);
      return c.json(presentTemplate(t));
    }),
  );

  svc.op('putTemplate', (c, { params, body }) =>
    guard(async () => {
      const actor = staffActor(c);
      const t = await templates.replaceTemplate(app, actor, params.id, body, ifMatchVersion(c));
      c.header('etag', `"${t.version}"`);
      return c.json(presentTemplate(t));
    }),
  );

  svc.op('deleteTemplate', (c, { params }) =>
    guard(async () => {
      await templates.deleteTemplate(app, staffActor(c), params.id);
      return c.body(null, 204);
    }),
  );
}
