// intake configuration from environment variables (CLAUDE.md §3.6). Vercel sets the plain names; locally the root
// .env.local from `pnpm db:env` provides the INTAKE_* names.
export const SERVICE = 'intake';
export const SCHEMA = 'intake';
/** Newest file in migrations/ (a test keeps them in step). /health/ready reports "behind" until it is applied. */
export const EXPECTED_MIGRATION = '0003';

export interface Config {
  port: number;
  databaseUrl: string;
  poolMax: number;
  cronSecret: string;
  /** web's JWKS (service tokens, R-2). */
  jwksUrl: string;
  /** This service's credential for web POST /internal/v1/service-tokens (vocabulary fetch from records). */
  serviceCredential: string | undefined;
  webUrl: string;
  environment: string;
  /** Supabase project URL (Storage API) and service-role key (secret). */
  storageUrl: string | undefined;
  storageServiceKey: string | undefined;
  /** Pilot mode until the paid-plan gate (CR-005, CR-006 Z-9). */
  pilotMode: boolean;
  chunkSize: number;
  chunkConcurrency: number;
  /** records base URL (vocabulary, micromarkets). */
  recordsUrl: string | undefined;
  /** Hugging Face (ADR-0004): token (secret), model id and OpenAI-compatible endpoint. */
  hfToken: string | undefined;
  hfModel: string;
  hfEndpointUrl: string;
  /** Secret for the pilot anonymiser's HMAC (per-tenant keys are derived from it). */
  anonymisationKey: string;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const bool = (v: string | undefined, fallback: boolean) =>
  v === undefined || v === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

/** Local and test runs get a fixed development key; deployed pilots must set ANONYMISATION_KEY. */
function anonymisationKey(value: string | undefined, environment: string, pilotMode: boolean): string {
  if (value) return value;
  if (!pilotMode || ['local', 'test'].includes(environment)) return 'local-development-anonymisation-key';
  throw new ConfigError('missing environment variable ANONYMISATION_KEY (or INTAKE_ANONYMISATION_KEY)');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const get = (name: string) => env[name] ?? env[`INTAKE_${name}`];
  const need = (name: string) => {
    const v = get(name);
    if (!v) throw new ConfigError(`missing environment variable ${name} (or INTAKE_${name})`);
    return v;
  };
  const webUrl = get('WEB_URL') ?? 'http://127.0.0.1:3000';
  const pilotMode = bool(get('PILOT_MODE'), true);
  return {
    port: Number(get('PORT') ?? 3001),
    databaseUrl: need('DATABASE_URL'),
    poolMax: Number(get('POOL_MAX') ?? 3),
    cronSecret: need('CRON_SECRET'),
    jwksUrl: get('JWKS_URL') ?? `${webUrl}/.well-known/jwks.json`,
    serviceCredential: get('SERVICE_CREDENTIAL'),
    webUrl,
    environment: get('ENVIRONMENT_NAME') ?? 'local',
    storageUrl: get('STORAGE_URL') ?? env['SUPABASE_URL'],
    storageServiceKey: get('STORAGE_SERVICE_KEY') ?? env['SUPABASE_SERVICE_ROLE_KEY'],
    pilotMode,
    chunkSize: Number(get('CHUNK_SIZE') ?? (pilotMode ? 500 : 2000)),
    chunkConcurrency: Number(get('CHUNK_CONCURRENCY') ?? (pilotMode ? 5 : 12)),
    recordsUrl: get('RECORDS_URL'),
    anonymisationKey: anonymisationKey(
      get('ANONYMISATION_KEY'),
      get('ENVIRONMENT_NAME') ?? 'local',
      pilotMode,
    ),
    hfToken: get('HF_TOKEN'),
    hfModel: get('HF_MODEL') ?? 'meta-llama/Llama-3.1-8B-Instruct',
    hfEndpointUrl: get('HF_ENDPOINT_URL') ?? 'https://router.huggingface.co',
  };
}
