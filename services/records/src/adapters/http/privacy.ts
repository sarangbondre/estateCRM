// Contact privacy and photo routes (REC-08, REC-09): reveals (audited, 60/h, no-store; an idempotent replay keeps
// only the audit id, never the revealed values), contacts batch (insight), scan terms (listings), photos.
import { beginIdempotent, completeIdempotent, hashRequest, releaseIdempotent } from '@11e/db';
import type { operations } from '@11e/contracts/records';
import { HttpError } from '@11e/http';
import type { Service } from '@11e/http';
import type { AppDeps } from '../../deps.js';
import { attachPhoto, deletePhoto, internalSignedUrl, requestPhotoUpload } from '../../application/photos.js';
import { contactsBatch, replayReveal, revealContact, scanTerms } from '../../application/privacy.js';
import type { RevealFields, RevealSubject } from '../../application/privacy.js';
import { photoDto } from './presenters.js';
import { actorOf, guard, json, withIdempotency, wrap } from './support.js';

type Ops = operations;

const revealBody = (subjectType: string, subjectId: string, auditId: string, fields: RevealFields) => ({
  subjectType,
  subjectId,
  auditId,
  fields,
});

export function registerPrivacyRoutes(svc: Service<Ops>, deps: AppDeps): void {
  const { app, db } = deps;

  svc.op(
    'revealContact',
    wrap(async (c, { body }) => {
      const actor = actorOf(c);
      c.header('cache-control', 'no-store');
      const key = c.req.header('idempotency-key');
      const input = { subjectType: body.subjectType as RevealSubject, subjectId: body.subjectId, purpose: body.purpose, via: body.via };
      if (!key) {
        const r = await guard(() => revealContact(app, actor, input));
        return json(c, revealBody(body.subjectType, body.subjectId, r.auditId, r.fields));
      }
      const ref = { tenantId: actor.tenantId, userId: actor.userId, route: 'POST /v1/reveals', key };
      const begin = await beginIdempotent(db, ref, hashRequest(body));
      if (begin.outcome === 'conflict') throw new HttpError(409, 'idempotency-key-reused');
      if (begin.outcome === 'in-progress') throw new HttpError(409, 'conflict', { headers: { 'retry-after': '1' } });
      if (begin.outcome === 'replay') {
        const stored = begin.body as { auditId?: string };
        if (begin.statusCode >= 400 || !stored.auditId) {
          c.header('content-type', 'application/problem+json');
          return c.body(JSON.stringify(begin.body), begin.statusCode as 400);
        }
        c.header('idempotent-replayed', 'true');
        const fields = await guard(() => replayReveal(app, actor, input.subjectType, input.subjectId));
        return json(c, revealBody(body.subjectType, body.subjectId, stored.auditId, fields));
      }
      try {
        const r = await guard(() => revealContact(app, actor, input));
        // Only the audit id is stored for replays (records LLD §3.19): never the revealed values.
        await completeIdempotent(db, ref, 200, { auditId: r.auditId });
        return json(c, revealBody(body.subjectType, body.subjectId, r.auditId, r.fields));
      } catch (err) {
        await releaseIdempotent(db, ref);
        throw err;
      }
    }),
  );

  svc.op(
    'internalContactsBatch',
    wrap(async (c, { body }) => {
      const actor = actorOf(c);
      c.header('cache-control', 'no-store');
      const r = await guard(() => contactsBatch(app, actor, { personIds: body.personIds, exportId: body.exportId, requestedBy: body.requestedBy }));
      return json(c, r);
    }),
  );

  svc.op(
    'internalGetScanTerms',
    wrap(async (c, { params }) => json(c, await guard(() => scanTerms(app, actorOf(c), params.id)))),
  );

  // --- photos (REC-09) ------------------------------------------------------------------------------------
  svc.op(
    'requestPhotoUpload',
    wrap(async (c, { body }) => {
      const actor = actorOf(c);
      return withIdempotency(c, deps, actor, body, async () => ({
        status: 201,
        body: await requestPhotoUpload(app, actor, body),
      }));
    }),
  );

  svc.op(
    'attachPhoto',
    wrap(async (c, { params, body }) => {
      const actor = actorOf(c);
      return withIdempotency(c, deps, actor, body ?? {}, async () => {
        const photo = await attachPhoto(app, actor, params.id, body?.offerIds);
        return { status: 200, body: photoDto(photo, null) };
      });
    }),
  );

  svc.op(
    'deletePhoto',
    wrap(async (c, { params }) => {
      await guard(() => deletePhoto(app, actorOf(c), params.id));
      return c.body(null, 204);
    }),
  );

  svc.op(
    'internalGetPhotoSignedUrl',
    wrap(async (c, { params }) => {
      c.header('cache-control', 'no-store');
      return json(c, await guard(() => internalSignedUrl(app, actorOf(c), params.id)));
    }),
  );
}
