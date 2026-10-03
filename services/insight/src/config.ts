// insight configuration from environment variables (CLAUDE.md §3.6). Vercel sets the plain names; locally the root
// .env.local from `pnpm db:env` provides the INSIGHT_* names.
export const SERVICE = 'insight';
export const SCHEMA = 'insight';
/** Newest file in migrations/ (a test keeps them in step). /health/ready reports "behind" until it is applied. */
export const EXPECTED_MIGRATION = '0004';

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
  /** records base URL (vocabulary, micromarkets, contacts for exports — service token, R-2/R-21). */
  recordsUrl: string;
  /** Hugging Face planner (LLD §4.2): router or dedicated endpoint URL, model id, token (Vercel encrypted env). */
  hfBaseUrl: string | undefined;
  hfModel: string;
  hfToken: string | undefined;
  /** Concurrent model calls per instance: 5 pilot / 20 paid. */
  hfConcurrency: number;
  /** Model time limits (CR-016): per attempt and for the whole planning phase. */
  hfAttemptMs: number;
  hfBudgetMs: number;
  /** Export row cap: 20,000 in the pilot, 100,000 in production (R-16). */
  exportMaxRows: number;
  /** Private export bucket (Supabase Storage); a local directory when the Supabase variables are absent. */
  supabaseUrl: string | undefined;
  supabaseServiceKey: string | undefined;
  exportBucket: string;
  localExportDir: string | undefined;
  environment: string;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const get = (name: string) => env[name] ?? env[`INSIGHT_${name}`];
  const need = (name: string) => {
    const v = get(name);
    if (!v) throw new ConfigError(`missing environment variable ${name} (or INSIGHT_${name})`);
    return v;
  };
  // On Vercel, web is reached on its public production address (bindings may not form cycles: web binds to every service).
  const webUrl =
    get('WEB_URL') ??
    (env['VERCEL_PROJECT_PRODUCTION_URL'] ? `https://${env['VERCEL_PROJECT_PRODUCTION_URL']}` : undefined) ??
    'http://127.0.0.1:3000';
  return {
    port: Number(get('PORT') ?? 3006),
    databaseUrl: need('DATABASE_URL'),
    poolMax: Number(get('POOL_MAX') ?? 3),
    cronSecret: need('CRON_SECRET'),
    jwksUrl: get('JWKS_URL') ?? `${webUrl}/.well-known/jwks.json`,
    serviceCredential: get('SERVICE_CREDENTIAL'),
    webUrl,
    recordsUrl: get('RECORDS_URL') ?? 'http://127.0.0.1:3002',
    hfBaseUrl: get('HF_BASE_URL'),
    hfModel: get('HF_MODEL') ?? 'meta-llama/Llama-3.1-8B-Instruct',
    hfToken: get('HF_TOKEN'),
    hfConcurrency: Number(get('HF_CONCURRENCY') ?? 5),
    hfAttemptMs: Number(get('HF_ATTEMPT_MS') ?? 5_000),
    hfBudgetMs: Number(get('HF_BUDGET_MS') ?? 6_500),
    exportMaxRows: Number(get('EXPORT_MAX_ROWS') ?? 20_000),
    supabaseUrl: get('SUPABASE_URL'),
    supabaseServiceKey: get('SUPABASE_SERVICE_ROLE_KEY'),
    exportBucket: get('EXPORT_BUCKET') ?? 'insight-exports',
    localExportDir: get('LOCAL_EXPORT_DIR'),
    environment: get('ENVIRONMENT_NAME') ?? 'local',
  };
}
