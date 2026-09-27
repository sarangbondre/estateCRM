/**
 * Layer rules (CLAUDE.md §3.1): domain → application → adapters.
 * - domain: pure business logic; no application/adapters imports, no framework/ORM/SDK/I/O.
 * - application: use cases; may import domain; never adapters.
 * - libs never import services; services never import each other.
 */
const INFRA = '^(hono|@hono/|kysely|pg|@supabase/|@huggingface/|exceljs|@react-pdf/|jose|pino|@opentelemetry/|node:(fs|net|http|https|child_process|dgram|tls))';
module.exports = {
  forbidden: [
    { name: 'domain-no-outer-layers', severity: 'error',
      from: { path: '^services/[^/]+/src/domain/' },
      to: { path: '^services/[^/]+/src/(application|adapters)/' } },
    { name: 'domain-no-infrastructure', severity: 'error',
      comment: 'Domain must stay free of frameworks, ORMs, SDKs and I/O.',
      from: { path: '^services/[^/]+/src/domain/' },
      to: { path: INFRA, dependencyTypes: ['npm', 'core', 'npm-dev', 'npm-optional', 'npm-peer', 'unknown'] } },
    { name: 'application-no-adapters', severity: 'error',
      from: { path: '^services/[^/]+/src/application/' },
      to: { path: '^services/[^/]+/src/adapters/' } },
    { name: 'no-cross-service-imports', severity: 'error',
      from: { path: '^services/([^/]+)/' },
      to: { path: '^services/', pathNot: '^services/$1/' } },
    { name: 'libs-no-services', severity: 'error',
      from: { path: '^libs/' }, to: { path: '^services/' } },
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    exclude: { path: '(node_modules|dist|\\.next|\\.turbo)' },
  },
};
