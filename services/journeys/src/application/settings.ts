// Settings journeys enforces (LLD §3.3 settings; US-34): life-curve thresholds and queue weights. The seed values are
// the domain defaults; a tenant without a row uses them (version 0).
import { DEFAULT_THRESHOLDS } from '../domain/lifecurve.js';
import type { ThresholdSettings } from '../domain/lifecurve.js';
import { DEFAULT_WEIGHTS } from '../domain/queue.js';
import type { QueueWeights } from '../domain/queue.js';
import type { SettingsRow } from './model.js';
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
