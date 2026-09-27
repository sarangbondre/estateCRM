// Scaffolds the runtime of a backend service (composition root, config, local server, Vercel entry, platform endpoints,
// first migration, platform tests) so every service is built on the same plumbing. Business code goes into
// src/domain, src/application and src/adapters (routes.ts, events.ts, work.ts, jobs.ts).
// Usage: node tools/scaffold-service.mjs <service...> [--force]   (never overwrites existing files without --force)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

const root = new URL('../', import.meta.url);
const args = process.argv.slice(2);
const force = args.includes('--force');
const services = args.filter((a) => !a.startsWith('--'));
const topology = JSON.parse(readFileSync(new URL('contracts/generated/event-topology.json', root), 'utf8'));
const { localPorts } = load(readFileSync(new URL('infra/schedules.yaml', root), 'utf8'));
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const pascal = (s) => camel(s).replace(/^./, (c) => c.toUpperCase());

const written = [];
const put = (svc, rel, content) => {
  const url = new URL(`services/${svc}/${rel}`, root);
  if (existsSync(url) && !force) return;
  mkdirSync(dirname(fileURLToPath(url)), { recursive: true });
  writeFileSync(url, content);
  written.push(`services/${svc}/${rel}`);
};

for (const svc of services) {
  const t = topology.services[svc];
  if (!t || svc === 'web') throw new Error(`unknown backend service ${svc}`);
  const schema = t.schema;
  const ENV = schema.toUpperCase();
  const Svc = pascal(svc);
  const relayProps = Object.keys(
    (() => {
      const d = JSON.parse(read(`contracts/generated/openapi/${svc}.json`));
      const deref = (x) =>
        x?.$ref
          ? x.$ref
              .split('/')
              .slice(1)
              .reduce((a, k) => a[k], d)
          : x;
      const res = deref(d.paths['/internal/v1/relay'].post.responses['200']);
      return deref(res.content['application/json'].schema).properties ?? {};
    })(),
  );
  const responseStyle = relayProps.includes('claimed')
    ? 'batch'
    : relayProps.includes('more')
      ? 'compact'
      : 'summary';
  const jobsEnum =
    JSON.parse(read(`contracts/generated/openapi/${svc}.json`)).paths[
      '/internal/v1/jobs/{name}'
    ]?.post?.parameters?.find((p) => p.name === 'name')?.schema?.enum ?? [];

  put(
    svc,
    'package.json',
    `${JSON.stringify(
      {
        name: `@11e/${svc}`,
        version: '0.0.0',
        private: true,
        type: 'module',
        engines: { node: '>=24' },
        scripts: {
          dev: 'tsx watch --env-file-if-exists=../../.env.local src/server.ts',
          start: 'node --env-file-if-exists=../../.env.local dist/src/server.js',
          build: 'tsc -p tsconfig.build.json',
          test: 'vitest run',
          typecheck: 'tsc -p tsconfig.json',
          lint: 'eslint . --no-error-on-unmatched-pattern',
          migrate: `node --env-file-if-exists=../../.env.local ../../libs/db/dist/cli/migrate.js --schema ${schema} --dir migrations`,
          'migrate:check': 'node ../../libs/db/dist/cli/migrate.js --check --dir migrations',
        },
        dependencies: {
          '@11e/auth': 'workspace:*',
          '@11e/contracts': 'workspace:*',
          '@11e/db': 'workspace:*',
          '@11e/http': 'workspace:*',
          '@11e/observability': 'workspace:*',
          '@11e/outbox': 'workspace:*',
          '@hono/node-server': '^2.1.1',
          hono: '~4.13.9',
          kysely: '~0.29.6',
        },
        devDependencies: { jose: '~6.2.12', pg: '~8.23.0', '@types/pg': '^8.23.1' },
      },
      null,
      2,
    )}\n`,
  );

  put(
    svc,
    'tsconfig.json',
    `${JSON.stringify({ extends: '../../tsconfig.base.json', compilerOptions: { rootDir: '.', noEmit: true }, include: ['src', 'api', 'tests'] }, null, 2)}\n`,
  );
  put(
    svc,
    'tsconfig.build.json',
    `${JSON.stringify({ extends: './tsconfig.json', compilerOptions: { rootDir: '.', outDir: 'dist', noEmit: false }, include: ['src', 'api'] }, null, 2)}\n`,
  );
  put(
    svc,
    'vercel.json',
    `${JSON.stringify(
      {
        $schema: 'https://openapi.vercel.sh/vercel.json',
        regions: ['bom1'],
        functions: { 'api/index.ts': { maxDuration: 60 } },
        rewrites: [{ source: '/(.*)', destination: '/api' }],
      },
      null,
      2,
    )}\n`,
  );

  put(
    svc,
    'migrations/0001_technical_tables.sql',
    [
      `-- ${svc}: technical tables (conventions §6, R-3, R-4). Business tables start at 0002.`,
      read('libs/db/sql/idempotency_keys.sql'),
      read('libs/outbox/sql/outbox.sql'),
      read('libs/db/sql/job_leases.sql'),
    ].join('\n'),
  );

  put(
    svc,
    'src/config.ts',
    `// ${svc} configuration from environment variables (CLAUDE.md §3.6). Vercel sets the plain names; locally the root
// .env.local from \`pnpm db:env\` provides the ${ENV}_* names.
export const SERVICE = '${svc}';
export const SCHEMA = '${schema}';
/** Newest file in migrations/ (a test keeps them in step). /health/ready reports "behind" until it is applied. */
export const EXPECTED_MIGRATION = '0001';

export interface Config {
  port: number;
  databaseUrl: string;
  poolMax: number;
  cronSecret: string;
  /** web's JWKS (service tokens, R-2). */
  jwksUrl: string;
  /** This service's credential for web POST /internal/v1/service-tokens (only if it calls other services). */
  serviceCredential: string | undefined;
  webUrl: string;
  environment: string;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const get = (name: string) => env[name] ?? env[\`${ENV}_\${name}\`];
  const need = (name: string) => {
    const v = get(name);
    if (!v) throw new ConfigError(\`missing environment variable \${name} (or ${ENV}_\${name})\`);
    return v;
  };
  const webUrl = get('WEB_URL') ?? 'http://127.0.0.1:${localPorts.web}';
  return {
    port: Number(get('PORT') ?? ${localPorts[svc]}),
    databaseUrl: need('DATABASE_URL'),
    poolMax: Number(get('POOL_MAX') ?? 3),
    cronSecret: need('CRON_SECRET'),
    jwksUrl: get('JWKS_URL') ?? \`\${webUrl}/.well-known/jwks.json\`,
    serviceCredential: get('SERVICE_CREDENTIAL'),
    webUrl,
    environment: get('ENVIRONMENT_NAME') ?? 'local',
  };
}
`,
  );

  put(
    svc,
    'src/adapters/db.ts',
    `// Database types of the ${schema} schema (technical tables; business tables are added with their migrations).
import type { IdempotencyKeysTable } from '@11e/db';
import type { JobLeasesTable } from '@11e/http';
import type { OutboxDb } from '@11e/outbox';

export interface ${Svc}Db extends OutboxDb {
  idempotency_keys: IdempotencyKeysTable;
  job_leases: JobLeasesTable;
  schema_migrations: { version: string; name: string; checksum: string; applied_at: Date };
}
`,
  );

  put(
    svc,
    'src/adapters/routes.ts',
    `// HTTP adapters: one svc.op(...) per contract operation, calling application use cases (CLAUDE.md §3.1).
import type { operations } from '@11e/contracts/${svc}';
import type { Service } from '@11e/http';
import type { AppDeps } from '../deps.js';

export function registerRoutes(svc: Service<operations>, deps: AppDeps): void {
  void svc;
  void deps;
}
`,
  );

  put(
    svc,
    'src/adapters/events.ts',
    `// Event consumers for ${t.eventQueue} (contracts/asyncapi/events.yaml). Handlers run inside the drain transaction
// together with processed_events dedupe (libs/outbox). Unknown event types are dead-lettered (no-handler).
import type { EventHandlers } from '@11e/outbox';
import type { AppDeps } from '../deps.js';
import type { ${Svc}Db } from './db.js';

export function eventHandlers(deps: AppDeps): EventHandlers<${Svc}Db> {
  void deps;
  return {};
}
`,
  );

  put(
    svc,
    'src/adapters/work.ts',
    `// Private work queues: ${t.workQueues.join(', ') || '(none)'}. Each handler dedupes on its own work key.
import type { WorkHandler } from '@11e/outbox';
import type { AppDeps } from '../deps.js';
import type { ${Svc}Db } from './db.js';

export function workHandlers(deps: AppDeps): Record<string, WorkHandler<${Svc}Db>> {
  void deps;
  return {};
}
`,
  );

  put(
    svc,
    'src/adapters/jobs.ts',
    `// Scheduled jobs (infra/schedules.yaml). Contract enum: ${jobsEnum.join(', ') || '(none)'}.
import type { JobResult } from '@11e/http';
import type { AppDeps } from '../deps.js';

export function jobs(deps: AppDeps): Record<string, () => Promise<JobResult>> {
  void deps;
  return {};
}
`,
  );

  put(
    svc,
    'src/app.ts',
    `// ${svc} HTTP app: contract-driven routes, auth, observability and the platform endpoints (F-SVC scaffold).
import topology from '@11e/contracts/event-topology.json' with { type: 'json' };
import spec from '@11e/contracts/openapi/${svc}.json' with { type: 'json' };
import type { operations } from '@11e/contracts/${svc}';
import { checkDbReady } from '@11e/db';
import { createService, registerPlatformEndpoints } from '@11e/http';
import type { OpenApiDoc, Service } from '@11e/http';
import { drainEvents, drainWork } from '@11e/outbox';
import type { DrainResult } from '@11e/outbox';
import { EXPECTED_MIGRATION, SCHEMA, SERVICE } from './config.js';
import type { AppDeps } from './deps.js';
import { eventHandlers } from './adapters/events.js';
import { jobs } from './adapters/jobs.js';
import { registerRoutes } from './adapters/routes.js';
import { workHandlers } from './adapters/work.js';

export type { AppDeps } from './deps.js';

const EVENT_QUEUE = '${t.eventQueue}';
const WORK_QUEUES: readonly string[] = ${JSON.stringify(t.workQueues)};

export function buildApp(deps: AppDeps): Service<operations> {
  const { db, obs } = deps;
  const svc = createService<operations>({
    service: SERVICE,
    spec: spec as unknown as OpenApiDoc,
    ready: async () => {
      const r = await checkDbReady(db, EXPECTED_MIGRATION);
      return { ok: r.ok, checks: { db: r.ok ? 'ok' : (r.reason ?? 'down') } };
    },
    middleware: [obs.middleware],
    operationMiddleware: [deps.auth],
    onRequestEnd: obs.onRequestEnd,
    onError: obs.onError,
  });

  const queue = { db, schema: SCHEMA };
  const handlers = eventHandlers(deps);
  const work = workHandlers(deps);
  const drains: Record<string, () => Promise<DrainResult>> = {
    [EVENT_QUEUE]: () => drainEvents(queue, { queue: EVENT_QUEUE, consumer: SERVICE, handlers, onError: obs.drainHooks.onError }),
  };
  for (const q of WORK_QUEUES) {
    const handler = work[q];
    if (handler) drains[q] = () => drainWork(queue, { queue: q, handler, onError: obs.drainHooks.onError });
  }
  registerPlatformEndpoints(svc, {
    responseStyle: '${responseStyle}',
    queue,
    routes: topology.routes,
    drains,
    jobs: jobs(deps),
    onRelay: (r) => obs.onRelay(r),
    onDrain: obs.drainHooks.onResult,
  });
  registerRoutes(svc, deps);
  return svc;
}
`,
  );

  put(
    svc,
    'src/deps.ts',
    `// What the app and its adapters receive from the composition root (src/main.ts).
import type { MiddlewareHandler } from 'hono';
import type { Kysely } from 'kysely';
import type { ServiceEnv } from '@11e/http';
import type { Observability } from '@11e/observability';
import type { Config } from './config.js';
import type { ${Svc}Db } from './adapters/db.js';

export interface AppDeps {
  config: Config;
  db: Kysely<${Svc}Db>;
  obs: Observability;
  auth: MiddlewareHandler<ServiceEnv>;
}
`,
  );

  put(
    svc,
    'src/main.ts',
    `// Composition root: the only place concrete adapters are created (CLAUDE.md §3.1).
import { authenticate } from '@11e/auth';
import { createDb } from '@11e/db';
import { observe, setupTelemetry } from '@11e/observability';
import { buildApp } from './app.js';
import { SCHEMA, SERVICE, loadConfig } from './config.js';
import type { ${Svc}Db } from './adapters/db.js';

export function compose(env: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(env);
  const telemetry = setupTelemetry({ serviceName: SERVICE, env });
  const handle = createDb<${Svc}Db>({ connectionString: config.databaseUrl, schema: SCHEMA, maxConnections: config.poolMax });
  const obs = observe(SERVICE);
  const auth = authenticate({ service: SERVICE, jwksUrl: config.jwksUrl, cronSecret: config.cronSecret });
  const svc = buildApp({ config, db: handle.db, obs, auth });
  return {
    config,
    app: svc.app,
    shutdown: async () => {
      await handle.close();
      await telemetry.shutdown();
    },
  };
}
`,
  );

  put(
    svc,
    'src/server.ts',
    `// Local server (\`pnpm dev\`). Vercel uses api/index.ts instead.
import { serve } from '@hono/node-server';
import { compose } from './main.js';

const { app, config, shutdown } = compose();
const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) =>
  process.stdout.write(\`${svc} listening on http://127.0.0.1:\${info.port}\\n\`),
);
const stop = () => server.close(() => void shutdown().then(() => process.exit(0)));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
`,
  );

  put(
    svc,
    'api/index.ts',
    `// Vercel Node function entry (region bom1, 60 s): every path is rewritten here (vercel.json).
import { getRequestListener } from '@hono/node-server';
import { compose } from '../src/main.js';

const { app } = compose();
export default getRequestListener(app.fetch);
`,
  );

  put(
    svc,
    'tests/platform.test.ts',
    `// Platform wiring on the local stack (\`pnpm db:start\`): migrations, health, authentication, and the relay, drain and jobs endpoints.
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticate } from '@11e/auth';
import { createDb, migrate } from '@11e/db';
import { observe } from '@11e/observability';
import { buildApp } from '../src/app.js';
import { EXPECTED_MIGRATION, SCHEMA, SERVICE, loadConfig } from '../src/config.js';
import type { ${Svc}Db } from '../src/adapters/db.js';

const HOST = '127.0.0.1:54322/postgres';
const env = {
  DATABASE_URL: process.env['${ENV}_DATABASE_URL'] ?? \`postgresql://\${SCHEMA}_svc:local_\${SCHEMA}_svc@\${HOST}\`,
  MIGRATOR_DATABASE_URL: process.env['${ENV}_MIGRATOR_DATABASE_URL'] ?? \`postgresql://\${SCHEMA}_migrator:local_\${SCHEMA}_migrator@\${HOST}\`,
  CRON_SECRET: randomUUID(),
};
const config = loadConfig(env);
const handle = createDb<${Svc}Db>({ connectionString: config.databaseUrl, schema: SCHEMA });
let app: ReturnType<typeof buildApp>['app'];

beforeAll(async () => {
  await migrate({ connectionString: env.MIGRATOR_DATABASE_URL, schema: SCHEMA, dir: new URL('../migrations', import.meta.url).pathname });
  const { publicKey } = await generateKeyPair('ES256');
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' }] };
  const auth = authenticate({ service: SERVICE, jwks, cronSecret: env.CRON_SECRET });
  app = buildApp({ config, db: handle.db, obs: observe(SERVICE, { level: 'fatal' }), auth }).app;
});
afterAll(() => handle.close());

const cron = { 'x-cron-secret': env.CRON_SECRET };

describe('${svc} platform', () => {
  it('EXPECTED_MIGRATION is the newest migration file', () => {
    const newest = readdirSync(new URL('../migrations', import.meta.url)).filter((f) => f.endsWith('.sql')).sort().at(-1);
    expect(newest?.slice(0, 4)).toBe(EXPECTED_MIGRATION);
  });

  it('serves health and readiness', async () => {
    expect((await app.request('/health/live')).status).toBe(200);
    expect(await (await app.request('/health/ready')).json()).toEqual({ status: 'ok', checks: { db: 'ok' } });
  });

  it('relay and drain run with the cron secret and refuse without it', async () => {
    expect((await app.request('/internal/v1/relay', { method: 'POST' })).status).toBe(401);
    const relay = await app.request('/internal/v1/relay', { method: 'POST', headers: cron });
    expect(relay.status).toBe(200); // body shape is checked against the contract (validateResponses in tests)
    const drain = await app.request('/internal/v1/drain/${t.eventQueue}', { method: 'POST', headers: cron });
    expect(drain.status).toBe(200);
  });

  it('rejects unknown queues and jobs', async () => {
    expect((await app.request('/internal/v1/drain/q_nope', { method: 'POST', headers: cron })).status).toBe(400);
    expect((await app.request('/internal/v1/jobs/no-such-job', { method: 'POST', headers: cron })).status).toBe(400);
  });
});
`,
  );

  put(
    svc,
    'README.md',
    `# ${svc}

${t.eventQueue ? '' : ''}Service owner: see CODEOWNERS. Design: [docs/04-lld/${svc}.md](../../docs/04-lld/${svc}.md). Contract:
[contracts/openapi/${svc}.yaml](../../contracts/openapi/${svc}.yaml).

## Run locally
\`\`\`bash
pnpm db:start && pnpm db:env > .env.local     # once, from the repo root
pnpm --filter @11e/${svc} migrate
pnpm --filter @11e/${svc} dev                 # http://127.0.0.1:${localPorts[svc]}
pnpm mock                                     # other services as contract mocks (ports 4010–4016)
\`\`\`

## Environment
| Variable | Local default | Notes |
|---|---|---|
| \`DATABASE_URL\` | \`${ENV}_DATABASE_URL\` from \`pnpm db:env\` | pooler URL with the \`${schema}_svc\` role |
| \`CRON_SECRET\` | \`${ENV}_CRON_SECRET\` | must equal Vault \`cron_secret_${schema}\` |
| \`WEB_URL\` / \`JWKS_URL\` | http://127.0.0.1:${localPorts.web} | service tokens (R-2) |
| \`SERVICE_CREDENTIAL\` | — | only if this service calls another service |
| \`POOL_MAX\` | 3 | capacity plan |
| \`PORT\` | ${localPorts[svc]} | local only |

## Owned data
Schema \`${schema}\` (owner \`${schema}_owner\`, runtime role \`${schema}_svc\`). Technical tables: \`idempotency_keys\`,
\`outbox\`, \`processed_events\`, \`job_leases\`.

## Queues and events
- Event queue: \`${t.eventQueue}\`. Work queues: ${t.workQueues.map((q) => `\`${q}\``).join(', ') || 'none'}.
- Publishes to: ${t.sendsTo.map((q) => `\`${q}\``).join(', ') || 'nobody'}.
- Scheduled jobs: ${jobsEnum.map((j) => `\`${j}\``).join(', ') || 'none'} (see infra/schedules.yaml).
`,
  );
}
process.stdout.write(`scaffolded ${written.length} file(s)\n`);
