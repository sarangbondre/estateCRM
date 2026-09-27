// Test files: synthetic extractor datasets (libs/testing, synthetic contacts only) and small hand-made workbooks.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { writeDataset } from '@11e/testing';
import type { SyntheticManifest, SyntheticOptions } from '@11e/testing';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Generates a synthetic upload file (strict-mode 89 columns unless columns are omitted). */
export async function synthFile(
  options: Partial<SyntheticOptions> & { rows: number },
  format: 'xlsx' | 'csv' = 'xlsx',
): Promise<{ bytes: Uint8Array; manifest: SyntheticManifest }> {
  const dir = await mkdtemp(join(tmpdir(), 'intake-test-'));
  try {
    const out = join(dir, `upload.${format}`);
    const { manifest } = await writeDataset(options, { format, out, manifestPath: null });
    return { bytes: new Uint8Array(await readFile(out)), manifest };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type Cell = string | number | boolean | Date | null;

/** A workbook with the given sheets (first row = header). */
export async function workbook(sheets: Record<string, Cell[][]>): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    for (const r of rows) ws.addRow(r);
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

/** CSV text (RFC 4180 quoting). */
export function csv(rows: Cell[][]): Uint8Array {
  const q = (v: Cell) => {
    if (v === null) return '';
    const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return new TextEncoder().encode(rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n');
}
