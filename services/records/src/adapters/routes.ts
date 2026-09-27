// HTTP adapters: one svc.op(...) per contract operation, calling application use cases (CLAUDE.md §3.1).
import type { operations } from '@11e/contracts/records';
import type { Service } from '@11e/http';
import type { AppDeps } from '../deps.js';
import { registerDemandRoutes } from './http/demand.js';
import { registerMergeRoutes } from './http/merges.js';
import { registerReferenceRoutes } from './http/reference.js';
import { registerSupplyRoutes } from './http/supply.js';

export function registerRoutes(svc: Service<operations>, deps: AppDeps): void {
  registerReferenceRoutes(svc, deps);
  registerSupplyRoutes(svc, deps);
  registerDemandRoutes(svc, deps);
  registerMergeRoutes(svc, deps);
}
