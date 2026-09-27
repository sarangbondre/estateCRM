// HTTP adapters: one svc.op(...) per contract operation, calling application use cases (CLAUDE.md §3.1).
import type { operations } from '@11e/contracts/journeys';
import type { Service } from '@11e/http';
import type { AppDeps } from '../deps.js';
import { createHttp } from './http.js';
import { registerProposalRoutes } from './routes-proposals.js';
import { registerQueueRoutes } from './routes-queues.js';
import { registerSubjectRoutes } from './routes-subjects.js';

export function registerRoutes(svc: Service<operations>, deps: AppDeps): void {
  const http = createHttp(deps);
  registerQueueRoutes(svc, http);
  registerSubjectRoutes(svc, http);
  registerProposalRoutes(svc, http);
}
