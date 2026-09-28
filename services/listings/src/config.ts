// listings configuration from environment variables (CLAUDE.md §3.6). Vercel sets the plain names; locally the root
// .env.local from `pnpm db:env` provides the LISTINGS_* names.
export const SERVICE = 'listings';
export const SCHEMA = 'listings';
/** Newest file in migrations/ (a test keeps them in step). /health/ready reports "behind" until it is applied. */
export const EXPECTED_MIGRATION = '0002';

export interface Config {
  port: number;
  databaseUrl: string;
  poolMax: number;
  cronSecret: string;
  /** web's JWKS (service tokens, R-2). */
  jwksUrl: string;
  /** This service's credential for web POST /internal/v1/service-tokens (records reads: scan terms, photos). */
  serviceCredential: string | undefined;
  webUrl: string;
  environment: string;
  /** records base URL (scan terms R-20, micromarkets R-13, photo signed URLs L-2). Local: the contract mock. */
  recordsUrl: string;
  /** Salt shared with records for scan-term hashes (R-20). Secrets manager; local default only on a dev machine. */
  scanSalt: string;
  /** Supabase Storage (photo renditions). Unset locally: photos stay pending. */
  storageUrl: string | undefined;
  storageServiceKey: string | undefined;
  privateBucket: string;
  publicBucket: string;
  /** Change-feed rows younger than this are held back (late commits can't be skipped). */
  feedSettleMs: number;
  /** Positive API-key cache per instance (revocation takes effect within this, LLD §4.10). */
  apiKeyCacheTtlMs: number;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const get = (name: string) => env[name] ?? env[`LISTINGS_${name}`];
  const need = (name: string) => {
    const v = get(name);
    if (!v) throw new ConfigError(`missing environment variable ${name} (or LISTINGS_${name})`);
    return v;
  };
  const environment = get('ENVIRONMENT_NAME') ?? 'local';
  const local = environment === 'local' || environment === 'test';
  const secret = (name: string, localDefault: string) => get(name) ?? (local ? localDefault : need(name));
  const webUrl = get('WEB_URL') ?? 'http://127.0.0.1:3000';
  return {
    port: Number(get('PORT') ?? 3005),
    databaseUrl: need('DATABASE_URL'),
    poolMax: Number(get('POOL_MAX') ?? 3),
    cronSecret: need('CRON_SECRET'),
    jwksUrl: get('JWKS_URL') ?? `${webUrl}/.well-known/jwks.json`,
    serviceCredential: get('SERVICE_CREDENTIAL'),
    webUrl,
    environment,
    recordsUrl: get('RECORDS_URL') ?? 'http://127.0.0.1:4012',
    scanSalt: secret('SCAN_SALT', 'local-scan-salt'),
    storageUrl: get('STORAGE_URL'),
    storageServiceKey: get('STORAGE_SERVICE_KEY'),
    privateBucket: get('PRIVATE_BUCKET') ?? 'listings-photos',
    publicBucket: get('PUBLIC_BUCKET') ?? 'listings-public',
    feedSettleMs: Number(get('FEED_SETTLE_MS') ?? 5000),
    apiKeyCacheTtlMs: Number(get('API_KEY_CACHE_TTL_MS') ?? 30_000),
  };
}

/**
 * Production requires the MahaRERA agent number before anything is served (BRD §4.6); every other environment is the
 * pilot, where publishing is allowed with "MahaRERA registration pending" (questionnaire A7).
 */
export const agentNumberRequired = (config: Config) => config.environment === 'production';
