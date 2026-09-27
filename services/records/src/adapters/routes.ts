// HTTP adapters: one svc.op(...) per contract operation, calling application use cases (CLAUDE.md §3.1).
import type { operations } from '@11e/contracts/records';
import { checkDbReady } from '@11e/db';
import type { Service } from '@11e/http';
import { EXPECTED_MIGRATION } from '../config.js';
import type { AppDeps } from '../deps.js';
import { registerDemandRoutes } from './http/demand.js';
import { registerDeskRoutes } from './http/desks.js';
import { registerMergeRoutes } from './http/merges.js';
import { registerPrivacyRoutes } from './http/privacy.js';
import { registerReferenceRoutes } from './http/reference.js';
import { registerSupplyRoutes } from './http/supply.js';

export function registerRoutes(svc: Service<operations>, deps: AppDeps): void {
  registerReferenceRoutes(svc, deps);
  registerSupplyRoutes(svc, deps);
  registerDemandRoutes(svc, deps);
  registerMergeRoutes(svc, deps);
  registerPrivacyRoutes(svc, deps);
  registerDeskRoutes(svc, deps);
  // /health/live and /health/ready are answered by libs/http before any operation route (same contract shapes);
  // registering the operations keeps the contract fully implemented (svc.unimplemented() is empty).
  svc.op('recordsHealthLive', (c) => c.json({ status: 'ok' }));
  svc.op('recordsHealthReady', async (c) => {
    const r = await checkDbReady(deps.db, EXPECTED_MIGRATION);
    return c.json({ status: r.ok ? 'ok' : 'down', checks: { db: r.ok ? 'ok' : (r.reason ?? 'down') } }, r.ok ? 200 : 503);
  });
}
