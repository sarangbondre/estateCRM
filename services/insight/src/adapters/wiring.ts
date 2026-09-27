// Builds the DB-backed adapters once per app (used by routes, work handlers and jobs).
import type { DashboardDeps } from '../application/dashboards.js';
import type { QueryDeps } from '../application/queries.js';
import type { AppDeps } from '../deps.js';
import { createDashboardReader } from './dashboardReader.js';
import { createQueryExecutor } from './queryExecutor.js';
import { createCatalogueRepo, createReadModelInfo, createReferenceData, createReferenceStore } from './reference.js';

export interface Wired {
  query: QueryDeps;
  dashboards: DashboardDeps;
  referenceStore: ReturnType<typeof createReferenceStore>;
  clearCaches(): void;
}

export function wire(deps: AppDeps): Wired {
  const refs = createReferenceData(deps.db);
  const info = createReadModelInfo(deps.db);
  return {
    dashboards: { reader: createDashboardReader(deps.db), refs, info, clock: deps.clock },
    query: {
      refs,
      executor: createQueryExecutor(deps.db),
      info,
      catalogue: createCatalogueRepo(deps.db),
      clock: deps.clock,
    },
    referenceStore: createReferenceStore(deps.db),
    clearCaches: () => refs.clear(),
  };
}
