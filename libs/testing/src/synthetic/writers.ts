/**
 * Streaming writers (constant memory): NDJSON, CSV and XLSX (exceljs streaming WorkbookWriter),
 * plus `writeDataset`, which generates, writes (optionally split into upload-sized files) and
 * returns the expected manifest.
 */
import { createWriteStream, type WriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { basename, extname } from 'node:path';
import ExcelJS from 'exceljs';
import {
  DATE_COLUMNS,
  EXTRACTOR_COLUMNS,
  type CellValue,
  type ExtractorColumn,
  type ExtractorRow,
} from './columns.js';
import { SyntheticGenerator } from './generator.js';
import { ManifestBuilder, type ManifestFile, type SyntheticManifest } from './manifest.js';
import type { SyntheticOptions } from './options.js';

export const OUTPUT_FORMATS = ['ndjson', 'csv', 'xlsx'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** A destination for rows of one file. */
export interface RowSink {
  write(row: ExtractorRow): Promise<void>;
  close(): Promise<void>;
}

const FLUSH_BYTES = 1 << 16;

/** Buffered text writer with backpressure. */
class TextFile {
  private readonly stream: WriteStream;
  private buffer: string[] = [];
  private size = 0;

  constructor(path: string) {
    this.stream = createWriteStream(path, { encoding: 'utf8' });
  }

  async push(text: string): Promise<void> {
    this.buffer.push(text);
    this.size += text.length;
    if (this.size >= FLUSH_BYTES) await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const chunk = this.buffer.join('');
    this.buffer = [];
    this.size = 0;
    if (!this.stream.write(chunk)) await once(this.stream, 'drain');
  }

  async close(): Promise<void> {
    await this.flush();
    this.stream.end();
    await once(this.stream, 'finish');
  }
}

function pickColumns(row: ExtractorRow, columns: readonly ExtractorColumn[]): Record<string, CellValue> {
  const out: Record<string, CellValue> = {};
  for (const column of columns) out[column] = row[column];
  return out;
}

export class NdjsonSink implements RowSink {
  private readonly file: TextFile;
  private readonly all: boolean;

  constructor(
    path: string,
    private readonly columns: readonly ExtractorColumn[] = EXTRACTOR_COLUMNS,
  ) {
    this.file = new TextFile(path);
    this.all = columns.length === EXTRACTOR_COLUMNS.length;
  }

  write(row: ExtractorRow): Promise<void> {
    // Generated rows already hold every column in schema order.
    return this.file.push(`${JSON.stringify(this.all ? row : pickColumns(row, this.columns))}\n`);
  }

  close(): Promise<void> {
    return this.file.close();
  }
}

/** One CSV field (RFC 4180). Booleans are TRUE / FALSE; blank is an empty field. */
export function csvField(value: CellValue): string {
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export class CsvSink implements RowSink {
  private readonly file: TextFile;
  private started = false;

  constructor(
    path: string,
    private readonly columns: readonly ExtractorColumn[] = EXTRACTOR_COLUMNS,
  ) {
    this.file = new TextFile(path);
  }

  async write(row: ExtractorRow): Promise<void> {
    if (!this.started) {
      this.started = true;
      await this.file.push(`${this.columns.join(',')}\r\n`);
    }
    let line = '';
    for (let i = 0; i < this.columns.length; i += 1) {
      if (i > 0) line += ',';
      line += csvField(row[this.columns[i] as ExtractorColumn]);
    }
    await this.file.push(`${line}\r\n`);
  }

  async close(): Promise<void> {
    if (!this.started) await this.file.push(`${this.columns.join(',')}\r\n`);
    await this.file.close();
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function xlsxCell(column: ExtractorColumn, value: CellValue): CellValue | Date {
  if (typeof value === 'string' && DATE_COLUMNS.has(column) && ISO_DATE.test(value)) {
    const date = new Date(`${value}T00:00:00Z`);
    // Invalid calendar dates (error injection) stay text, like a bad cell in a real sheet.
    if (!Number.isNaN(date.getTime()) && date.toISOString().startsWith(value)) return date;
  }
  return value;
}

/** Rows between event-loop yields, so the zip stream can drain to disk. */
const XLSX_YIELD_EVERY = 500;

/**
 * XLSX in the extractor master layout: sheet `Leads` (header + rows, dates as date cells) and a
 * one-row `run_log` sheet (ignored by intake).
 */
export class XlsxSink implements RowSink {
  private readonly workbook: ExcelJS.stream.xlsx.WorkbookWriter;
  private readonly sheet: ExcelJS.Worksheet;
  private count = 0;

  constructor(
    path: string,
    private readonly columns: readonly ExtractorColumn[] = EXTRACTOR_COLUMNS,
    private readonly runNote = 'synthetic dataset',
  ) {
    this.workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      filename: path,
      useStyles: true,
      useSharedStrings: false,
    });
    this.sheet = this.workbook.addWorksheet('Leads');
    this.sheet.columns = columns.map((column) => ({
      header: column,
      key: column,
      width: Math.max(10, Math.min(40, column.length + 2)),
      ...(DATE_COLUMNS.has(column) ? { style: { numFmt: 'yyyy-mm-dd' } } : {}),
    }));
  }

  async write(row: ExtractorRow): Promise<void> {
    const values = this.columns.map((column) => xlsxCell(column, row[column]));
    this.sheet.addRow(values).commit();
    this.count += 1;
    if (this.count % XLSX_YIELD_EVERY === 0) await this.drain();
  }

  /**
   * exceljs pipes the sheet XML into the zip entry without backpressure, so on large files the
   * XML piles up in memory while deflate catches up. Wait for the entry stream to drain.
   */
  private async drain(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const pipes = (this.sheet as unknown as { stream?: { pipes?: unknown[] } }).stream?.pipes ?? [];
    for (const pipe of pipes) {
      // archiver wraps the sheet in a readable-stream v2 PassThrough (no `writableNeedDrain`).
      const writable = pipe as Partial<Writable> & { _writableState?: { needDrain?: boolean } };
      const needDrain = writable.writableNeedDrain ?? writable._writableState?.needDrain ?? false;
      if (needDrain && typeof writable.once === 'function') await once(writable as Writable, 'drain');
    }
  }

  async close(): Promise<void> {
    this.sheet.commit();
    const log = this.workbook.addWorksheet('run_log');
    log.addRow(['run_at', 'run_type', 'records', 'notes']).commit();
    log.addRow([new Date(Date.UTC(2026, 0, 1)), 'synthetic', this.count, this.runNote]).commit();
    log.commit();
    await this.workbook.commit();
  }
}

export function createSink(format: OutputFormat, path: string, columns: readonly ExtractorColumn[]): RowSink {
  switch (format) {
    case 'ndjson':
      return new NdjsonSink(path, columns);
    case 'csv':
      return new CsvSink(path, columns);
    case 'xlsx':
      return new XlsxSink(path, columns);
  }
}

/**
 * Path of file `index` (0-based) of `count`. With one file the path is used as given. Otherwise a
 * `{n}` placeholder is replaced by the 1-based, zero-padded number, or `-NNN` goes before the extension.
 */
export function filePath(out: string, index: number, count: number): string {
  if (count <= 1 && !out.includes('{n}')) return out;
  const n = String(index + 1).padStart(Math.max(3, String(count).length), '0');
  if (out.includes('{n}')) return out.replaceAll('{n}', n);
  const ext = extname(out);
  return `${out.slice(0, out.length - ext.length)}-${n}${ext}`;
}

export interface WriteDatasetOptions {
  readonly format: OutputFormat;
  /** Output path (see `filePath` for multi-file datasets). */
  readonly out: string;
  /** Where to write the manifest JSON; null = do not write. Default `<out>.manifest.json`. */
  readonly manifestPath?: string | null;
}

export interface WriteDatasetResult {
  readonly manifest: SyntheticManifest;
  readonly elapsedMs: number;
  readonly rowsPerSecond: number;
}

/** Generates `options.rows` rows, streams them to file(s) and returns (and writes) the manifest. */
export async function writeDataset(
  options: Partial<SyntheticOptions> & { readonly rows: number },
  write: WriteDatasetOptions,
): Promise<WriteDatasetResult> {
  const started = performance.now();
  const generator = new SyntheticGenerator(options);
  const resolved = generator.options;
  const builder = new ManifestBuilder(resolved);
  const omitted = new Set<string>(resolved.omitColumns);
  const columns = EXTRACTOR_COLUMNS.filter((c) => !omitted.has(c));
  const fileCount = Math.max(1, Math.ceil(resolved.rows / resolved.rowsPerFile));
  const files: ManifestFile[] = [];

  let sink: RowSink | null = null;
  let current: { index: number; path: string; rows: number; first: number; last: number } | null = null;
  const closeCurrent = async (): Promise<void> => {
    if (sink === null || current === null) return;
    await sink.close();
    files.push({
      index: current.index,
      path: basename(current.path),
      rows: current.rows,
      firstRowNo: current.first,
      lastRowNo: current.last,
    });
  };

  for (const record of generator.records()) {
    if (current === null || record.meta.fileIndex !== current.index) {
      await closeCurrent();
      const path = filePath(write.out, record.meta.fileIndex, fileCount);
      sink = createSink(write.format, path, columns);
      current = {
        index: record.meta.fileIndex,
        path,
        rows: 0,
        first: record.meta.rowNo,
        last: record.meta.rowNo,
      };
    }
    builder.add(record);
    current.rows += 1;
    current.last = record.meta.rowNo;
    await (sink as RowSink).write(record.row);
  }
  if (current === null) {
    // Zero rows: still write one file with the header only.
    const path = filePath(write.out, 0, 1);
    sink = createSink(write.format, path, columns);
    current = { index: 0, path, rows: 0, first: 0, last: 0 };
  }
  await closeCurrent();

  const manifest = builder.build(files);
  const manifestPath =
    write.manifestPath === undefined
      ? `${write.out.replaceAll('{n}', 'all')}.manifest.json`
      : write.manifestPath;
  if (manifestPath !== null) await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const elapsedMs = performance.now() - started;
  return {
    manifest,
    elapsedMs,
    rowsPerSecond: elapsedMs > 0 ? Math.round((resolved.rows / elapsedMs) * 1000) : 0,
  };
}
