// Admin use cases (US-34, LLD §4.10, §4.11): RERA publication settings and website API keys.
import { API_KEY_PREFIX, apiKeyDisplayPrefix, apiKeyFrom } from '../domain/ids.js';
import type { PublicationSettings } from '../domain/types.js';
import { DEFAULT_NOTE, SYSTEM_ACTOR } from '../domain/types.js';
import { AppError, notFound } from './context.js';
import type { Services } from './context.js';
import type { ApiKeyRow } from './ports.js';
import type { Actor } from './publication.js';

// ---- settings ------------------------------------------------------------------------------------------------------

export async function getSettings(
  s: Services,
  tenantId: string,
  correlationId: string,
): Promise<PublicationSettings> {
  return s.uow.run(tenantId, correlationId, async (store) => {
    const settings = await store.getSettings();
    // Not set yet: 404 (the pilot shows "MahaRERA registration pending", questionnaire A7).
    if (!settings?.mahareraAgentNumber) throw notFound('publication settings');
    return settings;
  });
}

export interface SettingsInput {
  mahareraAgentNumber: string;
  subjectToConfirmationNote?: string | undefined;
  ifMatch?: number | undefined;
}

/** PUT settings: a change refreshes every public item (projection-refresh) and re-checks ceilings. */
export async function putSettings(
  s: Services,
  actor: Actor,
  input: SettingsInput,
): Promise<PublicationSettings> {
  return s.uow.run(actor.tenantId, actor.correlationId, async (store) => {
    const current = await store.getSettings();
    if (input.ifMatch !== undefined && input.ifMatch !== (current?.version ?? 0))
      throw new AppError(412, 'version-mismatch');
    const note = input.subjectToConfirmationNote ?? current?.note ?? DEFAULT_NOTE;
    if (current && current.mahareraAgentNumber === input.mahareraAgentNumber && current.note === note)
      return current;
    const next: PublicationSettings = {
      mahareraAgentNumber: input.mahareraAgentNumber,
      note,
      version: (current?.version ?? 0) + 1,
      updatedAt: s.clock.now(),
      updatedBy: actor.userId,
    };
    await store.saveSettings(next, !current);
    await store.emitAudit({
      action: 'settings.changed',
      actorUserId: actor.userId,
      subjectType: 'publication_settings',
      subjectId: actor.tenantId,
      via: 'ui',
      details: {
        version: String(next.version),
        fields: [
          current?.mahareraAgentNumber !== next.mahareraAgentNumber ? 'mahareraAgentNumber' : null,
          current?.note !== next.note ? 'subjectToConfirmationNote' : null,
        ]
          .filter(Boolean)
          .join(','),
      },
    });
    await store.enqueue({ kind: 'projection-refresh', tenantId: actor.tenantId, after: null });
    return next;
  });
}

// ---- API keys ------------------------------------------------------------------------------------------------------

export interface KeyHasher {
  hash(secret: string): string;
}

export interface CreateKeyInput {
  name: string;
  allowedOrigins?: string[] | undefined;
  rateLimitRps?: number | undefined;
  burst?: number | undefined;
}

function newKey(s: Services, hasher: KeyHasher, tenantId: string, createdBy: string, base: CreateKeyInput) {
  const secret = apiKeyFrom(s.random.bytes(96));
  const now = s.clock.now();
  const row: ApiKeyRow = {
    id: s.random.uuid(),
    tenantId,
    name: base.name,
    prefix: apiKeyDisplayPrefix(secret),
    keyHash: hasher.hash(secret),
    status: 'active',
    rateLimitRps: base.rateLimitRps ?? 50,
    burst: base.burst ?? 100,
    allowedOrigins: base.allowedOrigins ?? [],
    graceEndsAt: null,
    replacedByKeyId: null,
    lastUsedAt: null,
    createdBy,
    revokedAt: null,
    version: 1,
    createdAt: now,
  };
  return { row, secret };
}

export async function createApiKey(
  s: Services,
  hasher: KeyHasher,
  actor: Actor,
  input: CreateKeyInput,
): Promise<{ key: ApiKeyRow; secret: string }> {
  return s.uow.run(actor.tenantId, actor.correlationId, async (store) => {
    const { row, secret } = newKey(s, hasher, actor.tenantId, actor.userId, input);
    await store.insertApiKey(row);
    await store.emitAudit({
      action: 'api_key.created',
      actorUserId: actor.userId,
      subjectType: 'api_key',
      subjectId: row.id,
      via: 'ui',
      details: { keyId: row.id, rateLimitRps: String(row.rateLimitRps), burst: String(row.burst) },
    });
    return { key: row, secret };
  });
}

/** Rotate: a new key; the old one stays valid for the grace period (default 168 h, OQ-L2). */
export async function rotateApiKey(
  s: Services,
  hasher: KeyHasher,
  actor: Actor,
  keyId: string,
  graceHours: number,
): Promise<{ key: ApiKeyRow; secret: string }> {
  return s.uow.run(actor.tenantId, actor.correlationId, async (store) => {
    const old = await store.getApiKey(keyId, true);
    if (!old) throw notFound('api key');
    if (old.status === 'rotating')
      throw new AppError(409, 'key-already-rotating', 'this key is already in rotation');
    if (old.status === 'revoked') throw new AppError(409, 'conflict', 'a revoked key cannot be rotated');
    const { row, secret } = newKey(s, hasher, actor.tenantId, actor.userId, old);
    await store.insertApiKey(row);
    old.status = 'rotating';
    old.graceEndsAt = new Date(s.clock.now().getTime() + graceHours * 3_600_000);
    old.replacedByKeyId = row.id;
    await store.updateApiKey(old);
    await store.emitAudit({
      action: 'api_key.rotated',
      actorUserId: actor.userId,
      subjectType: 'api_key',
      subjectId: old.id,
      via: 'ui',
      details: { keyId: old.id, newKeyId: row.id, graceHours: String(graceHours) },
    });
    return { key: row, secret };
  });
}

/** Revoke: immediate; revoking a revoked key returns it unchanged. */
export async function revokeApiKey(s: Services, actor: Actor, keyId: string): Promise<ApiKeyRow> {
  return s.uow.run(actor.tenantId, actor.correlationId, async (store) => {
    const key = await store.getApiKey(keyId, true);
    if (!key) throw notFound('api key');
    if (key.status === 'revoked') return key;
    key.status = 'revoked';
    key.revokedAt = s.clock.now();
    await store.updateApiKey(key);
    await store.emitAudit({
      action: 'api_key.revoked',
      actorUserId: actor.userId,
      subjectType: 'api_key',
      subjectId: key.id,
      via: 'ui',
      details: { keyId: key.id },
    });
    return key;
  });
}

export async function listApiKeys(
  s: Services,
  actor: Actor,
  status: ApiKeyRow['status'] | undefined,
  limit: number,
  after: { t: string; id: string } | undefined,
): Promise<ApiKeyRow[]> {
  return s.uow.run(actor.tenantId, actor.correlationId, (store) =>
    store.listApiKeys(status, limit + 1, after),
  );
}

/** api-key-expire: rotating keys past their grace period become revoked (system actor, R-7). */
export async function expireRotatedKeys(
  s: Services,
  tenantId: string,
  keyIds: readonly string[],
): Promise<number> {
  return s.uow.run(tenantId, `job-api-key-expire`, async (store) => {
    let n = 0;
    for (const id of keyIds) {
      const key = await store.getApiKey(id, true);
      if (!key || key.status !== 'rotating' || !key.graceEndsAt || key.graceEndsAt > s.clock.now()) continue;
      key.status = 'revoked';
      key.revokedAt = s.clock.now();
      await store.updateApiKey(key);
      await store.emitAudit({
        action: 'api_key.revoked',
        actorUserId: SYSTEM_ACTOR,
        subjectType: 'api_key',
        subjectId: key.id,
        via: 'system',
        details: { keyId: key.id, cause: 'rotation_grace_ended' },
      });
      n++;
    }
    return n;
  });
}

/** Is this plaintext even shaped like one of our keys (cheap reject before hashing)? */
export const looksLikeApiKey = (key: string) =>
  key.startsWith(API_KEY_PREFIX) && key.length === API_KEY_PREFIX.length + 40;
