// Vercel entry (Services, Hono preset). Local dev uses src/server.ts.
// Public /svc/listings/... requests (scheduler, health checks) still carry the prefix: Vercel doesn't apply the service
// route's path transform in production. Calls from web via the binding arrive without it. The public feed
// (/public/v1/{listings,projects,demand-posts,changes}) arrives with /public the same way.
import { Hono } from 'hono';
import { compose } from './src/main.js';

const { app } = compose();
const entry = new Hono();
entry.mount('/svc/listings', app.fetch);
entry.mount('/public', app.fetch);
entry.mount('/', app.fetch);

export default entry;
