// Staff publication use cases (US-15, C-12, C-11; LLD §4.2): read the state, set the level within the ceiling with the
// RERA check and the blocking privacy scan, dry-run scans, and the staff list.
import { NEVER_PUBLISHABLE, REASON_MESSAGES, reasonsBelow } from '../domain/ceiling.js';
import type { ReasonCode } from '../domain/ceiling.js';
import { allowedLevels, isVisible, levelsFor, rank } from '../domain/levels.js';
import type { Level, PhotoInfo, Publication, SubjectType } from '../domain/types.js';
import { AppError, notFound } from './context.js';
import type { Services } from './context.js';
import type { Facts } from './engine.js';
import {
  configurationIds,
  evaluate,
  labelOf,
  loadFacts,
  newPublication,
  reconcile,
  savePublication,
  setLevel,
  syncProjection,
} from './engine.js';
import type { PublicationListFilter, PublicationSummaryRow, ScanRecord, Store } from './ports.js';
import { blockedErrors, effectiveOfferText, runScan } from './scan.js';

export interface Actor {
  tenantId: string;
  userId: string;
  correlationId: string;
}

export interface PublicationView {
  publication: Publication;
  facts: Facts;
  code: string;
  label: string | null;
  allowedLevels: Level[];
  lastScan: ScanRecord | null;
  photos: PhotoInfo[];
  liveConfigurations: number;
  agentNumberSet: boolean;
}

const RERA_REASONS: readonly ReasonCode[] = ['agent_rera_missing', 'project_rera_missing'];

async function resolveId(store: Store, type: SubjectType, idOrCode: string): Promise<string> {
  const id =
    type === 'offer'
      ? await store.findOfferId(idOrCode)
      : type === 'project'
        ? await store.findProjectId(idOrCode)
        : await store.findDemandId(idOrCode);
  if (!id) throw notFound(type === 'demand_post' ? 'demand' : type);
  return id;
}

async function view(s: Services, store: Store, pub: Publication, facts: Facts): Promise<PublicationView> {
  const lastScan = pub.lastScanId ? ((await store.getScan(pub.lastScanId)) ?? null) : null;
  let photos: PhotoInfo[] = [];
  let live = 0;
  if (facts.type === 'offer') photos = await store.photosOfProperty(facts.offer.propertyId, 30);
  if (facts.type === 'project') {
    for (const id of await configurationIds(store, facts.project)) {
      const p = await store.getPublication('offer', id);
      if (p && isVisible(p.level)) live++;
    }
  }
  const code =
    facts.type === 'offer'
      ? facts.offer.code
      : facts.type === 'project'
        ? facts.project.code
        : facts.demand.code;
  void s;
  return {
    publication: pub,
    facts,
    code,
    label: labelOf(facts),
    allowedLevels: allowedLevels(pub.subjectType, pub.ceiling),
    lastScan,
    photos,
    liveConfigurations: live,
    agentNumberSet: Boolean((await store.getSettings())?.mahareraAgentNumber),
  };
}

export async function getPublicationState(
  s: Services,
  actor: Actor,
  type: SubjectType,
  idOrCode: string,
): Promise<PublicationView> {
  return s.uow.run(actor.tenantId, actor.correlationId, async (store) => {
    const id = await resolveId(store, type, idOrCode);
    const facts = await loadFacts(store, type, id);
    const pub = await store.getPublication(type, id);
    if (!facts || !pub) throw notFound(type);
    return view(s, store, pub, facts);
  });
}

export interface SetLevelInput {
  level: Level;
  /** undefined = keep; null = back to generated; string = staff text (offers only). */
  publicDescription?: string | null | undefined;
  ifMatch?: number | undefined;
}

function reasonErrors(reasons: readonly string[]) {
  return reasons.map((r) => ({ field: 'level', code: r, message: REASON_MESSAGES[r as ReasonCode] ?? r }));
}

/** PUT publication / demand post (LLD §4.2). A repeat PUT with the same body changes nothing and emits nothing. */
export async function setPublicationLevel(
  s: Services,
  actor: Actor,
  type: SubjectType,
  idOrCode: string,
  input: SetLevelInput,
): Promise<PublicationView> {
  const result = await s.uow.run(
    actor.tenantId,
    actor.correlationId,
    async (store): Promise<PublicationView | AppError> => {
      const id = await resolveId(store, type, idOrCode);
      const facts = await loadFacts(store, type, id);
      if (!facts) throw notFound(type);
      const pub = await newPublication(s, store, type, id);
      if (input.ifMatch !== undefined && input.ifMatch !== pub.version)
        throw new AppError(412, 'version-mismatch');
      if (!levelsFor(type).includes(input.level)) {
        throw new AppError(400, 'validation-failed', `${type} has no ${input.level} level`, [
          { field: 'level', code: 'enum', message: `allowed: ${levelsFor(type).join(', ')}` },
        ]);
      }
      if (type !== 'offer' && input.publicDescription !== undefined && input.publicDescription !== null) {
        throw new AppError(400, 'validation-failed', 'publicDescription applies to offers only', [
          { field: 'publicDescription', code: 'not-allowed' },
        ]);
      }
      const settings = await store.getSettings();
      const ceiling = await evaluate(s, store, pub, facts, settings);
      const ceilingChanged =
        pub.ceiling !== ceiling.ceiling || pub.ceilingReasons.join(',') !== ceiling.reasons.join(',');
      pub.ceiling = ceiling.ceiling;
      pub.ceilingReasons = ceiling.reasons;

      if (rank(input.level) > rank(ceiling.ceiling)) {
        if (ceilingChanged) await savePublication(s, store, pub);
        const capping = ceiling.reasons;
        if (capping.some((r) => NEVER_PUBLISHABLE.includes(r)))
          throw new AppError(
            409,
            'subject-not-publishable',
            'this subject can never be published',
            reasonErrors(capping),
          );
        const blocking = reasonsBelow(capping, input.level);
        if (blocking.length && blocking.every((r) => RERA_REASONS.includes(r)))
          throw new AppError(422, 'rera-missing', 'a RERA number is missing', reasonErrors(capping));
        throw new AppError(
          409,
          'level-above-ceiling',
          `the ceiling is ${ceiling.ceiling}`,
          reasonErrors(capping),
        );
      }

      // Description (offers): undefined keeps, null resets to generated, a string is staff text.
      const before = { description: pub.publicDescription, source: pub.descriptionSource };
      if (type === 'offer' && input.publicDescription !== undefined) {
        pub.publicDescription = input.publicDescription;
        pub.descriptionSource = input.publicDescription === null ? 'generated' : 'staff';
      }
      const descriptionChanged =
        before.description !== pub.publicDescription || before.source !== pub.descriptionSource;
      const raising = rank(input.level) > rank(pub.level);
      let photoWarnings = 0;
      let scanned = false;
      if (isVisible(input.level) && (raising || descriptionChanged)) {
        const text =
          facts.type === 'offer'
            ? effectiveOfferText(
                facts.offer,
                pub.descriptionSource === 'staff' ? pub.publicDescription : null,
              )
            : facts.type === 'project'
              ? `${facts.project.name} ${labelOf(facts) ?? ''}`
              : `${labelOf(facts) ?? ''} ${facts.demand.micromarkets.join(', ')}`;
        const scan = await runScan(
          s,
          store,
          {
            subjectType: type,
            subjectId: id,
            offer: facts.type === 'offer' ? facts.offer : undefined,
            project:
              facts.type === 'offer' ? facts.project : facts.type === 'project' ? facts.project : undefined,
          },
          text,
          { includePhotos: input.level === 'Public', scannedBy: actor.userId, settings },
        );
        pub.lastScanId = scan.record.id;
        scanned = true;
        if (scan.blocked) {
          // The scan row is kept (C-12 shows it); the level and text stay as they were.
          pub.publicDescription = before.description;
          pub.descriptionSource = before.source;
          await savePublication(s, store, pub);
          // Returned, not thrown: the transaction commits so the scan row survives the 422.
          return new AppError(
            422,
            'privacy-scan-blocked',
            'the public text contains private details',
            blockedErrors(scan.record.findings),
          );
        }
        photoWarnings = scan.record.findings.filter((f) => f.kind === 'photo_text').length;
      }

      const from = pub.level;
      const levelChanged = await setLevel(s, store, pub, input.level, 'user', {
        userId: actor.userId,
        via: 'ui',
      });
      if (!levelChanged && !descriptionChanged && !ceilingChanged && !scanned)
        return view(s, store, pub, facts);
      if (levelChanged || descriptionChanged) {
        pub.lastChangedBy = actor.userId;
        await store.emitAudit({
          action: 'publication.set',
          actorUserId: actor.userId,
          subjectType: type,
          subjectId: id,
          via: 'ui',
          details: {
            from,
            to: pub.level,
            ...(pub.lastScanId ? { scanId: pub.lastScanId } : {}),
            photoWarnings: String(photoWarnings),
            descriptionSource: pub.descriptionSource,
          },
        });
      }
      await savePublication(s, store, pub);
      await syncProjection(s, store, pub, facts, settings);
      // Projects list their configurations; offers carry their project's public id.
      if (type !== 'demand_post') await reconcileRelated(s, store, facts);
      return view(s, store, pub, facts);
    },
  );
  if (result instanceof AppError) throw result;
  return result;
}

async function reconcileRelated(s: Services, store: Store, facts: Facts) {
  if (facts.type === 'offer') {
    const projects = new Set(await store.projectsOfOffer(facts.offer.id, 20));
    if (facts.offer.projectId) projects.add(facts.offer.projectId);
    for (const id of projects) await reconcile(s, store, 'project', id, { cascade: false });
  } else if (facts.type === 'project') {
    for (const id of await configurationIds(store, facts.project))
      await reconcile(s, store, 'offer', id, { cascade: false });
  }
}

export interface ScanRequest {
  text?: string | undefined;
  includePhotos: boolean;
}

/** POST /v1/offers/{idOrCode}/privacy-scan: dry run, stored as the latest scan for C-12; the level is unchanged. */
export async function scanOffer(
  s: Services,
  actor: Actor,
  idOrCode: string,
  req: ScanRequest,
): Promise<ScanRecord> {
  return s.uow.run(actor.tenantId, actor.correlationId, async (store) => {
    const id = await resolveId(store, 'offer', idOrCode);
    const facts = await loadFacts(store, 'offer', id);
    if (!facts || facts.type !== 'offer') throw notFound('offer');
    const pub = await newPublication(s, store, 'offer', id);
    const settings = await store.getSettings();
    const text =
      req.text ??
      effectiveOfferText(facts.offer, pub.descriptionSource === 'staff' ? pub.publicDescription : null);
    const scan = await runScan(
      s,
      store,
      { subjectType: 'offer', subjectId: id, offer: facts.offer, project: facts.project },
      text,
      { includePhotos: req.includePhotos, scannedBy: actor.userId, settings },
    );
    pub.lastScanId = scan.record.id;
    await savePublication(s, store, pub);
    return scan.record;
  });
}

export async function listPublications(
  s: Services,
  actor: Actor,
  filter: PublicationListFilter,
  limit: number,
  after: { t: string; id: string } | undefined,
): Promise<PublicationSummaryRow[]> {
  return s.uow.run(actor.tenantId, actor.correlationId, (store) =>
    store.listPublications(filter, { limit: limit + 1, after }),
  );
}
