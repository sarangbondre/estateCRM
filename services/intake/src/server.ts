// Node server: containers (AWS ECS, CR-018) and local dev (`pnpm dev`). Vercel uses index.ts instead.
import { serve } from '@hono/node-server';
import { compose } from './main.js';
import { withPrefixes } from './entry.js';

const { app, config, shutdown } = compose();
const server = serve({ fetch: withPrefixes(app.fetch).fetch, port: config.port, hostname: '0.0.0.0' }, (info) =>
  process.stdout.write(`intake listening on http://127.0.0.1:${info.port}\n`),
);
const stop = () => server.close(() => void shutdown().then(() => process.exit(0)));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
