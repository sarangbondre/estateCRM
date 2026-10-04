// The paths this service answers under. The load balancer (AWS, CR-018) and Vercel both forward /svc/records/...
// unchanged (scheduler, health checks), so the app is mounted there as well as at /, where web's internal calls
// arrive.
import { Hono } from 'hono';

type Fetch = Hono['fetch'];

export function withPrefixes(fetch: Fetch): Hono {
  const entry = new Hono();
  entry.mount('/svc/records', fetch);
  entry.mount('/', fetch);
  return entry;
}
