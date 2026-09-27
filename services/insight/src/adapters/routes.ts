// HTTP adapters: one svc.op(...) per contract operation, calling application use cases (CLAUDE.md §3.1).
import { requireStaff } from '@11e/auth';
import type { operations } from '@11e/contracts/insight';
import { HttpError, badRequest, forbidden } from '@11e/http';
import type { Service } from '@11e/http';
import { getDashboard } from '../application/dashboards.js';
import type { DashboardQuery } from '../application/dashboards.js';
import type { Caller, RunQueryOutcome } from '../application/queries.js';
import type { DashboardName } from '../domain/dashboards/definitions.js';
import { planCatalogue, runQuery } from '../application/queries.js';
import type { QueryPlan } from '../domain/plans/types.js';
import type { AppDeps } from '../deps.js';
import type { Wired } from './wiring.js';

export function callerOf(c: Parameters<typeof requireStaff>[0]): Caller {
  const p = requireStaff(c);
  return { tenantId: p.tenantId, userId: p.userId, role: p.role };
}

/** Validation failures → RFC 7807 (LLD §6). */
export function planError(outcome: Exclude<RunQueryOutcome, { ok: true }>): HttpError {
  switch (outcome.code) {
    case 'not-allowed-for-role':
      return forbidden(outcome.errors[0]?.message);
    case 'unknown-vocabulary-value':
      return new HttpError(400, 'unknown-vocabulary-value', { errors: outcome.errors });
    case 'plan-not-in-catalogue':
      return new HttpError(422, 'plan-not-in-catalogue', { errors: outcome.errors });
    default:
      return new HttpError(422, 'plan-invalid', { errors: outcome.errors });
  }
}

export function registerRoutes(svc: Service<operations>, deps: AppDeps, wired: Wired): void {
  svc.op('getPlanCatalogue', async (c) => c.json(await planCatalogue(wired.query, callerOf(c))));

  svc.op('runQuery', async (c, { body }) => {
    const caller = callerOf(c);
    const outcome = await runQuery(wired.query, caller, body.plan as QueryPlan, {
      ...(body.limit !== undefined ? { limit: body.limit } : {}),
      cursor: body.cursor ?? null,
    });
    if (!outcome.ok) throw planError(outcome);
    deps.obs.loggerFor(c).info({ code: body.plan.planId, count: outcome.result.rows.length }, 'query run');
    return c.json(outcome.result, 200);
  });

  const dashboard = (name: DashboardName) => async (c: Parameters<typeof callerOf>[0], query: DashboardQuery) => {
    const caller = callerOf(c);
    const r = await getDashboard(wired.dashboards, caller.tenantId, name, query);
    if (!r.ok) {
      if (r.code === 'validation-failed') throw badRequest(r.errors);
      throw new HttpError(400, 'unknown-vocabulary-value', { errors: r.errors });
    }
    c.header('cache-control', 'private, max-age=30');
    return c.json(r.dashboard, 200);
  };
  svc.op('getDemandDashboard', (c, { query }) => dashboard('demand')(c, query as DashboardQuery));
  svc.op('getSupplyDashboard', (c, { query }) => dashboard('supply')(c, query as DashboardQuery));
  svc.op('getScopesDashboard', (c, { query }) => dashboard('scopes')(c, query as DashboardQuery));
  svc.op('getQualityDashboard', (c, { query }) => dashboard('quality')(c, query as DashboardQuery));
}
