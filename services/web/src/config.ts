// web configuration from environment variables (CLAUDE.md §3.6). Vercel sets the plain names; locally the root
// .env.local (`pnpm db:env`) provides WEB_* database names and services/web/.env.local (`pnpm env:local`) the rest.
export const SERVICE = 'web';
export const SCHEMA = 'web';
/** Newest file in migrations/ (a test keeps them in step). /health/ready reports "behind" until it is applied. */
export const EXPECTED_MIGRATION = '0002';

export const DOWNSTREAMS = ['intake', 'records', 'journeys', 'crm-engine', 'listings', 'insight'] as const;
export type Downstream = (typeof DOWNSTREAMS)[number];

export interface Config {
  databaseUrl: string;
  poolMax: number;
  cronSecret: string;
  /** Public origin of the app (CSRF origin check, OAuth redirects), e.g. https://crm.11estates.in. */
  appOrigin: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string | undefined;
  /** 32-byte key (base64) that encrypts signing keys and keys the e-mail / credential / IP HMACs. */
  kek: Buffer;
  /** Phase 1 has one tenant (11 Estates); new users get it. */
  tenantId: string;
  environment: 'local' | 'pilot' | 'dev' | 'staging' | 'production';
  pilot: boolean;
  /** Local-only e-mail link sign-in (Supabase local Inbucket), for development without Google OAuth. */
  localEmailSignIn: boolean;
  serviceUrls: Record<Downstream, string>;
  /** Extra wait for a backend function that is cold-starting (CR-014): on Vercel 6 s by default, locally 0. */
  coldStartAllowanceMs: number;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const ENVIRONMENTS = ['local', 'pilot', 'dev', 'staging', 'production'] as const;
const LOCAL_PORTS: Record<Downstream, number> = {
  intake: 4011,
  records: 4012,
  journeys: 4013,
  'crm-engine': 4014,
  listings: 4015,
  insight: 4016,
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const get = (name: string) => env[name] ?? env[`WEB_${name}`];
  const need = (name: string) => {
    const v = get(name);
    if (!v) throw new ConfigError(`missing environment variable ${name} (or WEB_${name})`);
    return v;
  };
  const environment = (get('ENVIRONMENT_NAME') ?? 'local') as Config['environment'];
  if (!ENVIRONMENTS.includes(environment))
    throw new ConfigError(`ENVIRONMENT_NAME must be one of ${ENVIRONMENTS.join(', ')}`);
  const kek = Buffer.from(need('KEK'), 'base64');
  if (kek.length !== 32) throw new ConfigError('WEB_KEK must be 32 bytes, base64');
  const tenantId = need('TENANT_ID');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId))
    throw new ConfigError('WEB_TENANT_ID must be a uuid');
  const serviceUrls = Object.fromEntries(
    Object.entries(LOCAL_PORTS).map(([svc, port]) => {
      const key = `SVC_${svc.toUpperCase().replace('-', '_')}_URL`;
      return [svc, env[key] ?? `http://127.0.0.1:${port}`];
    }),
  ) as Record<Downstream, string>;
  return {
    databaseUrl: need('DATABASE_URL'),
    poolMax: Number(get('POOL_MAX') ?? 3),
    cronSecret: need('CRON_SECRET'),
    appOrigin: (get('APP_ORIGIN') ?? 'http://127.0.0.1:3000').replace(/\/$/, ''),
    supabaseUrl: (env['SUPABASE_URL'] ?? env['NEXT_PUBLIC_SUPABASE_URL'] ?? 'http://127.0.0.1:54321').replace(
      /\/$/,
      '',
    ),
    supabaseAnonKey:
      env['SUPABASE_ANON_KEY'] ?? env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] ?? need('SUPABASE_ANON_KEY'),
    supabaseServiceRoleKey: env['SUPABASE_SERVICE_ROLE_KEY'],
    kek,
    tenantId,
    environment,
    pilot:
      (get('PILOT') ?? (environment === 'local' || environment === 'pilot' ? 'true' : 'false')) === 'true',
    localEmailSignIn: environment === 'local' && get('LOCAL_EMAIL_SIGNIN') !== 'false',
    serviceUrls,
    coldStartAllowanceMs: Number(get('COLD_START_ALLOWANCE_MS') ?? (env['VERCEL'] ? 6000 : 0)),
  };
}
