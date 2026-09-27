// Gateway routes on web's Hono app (web LLD §4.3): every /v1 path that is not one of web's own operations, and the
// public proposal page /p/{token}. Registered after the own operations, so those always win.
import type { Hono } from 'hono';
import { HttpError } from '@11e/http';
import type { ServiceContext, ServiceEnv } from '@11e/http';
import { MAX_BODY_BYTES } from '../../application/gateway';
import type { Gateway } from '../../application/gateway';
import type { Keyring } from '../crypto';
import { authenticateStaff, toHttpError } from './security';
import type { StaffAuthDeps } from './security';

export interface GatewayRouteDeps {
  gateway: Gateway;
  staffAuth: StaffAuthDeps;
  keyring: Keyring;
}

function clientIp(c: ServiceContext): string {
  const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  return fwd || c.req.header('x-real-ip') || 'unknown';
}

async function readBody(c: ServiceContext): Promise<Uint8Array<ArrayBuffer> | null> {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return null;
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'payload-too-large');
  const buf = new Uint8Array(await c.req.arrayBuffer());
  if (buf.byteLength > MAX_BODY_BYTES) throw new HttpError(413, 'payload-too-large');
  return buf.byteLength ? buf : null;
}

export function registerGateway(app: Hono<ServiceEnv>, deps: GatewayRouteDeps): void {
  const handler = async (c: ServiceContext) => {
    const url = new URL(c.req.url);
    const route = deps.gateway.target(url.pathname);
    // web's own paths reach here only for methods the contract doesn't define.
    if (route?.service === 'web') throw new HttpError(404, 'not-found');
    if (!route) throw new HttpError(404, 'route-not-found');
    const cookies: string[] = [];
    try {
      const res = await deps.gateway.handle(
        {
          method: c.req.method,
          path: url.pathname,
          search: url.search,
          headers: c.req.raw.headers,
          body: await readBody(c),
          correlationId: c.get('correlationId'),
          clientKey: deps.keyring.hmac('ip-hash', clientIp(c)).toString('hex'),
        },
        () => authenticateStaff(c, deps.staffAuth, cookies),
      );
      for (const sc of cookies) res.headers.append('set-cookie', sc);
      return res;
    } catch (err) {
      throw toHttpError(err);
    }
  };
  app.all('/v1/*', handler);
  app.get('/p/*', handler);
}
