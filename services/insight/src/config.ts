// insight configuration from environment variables (CLAUDE.md §3.6). Vercel sets the plain names; locally the root
// .env.local from `pnpm db:env` provides the INSIGHT_* names.
export const SERVICE = 'insight';
export const SCHEMA = 'insight';
/** Newest file in migrations/ (a test keeps them in step). /health/ready reports "behind" until it is applied. */
export const EXPECTED_MIGRATION = '0002';

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
  const get = (name: string) => env[name] ?? env[`INSIGHT_${name}`];
  const need = (name: string) => {
    const v = get(name);
    if (!v) throw new ConfigError(`missing environment variable ${name} (or INSIGHT_${name})`);
    return v;
  };
  const webUrl = get('WEB_URL') ?? 'http://127.0.0.1:3000';
  return {
    port: Number(get('PORT') ?? 3006),
    databaseUrl: need('DATABASE_URL'),
    poolMax: Number(get('POOL_MAX') ?? 3),
    cronSecret: need('CRON_SECRET'),
    jwksUrl: get('JWKS_URL') ?? `${webUrl}/.well-known/jwks.json`,
    serviceCredential: get('SERVICE_CREDENTIAL'),
    webUrl,
    environment: get('ENVIRONMENT_NAME') ?? 'local',
  };
}
