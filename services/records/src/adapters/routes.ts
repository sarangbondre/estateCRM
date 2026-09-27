// HTTP adapters: one svc.op(...) per contract operation, calling application use cases (CLAUDE.md §3.1).
import type { operations } from '@11e/contracts/records';
import type { Service } from '@11e/http';
import type { AppDeps } from '../deps.js';
import { registerReferenceRoutes } from './http/reference.js';

export function registerRoutes(svc: Service<operations>, deps: AppDeps): void {
  registerReferenceRoutes(svc, deps);
}
