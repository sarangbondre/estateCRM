// records configuration from environment variables (CLAUDE.md §3.6). Vercel sets the plain names; locally the root
// .env.local from `pnpm db:env` provides the RECORDS_* names.
export const SERVICE = 'records';
export const SCHEMA = 'records';
/** Newest file in migrations/ (a test keeps them in step). /health/ready reports "behind" until it is applied. */
export const EXPECTED_MIGRATION = '0005';

export interface Config {
  port: number;
  databaseUrl: string;
  poolMax: number;
  cronSecret: string;
  /** web's JWKS (service tokens, R-2). */
  jwksUrl: string;
  /** This service's credential for web POST /internal/v1/service-tokens (records → intake row fetch). */
  serviceCredential: string | undefined;
  webUrl: string;
  environment: string;
  /** intake base URL (GET /internal/v1/uploads/{id}/rows). */
  intakeUrl: string;
  /** HMAC secret for phone/email/building hashes (secrets manager). */
  contactHashSecret: string;
  /** Scan-term salt shared with listings (R-20) and its version. */
  scanSalt: string;
  scanSaltVersion: number;
  /** Tenants whose scheduled jobs this deployment runs (Phase 1: 11 Estates). */
  tenantIds: string[];
  /** Supabase Storage (bucket records-photos). */
  storageUrl: string | undefined;
  storageServiceKey: string | undefined;
  photoBucket: string;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const get = (name: string) => env[name] ?? env[`RECORDS_${name}`];
  const need = (name: string) => {
    const v = get(name);
    if (!v) throw new ConfigError(`missing environment variable ${name} (or RECORDS_${name})`);
    return v;
  };
  const environment = get('ENVIRONMENT_NAME') ?? 'local';
  const local = environment === 'local' || environment === 'test';
  /** Secrets have throwaway defaults only on a developer machine. */
  const secret = (name: string, localDefault: string) => get(name) ?? (local ? localDefault : need(name));
  // On Vercel, web is reached on its public production address (bindings may not form cycles: web binds to every service).
  const webUrl =
    get('WEB_URL') ??
    (env['VERCEL_PROJECT_PRODUCTION_URL'] ? `https://${env['VERCEL_PROJECT_PRODUCTION_URL']}` : undefined) ??
    'http://127.0.0.1:3000';
  return {
    port: Number(get('PORT') ?? 3002),
    databaseUrl: need('DATABASE_URL'),
    poolMax: Number(get('POOL_MAX') ?? 3),
    cronSecret: need('CRON_SECRET'),
    jwksUrl: get('JWKS_URL') ?? `${webUrl}/.well-known/jwks.json`,
    serviceCredential: get('SERVICE_CREDENTIAL'),
    webUrl,
    environment,
    intakeUrl: get('INTAKE_URL') ?? 'http://127.0.0.1:3001',
    contactHashSecret: secret('CONTACT_HASH_SECRET', 'local-contact-hash-secret'),
    scanSalt: secret('SCAN_SALT', 'local-scan-salt'),
    scanSaltVersion: Number(get('SCAN_SALT_VERSION') ?? 1),
    tenantIds: (get('TENANT_IDS') ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    storageUrl: get('STORAGE_URL'),
    storageServiceKey: get('STORAGE_SERVICE_KEY'),
    photoBucket: get('PHOTO_BUCKET') ?? 'records-photos',
  };
}
