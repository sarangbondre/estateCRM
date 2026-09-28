// Admin routes (US-34): RERA publication settings (journeys reads them with a service token) and website API keys.
import type { components, operations } from '@11e/contracts/listings';
import { beginIdempotent, completeIdempotent, hashRequest, releaseIdempotent } from '@11e/db';
import { HttpError, idempotent, ifMatchVersion, pageLimit } from '@11e/http';
import type { Service, ServiceContext } from '@11e/http';
import { principalOf, requireStaff, tenantOf } from '@11e/auth';
import {
  createApiKey,
  getSettings,
  listApiKeys,
  putSettings,
  revokeApiKey,
  rotateApiKey,
} from '../application/admin.js';
import type { ApiKeyRow } from '../application/ports.js';
import type { Actor } from '../application/publication.js';
import type { PublicationSettings } from '../domain/types.js';
import type { AppDeps } from '../deps.js';
import { ALL_STAFF, encode, iso, keysetCursor, run, staffActor, withEtag } from './http-support.js';

type Schemas = components['schemas'];

function settingsOut(s: PublicationSettings): Schemas['PublicationSettings'] {
  return {
    mahareraAgentNumber: s.mahareraAgentNumber ?? '',
    subjectToConfirmationNote: s.note,
    version: s.version,
    updatedAt: s.updatedAt.toISOString(),
    updatedBy: s.updatedBy,
  };
}

function keyOut(k: ApiKeyRow): Schemas['ApiKey'] {
  return {
    keyId: k.id,
    name: k.name,
    prefix: k.prefix,
    status: k.status,
    rateLimitRps: k.rateLimitRps,
    burst: k.burst,
    allowedOrigins: k.allowedOrigins,
    graceEndsAt: iso(k.graceEndsAt),
    replacedByKeyId: k.replacedByKeyId,
    lastUsedAt: iso(k.lastUsedAt),
    createdAt: k.createdAt.toISOString(),
    createdBy: k.createdBy,
    revokedAt: iso(k.revokedAt),
  };
}

export function registerAdminRoutes(svc: Service<operations>, deps: AppDeps): void {
  const s = deps.services;

  // --- settings (journeys reads with a service token)
  svc.op('getPublicationSettings', async (c) => {
    const p = principalOf(c);
    if (p.kind === 'staff') requireStaff(c, ALL_STAFF);
    const settings = await run(() => getSettings(s, tenantOf(c), c.get('correlationId')));
    withEtag(c, settings.version);
    return c.json(settingsOut(settings));
  });
  svc.op('putPublicationSettings', async (c, { body }) => {
    const actor = staffActor(c, ['Admin']);
    const saved = await run(() =>
      putSettings(s, actor, {
        mahareraAgentNumber: body.mahareraAgentNumber,
        subjectToConfirmationNote: body.subjectToConfirmationNote,
        ifMatch: ifMatchVersion(c),
      }),
    );
    withEtag(c, saved.version);
    return c.json(settingsOut(saved));
  });

  // --- API keys
  /** The plaintext secret is never stored, not even in the idempotency store: a replay omits it. */
  const keyIdempotent = async (
    c: ServiceContext,
    actor: Actor,
    body: unknown,
    handler: () => Promise<{ key: ApiKeyRow; secret: string }>,
  ) => {
    const header = c.req.header('idempotency-key');
    if (!header) {
      const r = await run(handler);
      return c.json({ ...keyOut(r.key), secret: r.secret }, 201);
    }
    const ref = {
      tenantId: actor.tenantId,
      userId: actor.userId,
      route: `${c.req.method} ${c.get('operation')?.path ?? c.req.routePath}`,
      key: header,
    };
    const begin = await beginIdempotent(deps.db, ref, hashRequest(body ?? null));
    if (begin.outcome === 'replay') {
      c.header('idempotent-replayed', 'true');
      if (begin.statusCode >= 400) {
        c.header('content-type', 'application/problem+json');
        return c.body(JSON.stringify(begin.body), begin.statusCode as 409);
      }
      return c.json(begin.body as object, 201);
    }
    if (begin.outcome === 'conflict') throw new HttpError(409, 'idempotency-key-reused');
    if (begin.outcome === 'in-progress')
      throw new HttpError(409, 'conflict', { headers: { 'retry-after': '1' } });
    try {
      const r = await run(handler);
      await completeIdempotent(deps.db, ref, 201, keyOut(r.key));
      return c.json({ ...keyOut(r.key), secret: r.secret }, 201);
    } catch (err) {
      if (err instanceof HttpError && err.status < 500)
        await completeIdempotent(deps.db, ref, err.status, {
          type: `https://errors.11estates.in/${err.code}`,
          title: err.code,
          status: err.status,
          code: err.code,
          correlationId: c.get('correlationId'),
        });
      else await releaseIdempotent(deps.db, ref);
      throw err;
    }
  };

  svc.op('listApiKeys', async (c, { query }) => {
    const actor = staffActor(c, ['Admin']);
    const limit = pageLimit(query.limit);
    const rows = await run(() => listApiKeys(s, actor, query.status, limit, keysetCursor(query.cursor)));
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return c.json({
      items: items.map(keyOut),
      nextCursor:
        rows.length > limit && last ? encode({ t: last.createdAt.toISOString(), id: last.id }) : null,
    });
  });
  svc.op('createApiKey', (c, { body }) => {
    const actor = staffActor(c, ['Admin']);
    return keyIdempotent(c, actor, body, () =>
      createApiKey(s, deps.keyHasher, actor, {
        name: body.name,
        allowedOrigins: body.allowedOrigins,
        rateLimitRps: body.rateLimitRps,
        burst: body.burst,
      }),
    );
  });
  svc.op('rotateApiKey', (c, { params, body }) => {
    const actor = staffActor(c, ['Admin']);
    return keyIdempotent(c, actor, { keyId: params.keyId, ...(body ?? {}) }, async () => {
      const r = await rotateApiKey(s, deps.keyHasher, actor, params.keyId, body?.graceHours ?? 168);
      deps.website.invalidate();
      return r;
    });
  });
  svc.op('revokeApiKey', async (c, { params }) => {
    const actor = staffActor(c, ['Admin']);
    return idempotent(c, deps.db, actor, { keyId: params.keyId }, async () => {
      const key = await run(() => revokeApiKey(s, actor, params.keyId));
      deps.website.invalidate();
      return { status: 200, body: keyOut(key) };
    });
  });
}
