// migration_map sheet (CR-006 Z-5, LLD §4.10): old_ad_id → new_record_ids (split on | or ,) with action kept/merged/split.
import { normaliseHeader } from './schema.js';

export type MigrationAction = 'kept' | 'merged' | 'split';

export interface MigrationEntry {
  entryNo: number;
  oldRef: string;
  newRefs: string[];
  action: MigrationAction;
}

export interface MigrationIssue {
  rowNo: number;
  field: 'old_ad_id' | 'new_record_ids' | 'action' | 'header';
  message: string;
}

const HEX12 = /^[0-9a-f]{12}$/;
const ACTIONS: readonly string[] = ['kept', 'merged', 'split'];

/** Streaming parser: feed the header row, then each data row in order. */
export class MigrationMapParser {
  #cols: { old: number; neu: number; action: number } | undefined;
  #entryNo = 0;
  readonly entries: MigrationEntry[] = [];
  readonly issues: MigrationIssue[] = [];

  header(rowNo: number, cells: readonly (string | null)[]): void {
    const idx = (name: string) => cells.findIndex((c) => normaliseHeader(c) === name);
    const cols = { old: idx('old_ad_id'), neu: idx('new_record_ids'), action: idx('action') };
    if (cols.old < 0 || cols.neu < 0 || cols.action < 0) {
      this.issues.push({
        rowNo,
        field: 'header',
        message: 'migration_map needs old_ad_id, new_record_ids and action',
      });
      return;
    }
    this.#cols = cols;
  }

  row(rowNo: number, cells: readonly (string | null)[]): void {
    const cols = this.#cols;
    if (!cols) return;
    this.#entryNo += 1;
    const oldRef = (cells[cols.old] ?? '').trim().toLowerCase();
    const newRefs = (cells[cols.neu] ?? '')
      .split(/[|,]/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s !== '');
    const action = (cells[cols.action] ?? '').trim().toLowerCase();
    if (!HEX12.test(oldRef)) {
      this.issues.push({ rowNo, field: 'old_ad_id', message: 'old_ad_id must be a 12-hex record id' });
      return;
    }
    if (!ACTIONS.includes(action)) {
      this.issues.push({ rowNo, field: 'action', message: 'action must be kept, merged or split' });
      return;
    }
    if (newRefs.length === 0 || newRefs.some((r) => !HEX12.test(r))) {
      this.issues.push({
        rowNo,
        field: 'new_record_ids',
        message: 'new_record_ids must be 12-hex ids separated by | or ,',
      });
      return;
    }
    if (action === 'kept' && newRefs.length !== 1) {
      this.issues.push({
        rowNo,
        field: 'new_record_ids',
        message: 'a kept entry maps to exactly one new id',
      });
      return;
    }
    this.entries.push({ entryNo: this.#entryNo, oldRef, newRefs, action: action as MigrationAction });
  }
}
