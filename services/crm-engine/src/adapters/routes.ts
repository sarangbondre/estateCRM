// HTTP adapters: one svc.op(...) per contract operation (contracts/openapi/crm-engine.yaml), calling the use cases in
// one transaction each. Tenant and role come from libs/auth (x-roles enforced there); every query is tenant-scoped.
import { requireStaff, tenantOf } from '@11e/auth';
import type { components, operations } from '@11e/contracts/crm-engine';
import { checkDbReady } from '@11e/db';
import { HttpError, decodeCursor, idempotent, ifMatchVersion, pageLimit, toPage } from '@11e/http';
import type { Service, ServiceContext } from '@11e/http';
import { confirm, createBundle, currentWeights, putWeights, reject, rerun } from '../application/commands.js';
import type { Actor } from '../application/commands.js';
import { UseCaseError, notFoundError } from '../application/errors.js';
import { explainMatch } from '../application/explain.js';
import type {
  BundleRecord,
  MatchRecord,
  Position,
  RunRecord,
  Store,
  WeightsRecord,
} from '../application/ports.js';
import type { MatchFlag, MatchStatus } from '../domain/types.js';
import { withDefaults } from '../domain/weights.js';
import { EXPECTED_MIGRATION } from '../config.js';
import type { AppDeps } from '../deps.js';
import { pgUnitOfWork } from './store.js';

type Schemas = components['schemas'];
const DEFAULT_STATUSES: MatchStatus[] = ['Suggested', 'Confirmed'];

// --- DTO mapping -----------------------------------------------------------------------------------------------------
export function matchDto(m: MatchRecord, codes: ReadonlyMap<string, string>): Schemas['Match'] {
  const demandCode = codes.get(m.demandId);
  const bundleCode = m.bundleId ? codes.get(m.bundleId) : undefined;
  return {
    id: m.id,
    code: m.code,
    demandId: m.demandId,
    ...(demandCode ? { demandCode } : {}),
    offerIds: [...m.offerIds],
    offerCodes: m.offerIds.map((id) => codes.get(id)).filter((c): c is string => !!c),
    isBundle: m.isBundle,
    bundleId: m.bundleId,
    bundleCode: bundleCode ?? null,
    score: m.score,
    rank: m.rank,
    status: m.status,
    flags: [...m.flags],
    factors: m.factors.map((f) => ({ ...f })),
    closedReason: m.closedReason,
    rejectedReason: m.rejectedReason,
    origin: m.origin,
    weightsVersion: m.weightsVersion,
    confirmedBy: m.confirmedBy,
    confirmedAt: m.confirmedAt ? m.confirmedAt.toISOString() : null,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
    version: m.version,
  };
}

export function bundleDto(b: BundleRecord): Schemas['Bundle'] {
  return {
    id: b.id,
    code: b.code,
    demandId: b.demandId,
    offerIds: [...b.offerIds],
    grouping: b.grouping,
    combinedAreaSqft: b.combinedAreaSqft,
    combinedPriceInr: b.combinedPriceInr,
    combinedRentMonthlyInr: b.combinedRentMonthlyInr,
    matchId: b.matchId as string,
    origin: b.origin,
    createdAt: b.createdAt.toISOString(),
  };
}

export function runDto(r: RunRecord): Schemas['MatchingRun'] {
  return {
    id: r.id,
    scope: r.scope,
    subjectId: r.subjectId,
    trigger: r.trigger.slice(0, 60),
    status: r.status,
    candidates: r.candidates,
    suggested: r.suggested,
    closed: r.closed,
    excluded: r.excluded,
    startedAt: r.startedAt ? r.startedAt.toISOString() : null,
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    error: r.error ? r.error.slice(0, 200) : null,
  };
}

export function weightsDto(w: WeightsRecord): Schemas['Weights'] {
  return {
    version: w.version,
    factors: { ...w.factors },
    tuning: { ...w.tuning, proximity: { ...w.tuning.proximity } },
    updatedBy: w.createdBy,
    updatedAt: w.id ? w.createdAt.toISOString() : null,
  };
}

const EXCLUSION_DETAIL: Record<string, string> = {
  offer_expired: 'Offer Expired: availability unknown until reconfirmed',
  offer_inactive: 'Offer Inactive',
  demand_stale: 'Demand Stale: reconfirm the requirement before new suggestions',
};

/** Codes of the demand, offers and bundles referenced by a set of matches. */
async function codesFor(
  store: Store,
  tenantId: string,
  matches: readonly MatchRecord[],
): Promise<Map<string, string>> {
  const codes = await store.mx.codesOf(
    tenantId,
    matches.flatMap((m) => m.offerIds),
    matches.map((m) => m.demandId),
  );
  const bundleIds = matches.filter((m) => m.bundleId).map((m) => m.bundleId as string);
  if (bundleIds.length)
    for (const b of await store.bundles.getMany(tenantId, bundleIds)) codes.set(b.id, b.code);
  return codes;
}

function toHttp(err: unknown): never {
  if (err instanceof UseCaseError)
    throw new HttpError(err.status, err.code, {
      ...(err.detail ? { detail: err.detail } : {}),
      ...(err.errors?.length ? { errors: err.errors } : {}),
    });
  throw err;
}

export function registerRoutes(svc: Service<operations>, deps: AppDeps): void {
  const uow = pgUnitOfWork(deps.db, () => deps.clock.now());
  const clock = deps.clock;
  const run = <T>(c: ServiceContext, fn: (store: Store) => Promise<T>) =>
    uow.run(c.get('correlationId'), fn).catch(toHttp);
  const actorOf = (c: ServiceContext): Actor => {
    const p = requireStaff(c);
    return { tenantId: p.tenantId, userId: p.userId, role: p.role };
  };
  const cursor = (raw: string | undefined) => (decodeCursor<Position>(raw) ?? null) as Position | null;

  // --- matches --------------------------------------------------------------------------------------------------------
  svc.op('listDemandMatches', async (c, { params, query }) => {
    const t = tenantOf(c);
    const limit = pageLimit(query.limit);
    const page = await run(c, async (store) => {
      const ref = await store.mx.resolveDemand(t, params.idOrCode);
      if (!ref) throw notFoundError('demand');
      const rows = await store.queries.demandMatches(t, ref.id, {
        statuses: query.status?.length ? query.status : DEFAULT_STATUSES,
        flag: (query.flag as MatchFlag | undefined) ?? null,
        bundlesOnly: query.bundlesOnly ?? false,
        limit,
        after: cursor(query.cursor),
      });
      return { rows, codes: await codesFor(store, t, rows) };
    });
    const p = toPage(page.rows, limit, (m) => ({
      o: m.status === 'Confirmed' ? 0 : 1,
      s: m.score,
      id: m.id,
    }));
    return c.json({ items: p.items.map((m) => matchDto(m, page.codes)), nextCursor: p.nextCursor });
  });

  svc.op('listOfferMatches', async (c, { params, query }) => {
    const t = tenantOf(c);
    const limit = pageLimit(query.limit);
    const page = await run(c, async (store) => {
      const ref = await store.mx.resolveOffer(t, params.idOrCode);
      if (!ref) throw notFoundError('offer');
      const rows = await store.queries.offerMatches(t, ref.id, {
        statuses: query.status?.length ? query.status : DEFAULT_STATUSES,
        flag: (query.flag as MatchFlag | undefined) ?? null,
        limit,
        after: cursor(query.cursor),
      });
      return { rows, codes: await codesFor(store, t, rows) };
    });
    const p = toPage(page.rows, limit, (m) => ({ s: m.score, id: m.id }));
    return c.json({ items: p.items.map((m) => matchDto(m, page.codes)), nextCursor: p.nextCursor });
  });

  svc.op('getMatch', async (c, { params }) => {
    const t = tenantOf(c);
    const r = await run(c, async (store) => {
      const m = await store.matches.get(t, params.idOrCode);
      if (!m) throw notFoundError('match');
      return { m, codes: await codesFor(store, t, [m]) };
    });
    return c.json(matchDto(r.m, r.codes));
  });

  svc.op('explainMatch', async (c, { params }) => {
    const t = tenantOf(c);
    return c.json(await run(c, (store) => explainMatch(store, clock, t, params.idOrCode)));
  });

  svc.op('confirmMatch', async (c, { params, body }) => {
    const actor = actorOf(c);
    return idempotent(c, deps.db, actor, body ?? {}, async () => {
      const r = await run(c, async (store) => {
        const m = await confirm(store, clock, actor, params.idOrCode);
        return { m, codes: await codesFor(store, actor.tenantId, [m]) };
      });
      return { status: 200, body: matchDto(r.m, r.codes) };
    });
  });

  svc.op('rejectMatch', async (c, { params, body }) => {
    const actor = actorOf(c);
    return idempotent(c, deps.db, actor, body, async () => {
      const r = await run(c, async (store) => {
        const m = await reject(store, clock, actor, params.idOrCode, body.reasonCode);
        return { m, codes: await codesFor(store, actor.tenantId, [m]) };
      });
      return { status: 200, body: matchDto(r.m, r.codes) };
    });
  });

  // --- bundles ---------------------------------------------------------------------------------------------------------
  svc.op('createBundle', async (c, { body }) => {
    const actor = actorOf(c);
    return idempotent(c, deps.db, actor, body, async () => {
      const r = await run(c, async (store) => {
        const res = await createBundle(store, clock, actor, body);
        const codes = await codesFor(store, actor.tenantId, [res.match]);
        codes.set(res.bundle.id, res.bundle.code);
        return { ...res, codes };
      });
      return {
        status: r.created ? 201 : 200,
        body: { bundle: bundleDto(r.bundle), match: matchDto(r.match, r.codes) },
      };
    });
  });

  svc.op('getBundle', async (c, { params }) => {
    const t = tenantOf(c);
    const b = await run(c, async (store) => {
      const found = await store.bundles.get(t, params.idOrCode);
      if (!found || !found.matchId) throw notFoundError('bundle');
      return found;
    });
    return c.json(bundleDto(b));
  });

  svc.op('listDemandExclusions', async (c, { params, query }) => {
    const t = tenantOf(c);
    const limit = pageLimit(query.limit);
    const r = await run(c, async (store) => {
      const ref = await store.mx.resolveDemand(t, params.idOrCode);
      if (!ref) throw notFoundError('demand');
      const rows = await store.queries.exclusions(t, ref.id, {
        reason: query.reason ?? null,
        limit,
        after: cursor(query.cursor),
      });
      const codes = await store.mx.codesOf(
        t,
        rows.map((x) => x.offerId),
        [],
      );
      return { rows, codes };
    });
    const p = toPage(r.rows, limit, (x) => ({ k: x.computedAt.toISOString(), id: x.id }));
    return c.json({
      items: p.items.map((x) => {
        const offerCode = r.codes.get(x.offerId);
        const detail =
          x.reason === 'available_too_late' && x.availableFrom && x.moveInBy
            ? `Available from ${x.availableFrom}, demand needs by ${x.moveInBy}`
            : (EXCLUSION_DETAIL[x.reason] ?? x.reason);
        return {
          demandId: x.demandId,
          offerId: x.offerId,
          ...(offerCode ? { offerCode } : {}),
          reason: x.reason,
          detail,
          availableFrom: x.availableFrom,
          moveInBy: x.moveInBy,
          computedAt: x.computedAt.toISOString(),
        };
      }),
      nextCursor: p.nextCursor,
    });
  });

  // --- matching runs ------------------------------------------------------------------------------------------------------
  svc.op('rerunDemandMatching', async (c, { params, body }) => {
    const actor = actorOf(c);
    return idempotent(c, deps.db, actor, body ?? {}, async () => {
      const r = await run(c, (store) => rerun(store, clock, actor, params.idOrCode, body?.reason ?? null));
      return { status: 202, body: { runId: r.id, status: r.status, statusUrl: `/v1/matching-runs/${r.id}` } };
    });
  });

  svc.op('getMatchingRun', async (c, { params }) => {
    const t = tenantOf(c);
    const r = await run(c, async (store) => {
      const found = await store.runs.get(t, params.runId);
      if (!found) throw notFoundError('matching run');
      return found;
    });
    return c.json(runDto(r));
  });

  // --- weights -----------------------------------------------------------------------------------------------------------
  svc.op('getWeights', async (c) => {
    const t = tenantOf(c);
    return c.json(weightsDto(await run(c, (store) => currentWeights(store, t))));
  });

  svc.op('putWeights', async (c, { body }) => {
    const actor = actorOf(c);
    const ifMatch = ifMatchVersion(c);
    const r = await run(c, (store) => putWeights(store, actor, withDefaults(body), ifMatch));
    return c.json(weightsDto(r.weights));
  });

  // --- health: libs/http serves /health/* before any operation route (same responses); registering the contract
  // operations here marks them implemented so svc.unimplemented() covers all 19 operations.
  svc.op('healthLive', (c) => c.json({ status: 'ok' }));
  svc.op('healthReady', async (c) => {
    const r = await checkDbReady(deps.db, EXPECTED_MIGRATION);
    return c.json(
      { status: r.ok ? 'ok' : 'down', checks: { db: r.ok ? 'ok' : (r.reason ?? 'down') } },
      r.ok ? 200 : 503,
    );
  });

  // --- internal ----------------------------------------------------------------------------------------------------------
  svc.op('listMatchesForRebuild', async (c, { query }) => {
    const t = tenantOf(c);
    const limit = pageLimit(query.limit);
    const rows = await run(c, (store) =>
      store.queries.rebuild(t, {
        updatedSince: query.updatedSince ? new Date(query.updatedSince) : null,
        demandId: query.demandId ?? null,
        limit,
        after: cursor(query.cursor),
      }),
    );
    const p = toPage(rows, limit, (m) => ({ k: m.updatedAt.toISOString(), id: m.id }));
    return c.json({
      items: p.items.map((m) => ({
        id: m.id,
        code: m.code,
        demandId: m.demandId,
        offerIds: [...m.offerIds],
        isBundle: m.isBundle,
        status: m.status,
        score: m.score,
        flags: [...m.flags],
        closedReason: m.closedReason,
        version: m.version,
        updatedAt: m.updatedAt.toISOString(),
      })),
      nextCursor: p.nextCursor,
    });
  });
}
