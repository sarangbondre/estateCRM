// HTTP adapters: one svc.op(...) per contract operation, calling application use cases (CLAUDE.md §3.1).
import type { operations } from '@11e/contracts/intake';
import type { Service } from '@11e/http';
import type { AppDeps } from '../deps.js';
import { registerInternalRoutes } from './http/internal.js';
import { registerReviewRoutes } from './http/review.js';
import { parseFreeText } from '../application/parse.js';
import { guard, staffActor } from './http/support.js';
import { registerTemplateRoutes } from './http/templates.js';
import { registerUploadRoutes } from './http/uploads.js';

export function registerRoutes(svc: Service<operations>, deps: AppDeps): void {
  registerUploadRoutes(svc, deps.app, deps.db);
  registerTemplateRoutes(svc, deps.app, deps.db);
  registerInternalRoutes(svc, deps.app);
  registerReviewRoutes(svc, deps.app, deps.db);
  // POST /v1/parse (4 s budget, R-5): nothing stored; the body is never logged (the logger has no body fields)
  svc.op('parseFreeText', (c, { body }) =>
    guard(async () => {
      const actor = staffActor(c);
      c.header('cache-control', 'no-store');
      return c.json(await parseFreeText(deps.app, actor.tenantId, body));
    }),
  );
}
