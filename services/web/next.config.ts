// Next.js config for web (docs/04-lld/web.md §2). Server-only packages that use Node APIs are required natively.
import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The gateway, sign-in and service-token code run on the Node runtime; these use Node APIs (pg, pino, OTel).
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
