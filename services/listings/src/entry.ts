// The paths this service answers under. The load balancer (AWS, CR-018) and Vercel both forward /svc/listings/...
// unchanged (scheduler, health checks), so the app is mounted there as well as at /, where web's internal calls
// arrive. The public feed (/public/v1/{listings,projects,demand-posts,changes}) arrives with /public the same way.
import { Hono } from 'hono';

type Fetch = Hono['fetch'];

export function withPrefixes(fetch: Fetch): Hono {
  const entry = new Hono();
  entry.mount('/svc/listings', fetch);
  entry.mount('/public', fetch);
  entry.mount('/', fetch);
  return entry;
}
