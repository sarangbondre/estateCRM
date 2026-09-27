// HTTP adapters: one svc.op(...) per contract operation, calling application use cases (CLAUDE.md §3.1).
// Staff routes re-check the tenant and role (NFR-15).
import type { operations } from '@11e/contracts/listings';
import type { Service } from '@11e/http';
import type { AppDeps } from '../deps.js';
import { registerStaffRoutes } from './routes-staff.js';

export function registerRoutes(svc: Service<operations>, deps: AppDeps): void {
  registerStaffRoutes(svc, deps);
}
