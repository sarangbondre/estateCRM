// Privacy scan use cases (LLD §4.4, US-15): the blocking scan on the effective public text, photo-text warnings
// (R-8), private-term matching through salted hashes (R-20), and the stored scan row (latest per subject on C-12).
import {
  RULES_VERSION,
  allowListOf,
  candidateGrams,
  outcomeOf,
  scanText,
  termFindings,
} from '../domain/privacy.js';
import type { Finding, TermKind } from '../domain/privacy.js';
import { generatedDescription } from '../domain/projection.js';
import type { OfferFacts, ProjectFacts, PublicationSettings, SubjectType } from '../domain/types.js';
import type { Services } from './context.js';
import type { ScanRecord, Store } from './ports.js';

export interface ScanSubject {
  subjectType: SubjectType;
  subjectId: string;
  offer?: OfferFacts | undefined;
  project?: ProjectFacts | undefined;
}

/** Matches text n-grams against the private-term cache of the whole tenant (own property included). */
async function privateTermFindings(
  s: Services,
  store: Store,
  text: string,
  allow: Set<string>,
): Promise<Finding[]> {
  const grams = candidateGrams(text);
  if (!grams.length) return [];
  const hashOf = new Map<string, string>();
  for (const g of grams) if (!hashOf.has(g.key)) hashOf.set(g.key, s.termHasher.hash(g.key));
  const rows = await store.tenantTermHashes([...new Set(hashOf.values())]);
  if (!rows.length) return [];
  const matched = new Map<string, TermKind>(rows.map((r) => [r.tokenHash, r.kind]));
  return termFindings(grams, matched, (k) => hashOf.get(k) ?? '', allow);
}

function allowListFor(subject: ScanSubject): Set<string> {
  const o = subject.offer;
  const p = subject.project;
  return allowListOf([
    o?.locality,
    o?.micromarket,
    o?.city,
    ...(o?.amenities ?? []),
    ...(o?.propertyTypes ?? []),
    o?.furnishing,
    o?.possessionStatus,
    p?.name,
    p?.locality,
    p?.micromarket,
    p?.city,
    ...(p?.amenities ?? []),
  ]);
}

/** Selected photos whose text detection (records) found text: warning only. */
async function photoWarnings(store: Store, offer: OfferFacts | undefined): Promise<string[]> {
  if (!offer?.selectedPhotoIds.length) return [];
  const photos = await store.photosByIds(offer.selectedPhotoIds);
  return photos.filter((p) => p.hasTextDetected === true && p.status !== 'removed').map((p) => p.id);
}

export interface ScanRun {
  record: ScanRecord;
  blocked: boolean;
}

export async function runScan(
  s: Services,
  store: Store,
  subject: ScanSubject,
  text: string,
  options: { includePhotos: boolean; scannedBy: string; settings: PublicationSettings | undefined },
): Promise<ScanRun> {
  const allowIds = new Set(
    [options.settings?.mahareraAgentNumber, subject.project?.reraNumber].filter((x): x is string =>
      Boolean(x),
    ),
  );
  const findings = scanText({
    text,
    allowIds,
    termFindings: await privateTermFindings(s, store, text, allowListFor(subject)),
    photoTextIds: options.includePhotos ? await photoWarnings(store, subject.offer) : [],
  });
  const record: ScanRecord = {
    id: s.random.uuid(),
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    textSha256: s.sha256(text),
    rulesVersion: RULES_VERSION,
    result: outcomeOf(findings),
    findings,
    scannedBy: options.scannedBy,
    createdAt: s.clock.now(),
  };
  await store.saveScan(record);
  return { record, blocked: record.result === 'blocked' };
}

/** The effective public text of an offer: staff description, else the generated one. */
export const effectiveOfferText = (offer: OfferFacts, staff: string | null) =>
  staff ?? generatedDescription(offer);

/** 422 privacy-scan-blocked field errors: kind + offsets only, never the matched text. */
export const blockedErrors = (findings: readonly Finding[]) =>
  findings
    .filter((f) => f.severity === 'block')
    .map((f) => ({
      field: 'publicDescription',
      code: f.kind,
      message: `characters ${f.start ?? 0}–${f.end ?? 0}`,
    }));
