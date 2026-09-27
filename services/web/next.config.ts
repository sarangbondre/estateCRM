// Next.js config for web (docs/04-lld/web.md §2). Server-only packages that use Node APIs are required natively.
import type { NextConfig } from 'next';

// Local development: the root .env.local (`pnpm db:env`) holds WEB_DATABASE_URL / WEB_CRON_SECRET; Next.js itself
// reads services/web/.env.local (`pnpm env:local`). Variables already set win.
try {
  process.loadEnvFile(new URL('../../.env.local', import.meta.url));
} catch {
  /* not present (CI, Vercel) */
}

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ['pg', 'pino', 'kysely', '@opentelemetry/api', '@opentelemetry/sdk-node'],
  typescript: { tsconfigPath: './tsconfig.json' },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default config;
