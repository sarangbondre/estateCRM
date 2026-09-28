// Settings journeys enforces (LLD §3.3 settings; US-34): life-curve thresholds and queue weights. The seed values are
// the domain defaults; a tenant without a row uses them (version 0).
import { DEFAULT_THRESHOLDS, thresholdErrors } from '../domain/lifecurve.js';
import type { ThresholdSettings, Thresholds } from '../domain/lifecurve.js';
import { DEFAULT_WEIGHTS, weightsValid } from '../domain/queue.js';
import type { QueueWeights } from '../domain/queue.js';
import { JourneyError, versionMismatchErr } from './errors.js';
import type { SettingsRow } from './model.js';
import { audit } from './notify.js';
import type { Tx } from './ports.js';

export interface Loaded<T> {
  value: T;
  version: number;
  updatedBy: string | null;
  updatedAt: Date | null;
}

async function load<T>(tx: Tx, kind: SettingsRow['kind'], defaults: T): Promise<Loaded<T>> {
  const key = `settings:${kind}`;
  const hit = tx.memo.get(key) as Loaded<T> | undefined;
  if (hit) return hit;
  const row = await tx.q.settingsByKind(kind);
  const loaded: Loaded<T> = row
    ? { value: { ...defaults, ...(row.body as Partial<T>) }, version: row.version, updatedBy: row.updated_by, updatedAt: row.updated_at }
    : { value: defaults, version: 0, updatedBy: null, updatedAt: null };
  tx.memo.set(key, loaded);
  return loaded;
}

export const thresholds = (tx: Tx) => load<ThresholdSettings>(tx, 'life_curve_thresholds', DEFAULT_THRESHOLDS);
export const weights = (tx: Tx) => load<QueueWeights>(tx, 'queue_weights', DEFAULT_WEIGHTS);

/** Replaces a settings document; undefined on a version mismatch (If-Match). */
export async function saveSettings<T extends object>(
  tx: Tx,
  kind: SettingsRow['kind'],
  body: T,
  actor: string,
  expectedVersion: number | undefined,
): Promise<Loaded<T> | undefined> {
  const row = await tx.q.settingsByKind(kind);
  let saved: SettingsRow | undefined;
  if (!row) {
    if (expectedVersion !== undefined && expectedVersion !== 0) return undefined;
    saved = await tx.rows.insert('settings', { kind, body: body as Record<string, unknown>, updated_by: actor });
  } else {
    saved = await tx.rows.update(
      'settings',
      row.id,
      { body: body as Record<string, unknown>, updated_by: actor },
      expectedVersion === undefined ? {} : { expectedVersion },
    );
    if (!saved) return undefined;
  }
  tx.memo.delete(`settings:${kind}`);
  return { value: body, version: saved.version, updatedBy: saved.updated_by, updatedAt: saved.updated_at };
}

// ------------------------------------------------------------------------------------ settings APIs (JOU-10, US-34)

export const REARM_JOB = 'thresholds-rearm';
export const REARM_DATE = '1970-01-01';

export function thresholdsView(l: Loaded<ThresholdSettings>) {
  return {
    version: l.version,
    offer: l.value.offer,
    demand: l.value.demand,
    upcomingLeadDays: l.value.upcomingLeadDays,
    dormantRevisitDays: l.value.dormantRevisitDays,
    updatedBy: l.updatedBy,
    updatedAt: l.updatedAt ? l.updatedAt.toISOString() : null,
  };
}

export function weightsView(l: Loaded<QueueWeights>) {
  return {
    version: l.version,
    ...l.value,
    updatedBy: l.updatedBy,
    updatedAt: l.updatedAt ? l.updatedAt.toISOString() : null,
  };
}

/** Categories whose thresholds (or the Upcoming lead) changed: their curves are re-evaluated by the next nightly run. */
function changedKeys(before: ThresholdSettings, after: ThresholdSettings): string[] {
  const keys: string[] = [];
  for (const side of ['offer', 'demand'] as const) {
    const a = before[side] as Record<string, Thresholds>;
    const b = after[side] as Record<string, Thresholds>;
    const leadChanged = side === 'offer' && before.upcomingLeadDays !== after.upcomingLeadDays;
    for (const k of Object.keys(b)) {
      const x = a[k];
      const y = b[k] as Thresholds;
      if (leadChanged || !x || x.freshMaxDays !== y.freshMaxDays || x.ageingMaxDays !== y.ageingMaxDays || x.staleMaxDays !== y.staleMaxDays)
        keys.push(`${side}.${k}`);
    }
  }
  return keys;
}

export async function putThresholds(
  tx: Tx,
  actor: string,
  body: Omit<ThresholdSettings, 'upcomingLeadDays' | 'dormantRevisitDays'> & Partial<Pick<ThresholdSettings, 'upcomingLeadDays' | 'dormantRevisitDays'>>,
  expectedVersion: number | undefined,
) {
  const next: ThresholdSettings = {
    offer: body.offer,
    demand: body.demand,
    upcomingLeadDays: body.upcomingLeadDays ?? DEFAULT_THRESHOLDS.upcomingLeadDays,
    dormantRevisitDays: body.dormantRevisitDays ?? DEFAULT_THRESHOLDS.dormantRevisitDays,
  };
  const bad = thresholdErrors(next);
  if (bad.length) throw new JourneyError(400, 'invalid-thresholds', `fresh < ageing < stale is required for ${bad.join(', ')}`);
  const before = (await thresholds(tx)).value;
  const saved = await saveSettings(tx, 'life_curve_thresholds', next, actor, expectedVersion);
  if (!saved) throw versionMismatchErr();
  const keys = changedKeys(before, next);
  if (keys.length) {
    const pending = await tx.q.jobCursor(REARM_JOB, REARM_DATE);
    const prior = pending && !pending.done && pending.cursor ? (JSON.parse(pending.cursor) as { keys: string[] }).keys : [];
    await tx.q.saveJobCursor(REARM_JOB, REARM_DATE, JSON.stringify({ keys: [...new Set([...prior, ...keys])], after: null }), 0, false, tx.now);
  }
  await audit(tx, 'settings.life_curve_thresholds', actor, { type: 'settings', id: tx.tenantId }, { version: String(saved.version), categories: String(keys.length) });
  return thresholdsView(saved);
}

export async function putWeights(tx: Tx, actor: string, body: Partial<QueueWeights>, expectedVersion: number | undefined) {
  const merged: QueueWeights = { ...DEFAULT_WEIGHTS, ...body };
  if (!weightsValid(merged)) throw new JourneyError(400, 'invalid-thresholds', 'at least one weight must be above zero');
  const saved = await saveSettings(tx, 'queue_weights', merged, actor, expectedVersion);
  if (!saved) throw versionMismatchErr();
  await tx.q.markRankDirty({ all: true }); // rank-refresh recomputes within 5 min
  await audit(tx, 'settings.queue_weights', actor, { type: 'settings', id: tx.tenantId }, { version: String(saved.version) });
  return weightsView(saved);
}
