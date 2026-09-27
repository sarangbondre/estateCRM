// HTTP adapters: one svc.op(...) per contract operation, calling application use cases (CLAUDE.md §3.1).
// Staff routes re-check the tenant and role (NFR-15); public routes resolve the tenant from the API key.
import type { operations } from '@11e/contracts/listings';
import type { Service } from '@11e/http';
import type { AppDeps } from '../deps.js';
import { registerAdminRoutes } from './routes-admin.js';
import { registerPublicRoutes } from './routes-public.js';
import { registerStaffRoutes } from './routes-staff.js';

export function registerRoutes(svc: Service<operations>, deps: AppDeps): void {
  registerStaffRoutes(svc, deps);
  registerAdminRoutes(svc, deps);
  registerPublicRoutes(svc, deps);
}
