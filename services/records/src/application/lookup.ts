// `{idOrCode}` resolution (records LLD §4.1): a UUID or a display code with the table's prefix. Voided records are
// hidden (LLD §4.16); merged records are returned with their status so clients can follow mergedIntoId.
import { parseIdOrCode } from '../domain/codes.js';
import type { CodePrefix } from '../domain/codes.js';
import { notFound } from '../domain/errors.js';
import type { Tables } from './model.js';
import type { CodedTable, Tx } from './ports.js';

const PREFIXES: Record<CodedTable, readonly CodePrefix[]> = {
  persons: ['PER'],
  projects: ['PRJ'],
  properties: ['PRP'],
  offers: ['INV'],
  demands: ['DEM'],
  desk_items: ['BIZ', 'CAP', 'EQP', 'WCH'],
  enquiries: ['ENQ'],
  source_ads: ['AD'],
};

const NAMES: Record<CodedTable, string> = {
  persons: 'person',
  projects: 'project',
  properties: 'property',
  offers: 'offer',
  demands: 'demand',
  desk_items: 'desk item',
  enquiries: 'enquiry',
  source_ads: 'source ad',
};

export async function findByIdOrCode<T extends CodedTable>(
  tx: Tx,
  table: T,
  idOrCode: string,
  options: { lock?: boolean } = {},
): Promise<Tables[T] | undefined> {
  const key = parseIdOrCode(idOrCode, PREFIXES[table]);
  if (!key) return undefined;
  const row =
    'id' in key
      ? await tx.store.get(table, key.id, options)
      : await tx.store.getByCode(table, key.code, options);
  if (row && (row as { status?: string }).status === 'voided') return undefined;
  return row;
}

export async function mustFind<T extends CodedTable>(
  tx: Tx,
  table: T,
  idOrCode: string,
  options: { lock?: boolean } = {},
): Promise<Tables[T]> {
  const row = await findByIdOrCode(tx, table, idOrCode, options);
  if (!row) throw notFound(NAMES[table]);
  return row;
}
