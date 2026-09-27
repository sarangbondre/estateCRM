// journeys configuration from environment variables (CLAUDE.md §3.6). Vercel sets the plain names; locally the root
// .env.local from `pnpm db:env` provides the JOURNEYS_* names.
export const SERVICE = 'journeys';
export const SCHEMA = 'journeys';
/** Newest file in migrations/ (a test keeps them in step). /health/ready reports "behind" until it is applied. */
export const EXPECTED_MIGRATION = '0004';

export interface Config {
  port: number;
  databaseUrl: string;
  poolMax: number;
  cronSecret: string;
  /** web's JWKS (service tokens, R-2). */
  jwksUrl: string;
  /** This service's credential for web POST /internal/v1/service-tokens (records and listings reads). */
  serviceCredential: string | undefined;
  webUrl: string;
  environment: string;
  /** records base URL (proposal snapshot: GET /v1/offers, /v1/properties). Local: the contract mock. */
  recordsUrl: string;
  /** listings base URL (GET /v1/publication-settings). Local: the contract mock. */
  listingsUrl: string;
  /** Base of web's public proposal route: `${publicBaseUrl}/p/{token}`. */
  publicBaseUrl: string;
  /** Salt for proposal-link open IP hashes (secret; rotated monthly with the month mixed in). */
  ipHashSalt: string;
  supabaseUrl: string | undefined;
  supabaseServiceKey: string | undefined;
  storageBucket: string;
  /** Local development without Supabase Storage. */
  localStorageDir: string | undefined;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const get = (name: string) => env[name] ?? env[`JOURNEYS_${name}`];
  const need = (name: string) => {
    const v = get(name);
    if (!v) throw new ConfigError(`missing environment variable ${name} (or JOURNEYS_${name})`);
    return v;
  };
  const webUrl = get('WEB_URL') ?? 'http://127.0.0.1:3000';
  const environment = get('ENVIRONMENT_NAME') ?? 'local';
  const salt = get('IP_HASH_SALT');
  if (!salt && environment !== 'local' && environment !== 'test')
    throw new ConfigError('missing environment variable IP_HASH_SALT (or JOURNEYS_IP_HASH_SALT)');
  return {
    port: Number(get('PORT') ?? 3003),
    databaseUrl: need('DATABASE_URL'),
    poolMax: Number(get('POOL_MAX') ?? 3),
    cronSecret: need('CRON_SECRET'),
    jwksUrl: get('JWKS_URL') ?? `${webUrl}/.well-known/jwks.json`,
    serviceCredential: get('SERVICE_CREDENTIAL'),
    webUrl,
    environment,
    recordsUrl: get('RECORDS_URL') ?? 'http://127.0.0.1:4012',
    listingsUrl: get('LISTINGS_URL') ?? 'http://127.0.0.1:4015',
    publicBaseUrl: get('PUBLIC_BASE_URL') ?? webUrl,
    ipHashSalt: salt ?? 'local-only-salt',
    supabaseUrl: get('SUPABASE_URL'),
    supabaseServiceKey: get('SUPABASE_SERVICE_ROLE_KEY'),
    storageBucket: get('STORAGE_BUCKET') ?? 'journeys-proposals',
    localStorageDir: get('LOCAL_STORAGE_DIR'),
  };
}
