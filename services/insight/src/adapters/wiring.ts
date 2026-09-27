// Builds the DB-backed adapters once per app (used by routes, work handlers and jobs).
import type { QueryDeps } from '../application/queries.js';
import type { AppDeps } from '../deps.js';
import { createQueryExecutor } from './queryExecutor.js';
import { createCatalogueRepo, createReadModelInfo, createReferenceData, createReferenceStore } from './reference.js';

export interface Wired {
  query: QueryDeps;
  referenceStore: ReturnType<typeof createReferenceStore>;
  clearCaches(): void;
}

export function wire(deps: AppDeps): Wired {
  const refs = createReferenceData(deps.db);
  return {
    query: {
      refs,
      executor: createQueryExecutor(deps.db),
      info: createReadModelInfo(deps.db),
      catalogue: createCatalogueRepo(deps.db),
      clock: deps.clock,
    },
    referenceStore: createReferenceStore(deps.db),
    clearCaches: () => refs.clear(),
  };
}
