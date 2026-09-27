// Merge guards and the undo rule (records LLD §4.7, US-09, HLD §7).
import { RecordsError } from './errors.js';

export const MERGE_ROW_LIMIT = 5000;
export type MergeAggregate = 'property' | 'offer' | 'demand' | 'person';

export interface MergeParticipant {
  id: string;
  status: string;
  /** ingested parent ref, for the split-sibling rule (Z-3). */
  parentExternalRef: string | null;
}

/** Same type (the caller loads by type), all active, distinct, not split siblings. */
export function assertMergeAllowed(survivor: MergeParticipant, merged: readonly MergeParticipant[]): void {
  const all = [survivor, ...merged];
  const ids = new Set(all.map((p) => p.id));
  if (ids.size !== all.length) throw new RecordsError('merge-not-allowed', 'a record appears twice');
  if (all.some((p) => p.status !== 'active')) throw new RecordsError('merge-not-allowed', 'every record must be active');
  const parents = all.map((p) => p.parentExternalRef).filter((p): p is string => p !== null);
  if (new Set(parents).size !== parents.length) {
    throw new RecordsError('merge-not-allowed', 'split siblings of one ad are never merged');
  }
}

export function assertMergeSize(rowsToMove: number, userRequest: boolean): void {
  if (userRequest && rowsToMove > MERGE_ROW_LIMIT) throw new RecordsError('merge-too-large');
}

/** Stable JSON equality for logged column values. */
export function sameValue(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(v: unknown): string {
  if (v === undefined) return 'null';
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export interface UndoEntry {
  seq: number;
  table: string;
  rowId: string;
  column: string;
  oldValue: unknown;
  newValue: unknown;
}

/**
 * Undo replays the log in reverse: a column is restored only when its current value still equals what the merge
 * wrote; otherwise it was changed after the merge, is left alone and reported as a conflict.
 */
export function planUndo(
  entries: readonly UndoEntry[],
  current: (table: string, rowId: string, column: string) => unknown,
): { restore: UndoEntry[]; conflicts: UndoEntry[] } {
  const restore: UndoEntry[] = [];
  const conflicts: UndoEntry[] = [];
  for (const e of [...entries].sort((a, b) => b.seq - a.seq)) {
    if (sameValue(current(e.table, e.rowId, e.column), e.newValue)) restore.push(e);
    else conflicts.push(e);
  }
  return { restore, conflicts };
}

/** Survivor facts: a blank survivor column takes the first non-blank value of the merged records. */
export function fillBlanks<T extends Record<string, unknown>>(
  survivor: T,
  merged: readonly T[],
  columns: readonly (keyof T & string)[],
): Partial<T> {
  const patch: Partial<T> = {};
  for (const col of columns) {
    const cur = survivor[col];
    const blank = cur === null || cur === undefined || (Array.isArray(cur) && cur.length === 0);
    if (!blank) continue;
    const donor = merged.find((m) => {
      const v = m[col];
      return !(v === null || v === undefined || (Array.isArray(v) && v.length === 0));
    });
    if (donor) patch[col] = donor[col];
  }
  return patch;
}
