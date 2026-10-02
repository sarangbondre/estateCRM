// Vercel entry (Services, Hono preset). Local dev uses src/server.ts.
// Public /svc/listings/... requests (scheduler, health checks) still carry the prefix: Vercel doesn't apply the service
// route's path transform in production. Calls from web via the binding arrive without it.
import { Hono } from 'hono';
import { compose } from './src/main.js';

const { app } = compose();
const entry = new Hono();
entry.mount('/svc/listings', app.fetch);
entry.mount('/', app.fetch);

export default entry;
