// Local server (`pnpm dev`). Vercel uses index.ts instead.
import { serve } from '@hono/node-server';
import { compose } from './main.js';

const { app, config, shutdown } = compose();
const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) =>
  process.stdout.write(`crm-engine listening on http://127.0.0.1:${info.port}\n`),
);
const stop = () => server.close(() => void shutdown().then(() => process.exit(0)));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
