// Streaming spreadsheet reader (intake LLD §2 adapters/spreadsheet): xlsx with the exceljs streaming WorksheetReader,
// CSV with a small RFC 4180 state machine. The format is sniffed from the bytes (the declared MIME type is not trusted);
// legacy binary .xls (OLE2) has no approved reader and is reported as unreadable.
//
// The object is first streamed to a temp file (sha256 computed on the way, constant memory). For xlsx the sheet names
// are read from xl/workbook.xml through the zip central directory: exceljs' streaming reader only names worksheets
// when workbook.xml precedes them in the zip, which is not the case for files written by exceljs or openpyxl.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { inflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import { UnreadableFileError } from '../application/ports.js';
import type { FileStore, SheetRow, SpreadsheetReader, WorkbookScan } from '../application/ports.js';

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0];
const startsWith = (b: Uint8Array, sig: number[]) => sig.every((v, i) => b[i] === v);

/** Excel cell value → text as a user would read it (never throws). */
export function cellText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('.000Z', 'Z');
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o['richText'])) {
      return (o['richText'] as { text?: string }[]).map((r) => r.text ?? '').join('');
    }
    if ('result' in o) return cellText(o['result']);
    if (typeof o['text'] === 'string') return o['text'];
    if ('error' in o) return null;
  }
  return null;
}

// ---- zip central directory (small files only: workbook.xml and its rels) ----------------------------------------

async function readZipEntries(file: string, wanted: readonly string[]): Promise<Map<string, string>> {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new UnreadableFileError('not a zip file');
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const out = new Map<string, string>();
    for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      p += 46 + nameLen + extraLen + commentLen;
      if (!wanted.includes(name) || compSize > 20_000_000) continue;
      const local = Buffer.alloc(30);
      await fh.read(local, 0, 30, localOffset);
      const dataStart = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const data = Buffer.alloc(compSize);
      await fh.read(data, 0, compSize, dataStart);
      out.set(name, (method === 8 ? inflateRawSync(data) : data).toString('utf8'));
    }
    return out;
  } finally {
    await fh.close();
  }
}

const xmlUnescape = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');

const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

/** Sheet names in workbook order, and worksheet file number (xl/worksheets/sheetN.xml) → name. */
export async function xlsxSheetNames(
  file: string,
): Promise<{ ordered: string[]; byFileNo: Map<string, string>; date1904: boolean }> {
  const entries = await readZipEntries(file, ['xl/workbook.xml', 'xl/_rels/workbook.xml.rels']);
  const wbXml = entries.get('xl/workbook.xml') ?? '';
  const relXml = entries.get('xl/_rels/workbook.xml.rels') ?? '';
  const targets = new Map<string, string>();
  for (const m of relXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    const fileNo = target ? /worksheets\/sheet(\d+)\.xml$/.exec(target)?.[1] : undefined;
    if (id && fileNo) targets.set(id, fileNo);
  }
  const ordered: string[] = [];
  const byFileNo = new Map<string, string>();
  for (const m of wbXml.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
    const name = attr(m[0], 'name');
    if (name === undefined) continue;
    const decoded = xmlUnescape(name);
    ordered.push(decoded);
    const rid = /\sr:id="([^"]*)"/.exec(m[0])?.[1] ?? attr(m[0], 'id');
    const fileNo = rid ? targets.get(rid) : undefined;
    if (fileNo) byFileNo.set(fileNo, decoded);
  }
  const pr = /<(?:\w+:)?workbookPr\b[^>]*>/.exec(wbXml)?.[0] ?? '';
  const date1904 = ['1', 'true'].includes(attr(pr, 'date1904') ?? '');
  return { ordered, byFileNo, date1904 };
}

async function* xlsxRows(file: string): AsyncGenerator<SheetRow> {
  let names: Awaited<ReturnType<typeof xlsxSheetNames>>;
  try {
    names = await xlsxSheetNames(file);
  } catch (err) {
    throw err instanceof UnreadableFileError
      ? err
      : new UnreadableFileError('the workbook could not be read', { cause: err });
  }
  const known = new Set(names.ordered);
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(file, {
    worksheets: 'emit',
    sharedStrings: 'cache',
    hyperlinks: 'ignore',
    styles: 'cache',
    entries: 'ignore',
  });
  // exceljs dereferences reader.model / reader.properties for worksheets met before xl/workbook.xml in the zip
  Object.assign(reader, { model: { sheets: [] }, properties: { model: { date1904: names.date1904 } } });
  try {
    for await (const ws of reader) {
      const w = ws as unknown as { id?: number | string; name?: string };
      const sheet =
        w.name && known.has(w.name)
          ? w.name
          : (names.byFileNo.get(String(w.id)) ?? w.name ?? `Sheet${String(w.id)}`);
      for await (const row of ws as unknown as AsyncIterable<ExcelJS.Row>) {
        const values = row.values as unknown[];
        const cells: (string | null)[] = [];
        for (let i = 1; i < values.length; i++) cells.push(cellText(values[i]));
        if (cells.every((c) => c === null || c.trim() === '')) continue;
        yield { sheet, rowNo: row.number, cells };
      }
    }
  } catch (err) {
    throw new UnreadableFileError('the workbook could not be read', { cause: err });
  }
}

/** RFC 4180 CSV (quotes, doubled quotes, CRLF, embedded newlines, BOM); delimiter sniffed from the first line. */
export async function* csvRows(stream: AsyncIterable<Uint8Array>): AsyncGenerator<SheetRow> {
  const decoder = new TextDecoder('utf-8');
  let delimiter: string | undefined;
  let field = '';
  let row: string[] = [];
  let quoted = false;
  let pendingQuote = false;
  let recordNo = 0;
  let started = false;
  let firstLine = '';

  const endRow = (): SheetRow | undefined => {
    row.push(field);
    field = '';
    const cells = row.map((c) => (c === '' ? null : c));
    row = [];
    recordNo += 1;
    if (cells.every((c) => c === null || c.trim() === '')) return undefined;
    return { sheet: null, rowNo: recordNo, cells };
  };

  const consume = function* (text: string): Generator<SheetRow> {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i] as string;
      if (pendingQuote) {
        pendingQuote = false;
        if (ch === '"') {
          field += '"';
          continue;
        }
        quoted = false;
      }
      if (quoted) {
        if (ch === '"') pendingQuote = true;
        else field += ch;
        continue;
      }
      if (ch === '"' && field === '') quoted = true;
      else if (ch === delimiter) {
        row.push(field);
        field = '';
      } else if (ch === '\n') {
        if (field.endsWith('\r')) field = field.slice(0, -1);
        const r = endRow();
        if (r) yield r;
      } else field += ch;
    }
  };

  for await (const chunk of stream) {
    let text = decoder.decode(chunk, { stream: true });
    if (!started) {
      started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    if (delimiter === undefined) {
      firstLine += text;
      const nl = firstLine.indexOf('\n');
      if (nl < 0 && firstLine.length < 65536) continue;
      const line = nl < 0 ? firstLine : firstLine.slice(0, nl);
      const count = (d: string) => line.split(d).length - 1;
      delimiter = [',', ';', '\t'].reduce((best, d) => (count(d) > count(best) ? d : best), ',');
      text = firstLine;
    }
    yield* consume(text);
  }
  if (delimiter === undefined) {
    delimiter = ',';
    yield* consume(firstLine);
  }
  yield* consume(decoder.decode());
  if (quoted && !pendingQuote) throw new UnreadableFileError('unterminated quoted field in CSV');
  if (field !== '' || row.length > 0) {
    const r = endRow();
    if (r) yield r;
  }
}

/** Downloads the object to a temp file, hashing it and keeping the first bytes. */
async function download(files: FileStore, path: string) {
  const dir = await mkdtemp(join(tmpdir(), 'intake-'));
  const file = join(dir, 'source');
  const hash = createHash('sha256');
  let size = 0;
  let head = new Uint8Array(0);
  const src = await files.read(path);
  const tap = async function* () {
    for await (const chunk of src) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer);
      if (head.byteLength < 8) head = new Uint8Array([...head, ...bytes.subarray(0, 8 - head.byteLength)]);
      hash.update(bytes);
      size += bytes.byteLength;
      yield bytes;
    }
  };
  try {
    await pipeline(Readable.from(tap()), createWriteStream(file));
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return { dir, file, head, sha256: hash.digest('hex'), size };
}

export function spreadsheetReader(files: FileStore): SpreadsheetReader {
  return {
    async open(path): Promise<WorkbookScan> {
      const d = await download(files, path);
      const cleanup = () => rm(d.dir, { recursive: true, force: true });
      try {
        if (startsWith(d.head, OLE2)) {
          throw new UnreadableFileError(
            'legacy binary .xls files are not supported; save the sheet as .xlsx or .csv',
          );
        }
        const kind = startsWith(d.head, ZIP) ? 'xlsx' : 'csv';
        const inner = kind === 'xlsx' ? xlsxRows(d.file) : csvRows(createReadStream(d.file));
        const rows = (async function* () {
          try {
            yield* inner;
          } finally {
            await cleanup();
          }
        })();
        return { kind, rows, summary: () => ({ sha256: d.sha256, sizeBytes: d.size }) };
      } catch (err) {
        await cleanup();
        throw err;
      }
    },
  };
}
