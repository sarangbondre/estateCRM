import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  EXTRACTOR_COLUMNS,
  csvField,
  filePath,
  generate,
  writeDataset,
  type CellValue,
  type SyntheticManifest,
} from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), '11e-synth-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Minimal RFC 4180 parser (quoted fields, doubled quotes, CRLF). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function asCsvText(value: CellValue): string {
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

const OPTIONS = { rows: 400, seed: 17, errorRate: 0.05 };
const EXPECTED = generate(OPTIONS);

describe('NDJSON writer', () => {
  it('writes one parseable object per row, identical to the generator output, plus a manifest', async () => {
    const out = join(dir, 'rows.ndjson');
    const { manifest } = await writeDataset(OPTIONS, { format: 'ndjson', out });
    const lines = readFileSync(out, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(400);
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual(EXPECTED.map((r) => r.row));
    const written = JSON.parse(readFileSync(`${out}.manifest.json`, 'utf8')) as SyntheticManifest;
    expect(written.totals).toEqual(manifest.totals);
    expect(written.errors).toEqual(manifest.errors);
    expect(manifest.totals.rejected).toBe(EXPECTED.filter((r) => r.meta.error !== null).length);
  });
});

describe('CSV writer', () => {
  it('quotes per RFC 4180', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line\nbreak')).toBe('"line\nbreak"');
    expect(csvField(true)).toBe('TRUE');
    expect(csvField(null)).toBe('');
    expect(csvField(12.5)).toBe('12.5');
  });

  it('writes the 89-column header and rows that parse back to the same values', async () => {
    const out = join(dir, 'rows.csv');
    await writeDataset(OPTIONS, { format: 'csv', out, manifestPath: null });
    const [header, ...rows] = parseCsv(readFileSync(out, 'utf8'));
    expect(header).toEqual([...EXTRACTOR_COLUMNS]);
    expect(rows).toHaveLength(400);
    rows.forEach((cells, i) => {
      const row = EXPECTED[i]?.row;
      expect(cells).toEqual(EXTRACTOR_COLUMNS.map((c) => asCsvText(row?.[c] ?? null)));
    });
  });

  it('leaves out omitted columns and reports mapping mode', async () => {
    const out = join(dir, 'mapping.csv');
    const { manifest } = await writeDataset(
      { rows: 20, seed: 1, omitColumns: ['record_id', 'side'] },
      { format: 'csv', out, manifestPath: null },
    );
    const [header] = parseCsv(readFileSync(out, 'utf8'));
    expect(header).toHaveLength(87);
    expect(header).not.toContain('record_id');
    expect(manifest.mode).toBe('mapping');
    expect(manifest.columns).toEqual(header);
  });
});

describe('XLSX writer', () => {
  it('writes sheet Leads (header, rows, date cells) and run_log, readable by exceljs', async () => {
    const out = join(dir, 'upload.xlsx');
    await writeDataset(OPTIONS, { format: 'xlsx', out, manifestPath: null });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(out);
    expect(workbook.worksheets.map((s) => s.name)).toEqual(['Leads', 'run_log']);
    const sheet = workbook.getWorksheet('Leads');
    expect(sheet).toBeDefined();
    if (sheet === undefined) return;
    const header = (sheet.getRow(1).values as unknown[]).slice(1);
    expect(header).toEqual([...EXTRACTOR_COLUMNS]);
    expect(sheet.actualRowCount).toBe(401);
    const col = (name: string): number =>
      EXTRACTOR_COLUMNS.indexOf(name as (typeof EXTRACTOR_COLUMNS)[number]) + 1;
    for (let i = 0; i < 400; i += 1) {
      const expected = EXPECTED[i]?.row;
      const row = sheet.getRow(i + 2);
      const id = row.getCell(col('record_id')).value;
      expect(id ?? null).toBe(expected?.record_id ?? null);
      expect(row.getCell(col('raw_text')).value).toBe(expected?.raw_text);
      const date = row.getCell(col('source_date')).value;
      const iso = expected?.source_date;
      if (
        typeof iso === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(iso) &&
        !Number.isNaN(Date.parse(iso)) &&
        new Date(iso).toISOString().startsWith(iso)
      ) {
        expect(date).toBeInstanceOf(Date);
        expect((date as Date).toISOString().slice(0, 10)).toBe(iso);
      } else {
        expect(date).toBe(iso);
      }
      const review = row.getCell(col('needs_review')).value;
      expect(review).toBe(expected?.needs_review);
    }
  });

  it('streams a larger file through the streaming reader', async () => {
    const out = join(dir, 'large.xlsx');
    await writeDataset({ rows: 5_000, seed: 2 }, { format: 'xlsx', out, manifestPath: null });
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(out, {});
    let rows = 0;
    for await (const worksheet of reader) {
      for await (const row of worksheet) {
        void row;
        rows += 1;
      }
      break;
    }
    expect(rows).toBe(5_001);
  }, 60_000); // CI runners are shared: generous timeout, the assertion is correctness not speed
});

describe('multi-file datasets', () => {
  it('numbers file paths', () => {
    expect(filePath('/x/upload.xlsx', 0, 1)).toBe('/x/upload.xlsx');
    expect(filePath('/x/upload.xlsx', 1, 3)).toBe('/x/upload-002.xlsx');
    expect(filePath('/x/part-{n}.csv', 9, 50)).toBe('/x/part-010.csv');
  });

  it('splits rows into upload-sized files without splitting an ad across files', async () => {
    const sub = mkdtempSync(join(dir, 'multi-'));
    const out = join(sub, 'upload.ndjson');
    const { manifest } = await writeDataset(
      { rows: 2_500, seed: 8, rowsPerFile: 1_000, errorRate: 0.05 },
      { format: 'ndjson', out },
    );
    expect(manifest.files.map((f) => f.rows)).toEqual([1_000, 1_000, 500]);
    expect(readdirSync(sub).sort()).toEqual([
      'upload-001.ndjson',
      'upload-002.ndjson',
      'upload-003.ndjson',
      'upload.ndjson.manifest.json',
    ]);
    for (const file of ['upload-001.ndjson', 'upload-002.ndjson', 'upload-003.ndjson']) {
      const rows = readFileSync(join(sub, file), 'utf8')
        .trimEnd()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      const first = rows[0];
      expect(first?.split_index === null || String(first?.split_index).startsWith('1 of')).toBe(true);
      const last = rows[rows.length - 1];
      const m = /^(\d+) of (\d+)$/.exec(String(last?.split_index));
      if (m !== null) expect(m[1]).toBe(m[2]);
    }
  });

  it('writes a header-only file for zero rows', async () => {
    const out = join(dir, 'empty.csv');
    const { manifest } = await writeDataset({ rows: 0, seed: 1 }, { format: 'csv', out, manifestPath: null });
    expect(readFileSync(out, 'utf8')).toBe(`${EXTRACTOR_COLUMNS.join(',')}\r\n`);
    expect(manifest.totals.rows).toBe(0);
  });
});
