// Staff publication routes (C-12, C-11, US-15): state, level changes, dry-run scans, the staff list.
import type { components, operations } from '@11e/contracts/listings';
import { idempotent, ifMatchVersion, pageLimit } from '@11e/http';
import type { Service, ServiceContext } from '@11e/http';
import type { StaffRole } from '@11e/auth';
import type { ScanRecord } from '../application/ports.js';
import {
  getPublicationState,
  listPublications,
  scanOffer,
  setPublicationLevel,
} from '../application/publication.js';
import type { PublicationView } from '../application/publication.js';
import { REASON_MESSAGES } from '../domain/ceiling.js';
import type { ReasonCode } from '../domain/ceiling.js';
import type { Level, SubjectType } from '../domain/types.js';
import type { AppDeps } from '../deps.js';
import { ALL_STAFF, encode, keysetCursor, run, staffActor, withEtag } from './http-support.js';

type Schemas = components['schemas'];

export function scanOut(s: ScanRecord): Schemas['PrivacyScanResult'] {
  return {
    scanId: s.id,
    result: s.result,
    rulesVersion: s.rulesVersion,
    scannedAt: s.createdAt.toISOString(),
    findings: s.findings.map((f) => ({
      kind: f.kind,
      severity: f.severity,
      field: f.field,
      ...(f.start !== undefined ? { start: f.start } : {}),
      ...(f.end !== undefined ? { end: f.end } : {}),
      ...(f.photoId ? { photoId: f.photoId } : {}),
    })),
  };
}

function base(v: PublicationView) {
  const p = v.publication;
  return {
    subjectType: p.subjectType,
    subjectId: p.subjectId,
    code: v.code,
    level: p.level,
    ceiling: p.ceiling,
    ceilingReasons: p.ceilingReasons.map((code) => ({
      code: code as ReasonCode,
      message: REASON_MESSAGES[code as ReasonCode] ?? code,
    })),
    allowedLevels: v.allowedLevels,
    publicId: p.publicId,
    label: v.label,
    lastChangedBy: p.lastChangedBy,
    lastChangeReason: p.lastChangeReason,
    version: p.version,
    updatedAt: p.updatedAt.toISOString(),
  };
}

function offerState(v: PublicationView): Schemas['OfferPublicationState'] {
  if (v.facts.type !== 'offer') throw new Error('not an offer');
  const o = v.facts.offer;
  const selected = new Set(o.selectedPhotoIds);
  return {
    ...base(v),
    inputs: {
      lifeStage: o.lifeStage,
      recordStage: o.recordStage,
      commercialStatus: o.commercialStatus,
      hasRealPhotos: o.hasRealPhotos,
      outsideLaunchArea: o.outsideLaunchArea,
    },
    publicDescription: v.publication.publicDescription,
    descriptionSource: v.publication.descriptionSource,
    lastScan: v.lastScan ? scanOut(v.lastScan) : null,
    rera: {
      agentNumberSet: v.agentNumberSet,
      projectReraRequired: o.dealType === 'Sale' && o.market === 'Primary',
      projectReraNumber: v.facts.project?.reraNumber ?? null,
    },
    photos: v.photos
      .filter((p) => p.status !== 'removed')
      .map((p) => ({
        photoId: p.id,
        isReal: p.isReal,
        publicUse: selected.has(p.id) && p.status === 'ready',
        ocrStatus:
          p.status === 'failed'
            ? ('failed' as const)
            : p.hasTextDetected === true
              ? ('text_found' as const)
              : p.hasTextDetected === false
                ? ('clear' as const)
                : ('pending' as const),
        warnings: p.hasTextDetected ? ['text_detected' as const] : [],
      })),
  };
}

function projectState(v: PublicationView): Schemas['ProjectPublicationState'] {
  return {
    ...base(v),
    projectReraNumber: v.facts.type === 'project' ? v.facts.project.reraNumber : null,
    liveConfigurations: v.liveConfigurations,
  };
}

function demandState(v: PublicationView): Schemas['DemandPostState'] {
  const d = v.facts.type === 'demand_post' ? v.facts.demand : undefined;
  return {
    ...base(v),
    commercialStatus: d?.status ?? null,
    lifeStage: d?.lifeStage ?? null,
    sourcingRequestId: d?.sourcingRequestId ?? null,
  };
}

export function registerStaffRoutes(svc: Service<operations>, deps: AppDeps): void {
  const s = deps.services;

  // --- staff: publication
  const getState =
    (type: SubjectType, present: (v: PublicationView) => unknown) =>
    async (c: ServiceContext, idOrCode: string) => {
      const actor = staffActor(c, ALL_STAFF);
      const v = await run(() => getPublicationState(s, actor, type, idOrCode));
      withEtag(c, v.publication.version);
      return c.json(present(v) as object);
    };
  const putState =
    (type: SubjectType, roles: readonly StaffRole[], present: (v: PublicationView) => unknown) =>
    async (
      c: ServiceContext,
      idOrCode: string,
      body: { level: Level; publicDescription?: string | null },
    ) => {
      const actor = staffActor(c, roles);
      const v = await run(() =>
        setPublicationLevel(s, actor, type, idOrCode, {
          level: body.level,
          publicDescription: body.publicDescription,
          ifMatch: ifMatchVersion(c),
        }),
      );
      withEtag(c, v.publication.version);
      return c.json(present(v) as object);
    };

  svc.op('getOfferPublication', (c, { params }) => getState('offer', offerState)(c, params.idOrCode));
  svc.op('setOfferPublication', (c, { params, body }) =>
    putState('offer', ['Admin', 'Manager', 'Supply agent'], offerState)(c, params.idOrCode, body),
  );
  svc.op('getProjectPublication', (c, { params }) => getState('project', projectState)(c, params.idOrCode));
  svc.op('setProjectPublication', (c, { params, body }) =>
    putState('project', ['Admin', 'Manager', 'Supply agent'], projectState)(c, params.idOrCode, body),
  );
  svc.op('getDemandPost', (c, { params }) => getState('demand_post', demandState)(c, params.idOrCode));
  svc.op('setDemandPost', (c, { params, body }) =>
    putState('demand_post', ['Admin', 'Manager', 'Demand agent'], demandState)(c, params.idOrCode, body),
  );

  svc.op('scanOfferText', async (c, { params, body }) => {
    const actor = staffActor(c, ['Admin', 'Manager', 'Supply agent']);
    return idempotent(c, deps.db, actor, body, async () => {
      const r = await run(() =>
        scanOffer(s, actor, params.idOrCode, { text: body.text, includePhotos: body.includePhotos ?? true }),
      );
      return { status: 200, body: scanOut(r) };
    });
  });

  svc.op('listPublications', async (c, { query }) => {
    const actor = staffActor(c, ALL_STAFF);
    const limit = pageLimit(query.limit);
    const rows = await run(() =>
      listPublications(
        s,
        actor,
        {
          subjectType: query.subjectType,
          level: query.level,
          lifeStage: query.lifeStage,
          ceilingBelowLevel: query.ceilingBelowLevel,
        },
        limit,
        keysetCursor(query.cursor),
      ),
    );
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return c.json({
      items: items.map((r) => ({
        subjectType: r.publication.subjectType,
        subjectId: r.publication.subjectId,
        code: r.code,
        level: r.publication.level,
        ceiling: r.publication.ceiling,
        label: r.label,
        lifeStage: r.publication.lifeStage,
        publicId: r.publication.publicId,
        updatedAt: r.publication.updatedAt.toISOString(),
      })),
      nextCursor:
        rows.length > limit && last
          ? encode({ t: last.publication.updatedAt.toISOString(), id: last.publication.id })
          : null,
    });
  });
}
