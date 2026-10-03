// vocabulary.released.v1 consumer (LLD §4.13, §5.2): fetch the release from records, verify the checksum, store it with
// its legacy terms, and activate it only when it is newer than the active one (an older release is kept superseded).
import { legacyKey, releaseContent } from '@11e/vocabulary';
import { canonicalJson, sha256Hex } from '../domain/identity.js';
import type { IdGenerator, LegacyTermRow, Repositories, VocabularyRelease } from './ports.js';

/** records GET /v1/vocabulary?version= (service token). */
export interface ReleaseSource {
  release(tenantId: string, version: string): Promise<VocabularyRelease>;
}

export class ChecksumMismatchError extends Error {
  override readonly name = 'ChecksumMismatchError';
}

/** `v0.6` → [0, 6]; semantic compare. */
export function compareVersions(a: string, b: string): number {
  const key = (v: string) =>
    v
      .replace(/^v/i, '')
      .split('.')
      .map((x) => Number(x) || 0);
  const x = key(a);
  const y = key(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** sha256 of the canonical (key-sorted) JSON of the release content (records LLD §4.13). */
export const releaseChecksum = (content: unknown) => sha256Hex(canonicalJson(content));

export function legacyRows(content: Record<string, unknown>): LegacyTermRow[] {
  const terms = Array.isArray(content['legacyTerms'])
    ? (content['legacyTerms'] as Record<string, unknown>[])
    : [];
  return terms
    .filter((t) => typeof t['term'] === 'string' && typeof t['field'] === 'string')
    .map((t) => ({
      field: t['field'] as string,
      termNorm: legacyKey(t['term'] as string),
      maps: (t['maps'] ?? {}) as Record<string, string>,
    }));
}

export async function applyVocabularyRelease(
  source: ReleaseSource,
  repos: Repositories,
  ids: IdGenerator,
  tenantId: string,
  event: { version: string; checksum: string },
): Promise<'activated' | 'stored' | 'known'> {
  if (await repos.vocabulary.get(tenantId, event.version)) {
    const active = await repos.vocabulary.active(tenantId);
    if (active && compareVersions(event.version, active.version) <= 0) return 'known';
  }
  const release = await source.release(tenantId, event.version);
  const actual = releaseChecksum(release.content);
  if (actual !== event.checksum || release.checksum !== event.checksum) {
    throw new ChecksumMismatchError(`vocabulary ${event.version}: checksum does not match the event`);
  }
  const active = await repos.vocabulary.active(tenantId);
  const activate = !active || compareVersions(event.version, active.version) > 0;
  await repos.vocabulary.save(tenantId, release, legacyRows(release.content), activate, ids.uuid());
  return activate ? 'activated' : 'stored';
}

/**
 * The release shipped with this build (@11e/vocabulary), the same one records seeds for every tenant. Used when no
 * vocabulary.released.v1 has been applied for the tenant yet (records unreachable or the event still queued), so
 * processing doesn't wait on records; a later event for the same version is `known`, a newer one activates.
 */
export async function activateShippedRelease(
  repos: Repositories,
  ids: IdGenerator,
  tenantId: string,
): Promise<VocabularyRelease> {
  const content = releaseContent() as unknown as Record<string, unknown>;
  const release: VocabularyRelease = {
    version: String(content['version']),
    checksum: releaseChecksum(content),
    content,
  };
  await repos.vocabulary.save(tenantId, release, legacyRows(content), true, ids.uuid());
  return (await repos.vocabulary.active(tenantId)) ?? release;
}
