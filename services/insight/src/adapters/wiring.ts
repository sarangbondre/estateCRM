// Builds the DB-backed adapters once per app (used by routes, work handlers and jobs).
import type { ChatDeps } from '../application/chat.js';
import type { DashboardDeps } from '../application/dashboards.js';
import type { ExportDeps } from '../application/exports.js';
import type { ConversationRepo, UsageMeter } from '../application/ports.js';
import type { QueryDeps } from '../application/queries.js';
import type { AppDeps } from '../deps.js';
import { createCodeLookup, createUsageMeter, ids, redactor } from './chatAdapters.js';
import { createConversationRepo } from './conversationRepo.js';
import { createDashboardReader } from './dashboardReader.js';
import { createExportRepo } from './exportRepo.js';
import { createFileStore, xlsxWriter } from './files.js';
import { createContactsReader } from './records.js';
import { createHfPlanner } from './hfPlanner.js';
import { createQueryExecutor } from './queryExecutor.js';
import { createCatalogueRepo, createReadModelInfo, createReferenceData, createReferenceStore } from './reference.js';

export interface Wired {
  query: QueryDeps;
  dashboards: DashboardDeps;
  chat: ChatDeps;
  exports: ExportDeps;
  conversations: ConversationRepo;
  usage: UsageMeter;
  referenceStore: ReturnType<typeof createReferenceStore>;
  clearCaches(): void;
}

export function wire(deps: AppDeps): Wired {
  const refs = createReferenceData(deps.db);
  const info = createReadModelInfo(deps.db);
  const query: QueryDeps = {
    refs,
    executor: createQueryExecutor(deps.db),
    info,
    catalogue: createCatalogueRepo(deps.db),
    clock: deps.clock,
  };
  const dashboards: DashboardDeps = { reader: createDashboardReader(deps.db), refs, info, clock: deps.clock };
  const conversations = createConversationRepo(deps.db, ids.uuid);
  const usage = createUsageMeter(deps.db);
  const planner = deps.planner ?? createHfPlanner({ model: null, client: null });
  const c = deps.config;
  const exports: ExportDeps = {
    query,
    exports: createExportRepo(deps.db),
    files: deps.files ?? createFileStore({ supabaseUrl: c.supabaseUrl, serviceKey: c.supabaseServiceKey, bucket: c.exportBucket, localDir: c.localExportDir }),
    contacts: deps.contacts ?? createContactsReader(null, null),
    sheets: xlsxWriter,
    ids,
    maxRows: c.exportMaxRows,
  };
  return {
    query,
    dashboards,
    exports,
    chat: { query, dashboards, planner, usage, redactor, conversations, codes: createCodeLookup(deps.db), ids },
    conversations,
    usage,
    referenceStore: createReferenceStore(deps.db),
    clearCaches: () => refs.clear(),
  };
}
