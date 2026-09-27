// HTTP adapters: one svc.op(...) per contract operation, calling application use cases (CLAUDE.md §3.1).
// Staff routes re-check the tenant and role (NFR-15); public routes resolve the tenant from the API key.
import type { operations } from '@11e/contracts/listings';
import type { Service } from '@11e/http';
import { checkDbReady } from '@11e/db';
import { EXPECTED_MIGRATION } from '../config.js';
import type { AppDeps } from '../deps.js';
import { registerAdminRoutes } from './routes-admin.js';
import { registerPublicRoutes } from './routes-public.js';
import { registerStaffRoutes } from './routes-staff.js';

export function registerRoutes(svc: Service<operations>, deps: AppDeps): void {
  registerStaffRoutes(svc, deps);
  registerAdminRoutes(svc, deps);
  registerPublicRoutes(svc, deps);

  // Health: libs/http serves /health/* before any operation route with the same responses; registering the contract
  // operations marks them implemented, so svc.unimplemented() covers all 25 operations.
  svc.op('live', (c) => c.json({ status: 'ok' as const }));
  svc.op('ready', async (c) => {
    const r = await checkDbReady(deps.db, EXPECTED_MIGRATION);
    return c.json(
      {
        status: r.ok ? ('ok' as const) : ('down' as const),
        checks: { db: r.ok ? 'ok' : (r.reason ?? 'down') },
      },
      r.ok ? 200 : 503,
    );
  });
}
