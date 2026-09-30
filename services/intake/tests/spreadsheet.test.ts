// Adapter: streaming xlsx (exceljs) and CSV reading with sha256, sniffing the format from the bytes.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { spreadsheetReader } from '../src/adapters/spreadsheet.js';
import { UnreadableFileError } from '../src/application/ports.js';
import type { SheetRow } from '../src/application/ports.js';
import { MemoryFileStore } from './support/fakes.js';
import { synthFile, workbook } from './support/files.js';

async function readAll(bytes: Uint8Array) {
  const files = new MemoryFileStore();
  await files.put('intake-uploads/t/u/source', bytes);
  const scan = await spreadsheetReader(files).open('intake-uploads/t/u/source');
  const rows: SheetRow[] = [];
  for await (const r of scan.rows) rows.push(r);
  return { kind: scan.kind, rows, summary: scan.summary() };
}

describe('CSV', () => {
  it('parses quotes, doubled quotes, embedded newlines, CRLF and a BOM; skips empty rows', async () => {
    const text = '﻿a,b,c\r\n1,"x, ""y""","multi\nline"\r\n,,\r\n2,,z';
    const { kind, rows, summary } = await readAll(new TextEncoder().encode(text));
    expect(kind).toBe('csv');
    expect(rows).toEqual([
      { sheet: null, rowNo: 1, cells: ['a', 'b', 'c'] },
      { sheet: null, rowNo: 2, cells: ['1', 'x, "y"', 'multi\nline'] },
      { sheet: null, rowNo: 4, cells: ['2', null, 'z'] },
    ]);
    expect(summary.sha256).toBe(createHash('sha256').update(text).digest('hex'));
  });

  it('sniffs a semicolon delimiter', async () => {
    const { rows } = await readAll(new TextEncoder().encode('a;b\n1;2,5\n'));
    expect(rows[1]?.cells).toEqual(['1', '2,5']);
  });

  it('reads a synthetic CSV upload', async () => {
    const { bytes } = await synthFile({ rows: 30, seed: 3 }, 'csv');
    const { rows } = await readAll(bytes);
    expect(rows).toHaveLength(31);
    expect(rows[0]?.cells).toHaveLength(91);
  });
});

describe('xlsx', () => {
  it('reads every sheet with its name, typed cells as text, and the sha256 of the bytes', async () => {
    const bytes = await workbook({
      Leads: [
        ['record_id', 'bhk_min', 'is_jodi', 'source_date'],
        ['aaaaaaaaaaa1', 2.5, true, new Date(Date.UTC(2026, 6, 6))],
        [null, null, null, null],
        ['aaaaaaaaaaa2', 3, false, '2026-07-07'],
      ],
      migration_map: [
        ['old_ad_id', 'new_record_ids', 'action'],
        ['bbbbbbbbbbb1', 'aaaaaaaaaaa1', 'kept'],
      ],
    });
    const { kind, rows, summary } = await readAll(bytes);
    expect(kind).toBe('xlsx');
    expect(rows.filter((r) => r.sheet === 'Leads').map((r) => [r.rowNo, r.cells])).toEqual([
      [1, ['record_id', 'bhk_min', 'is_jodi', 'source_date']],
      [2, ['aaaaaaaaaaa1', '2.5', 'TRUE', '2026-07-06']],
      [4, ['aaaaaaaaaaa2', '3', 'FALSE', '2026-07-07']],
    ]);
    expect(rows.filter((r) => r.sheet === 'migration_map')).toHaveLength(2);
    expect(summary.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(summary.sizeBytes).toBe(bytes.byteLength);
  });

  it('reads a synthetic extractor workbook (Leads + run_log)', async () => {
    const { bytes } = await synthFile({ rows: 40, seed: 5 });
    const { rows } = await readAll(bytes);
    const leads = rows.filter((r) => r.sheet === 'Leads');
    expect(leads).toHaveLength(41);
    expect(rows.some((r) => r.sheet === 'run_log')).toBe(true);
  });

  it('never loses the sheets of small workbooks (regression: exceljs streaming reader dropped them ~20% of runs)', async () => {
    for (let i = 0; i < 50; i++) {
      const bytes = await workbook({
        Leads: [
          ['record_id', 'raw_text'],
          ['aaaaaaaaaaa1', `x${i}`],
        ],
      });
      const { rows } = await readAll(bytes);
      expect(rows.map((r) => r.sheet)).toEqual(['Leads', 'Leads']);
    }
  });

  it('refuses legacy binary .xls (OLE2) as unreadable', async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0]);
    await expect(readAll(ole)).rejects.toBeInstanceOf(UnreadableFileError);
  });

  it('reports a corrupt zip as unreadable', async () => {
    const bad = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(readAll(bad)).rejects.toBeInstanceOf(UnreadableFileError);
  });
});
