// Streaming xlsx reader over a local file: the zip central directory gives the entries, worksheets are inflated as
// streams (node:zlib) and scanned row by row. Shared strings (like exceljs' 'cache' mode) and styles (to recognise
// date cells) are loaded in memory. Written because exceljs' streaming WorkbookReader (unzipper) intermittently
// dropped every worksheet of small files in our tests (~20% of runs), and it cannot name sheets that precede
// xl/workbook.xml in the zip (files written by exceljs and openpyxl).
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createInflateRaw, inflateRawSync } from 'node:zlib';
import { UnreadableFileError } from '../application/ports.js';
import type { SheetRow } from '../application/ports.js';

interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  localOffset: number;
}

async function centralDirectory(file: string): Promise<Map<string, ZipEntry>> {
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
    if (cdOffset + cdSize > size) throw new UnreadableFileError('corrupt zip directory');
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const out = new Map<string, ZipEntry>();
    for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
      const nameLen = cd.readUInt16LE(p + 28);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      out.set(name, {
        name,
        method: cd.readUInt16LE(p + 10),
        compSize: cd.readUInt32LE(p + 20),
        localOffset: cd.readUInt32LE(p + 42),
      });
      p += 46 + nameLen + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32);
    }
    return out;
  } finally {
    await fh.close();
  }
}

async function dataStart(file: string, e: ZipEntry): Promise<number> {
  const fh = await open(file, 'r');
  try {
    const local = Buffer.alloc(30);
    await fh.read(local, 0, 30, e.localOffset);
    if (local.readUInt32LE(0) !== 0x04034b50) throw new UnreadableFileError('corrupt zip entry');
    return e.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  } finally {
    await fh.close();
  }
}

async function entryText(file: string, e: ZipEntry | undefined): Promise<string> {
  if (!e) return '';
  const start = await dataStart(file, e);
  const fh = await open(file, 'r');
  try {
    const data = Buffer.alloc(e.compSize);
    await fh.read(data, 0, e.compSize, start);
    return (e.method === 8 ? inflateRawSync(data) : data).toString('utf8');
  } finally {
    await fh.close();
  }
}

async function* entryChunks(file: string, e: ZipEntry): AsyncGenerator<string> {
  const start = await dataStart(file, e);
  if (e.compSize === 0) return;
  const raw = createReadStream(file, { start, end: start + e.compSize - 1 });
  const stream = e.method === 8 ? raw.pipe(createInflateRaw()) : raw;
  const decoder = new TextDecoder('utf-8');
  for await (const chunk of stream as AsyncIterable<Buffer>) yield decoder.decode(chunk, { stream: true });
  const rest = decoder.decode();
  if (rest) yield rest;
}

export const xmlUnescape = (s: string) =>
  s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    if (k === 'amp') return '&';
    return String.fromCodePoint(k.startsWith('#x') ? parseInt(k.slice(2), 16) : Number(k.slice(1)));
  });

const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

/** Text of `<t>` elements inside an `<si>` / `<is>` (phonetic runs `<rPh>` excluded). */
function runText(xml: string): string {
  const noPhonetic = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const m of noPhonetic.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += m[1] ?? '';
  return xmlUnescape(out);
}

function sharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)) out.push(m[1] ? runText(m[1]) : '');
  return out;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Style index → is a date format (built-in date ids, or a custom format with date/time tokens). */
function dateStyles(xml: string): boolean[] {
  const custom = new Map<number, string>();
  for (const m of xml.matchAll(/<numFmt\b[^>]*>/g)) {
    const id = Number(attr(m[0], 'numFmtId'));
    custom.set(id, xmlUnescape(attr(m[0], 'formatCode') ?? ''));
  }
  const isDateCode = (code: string) => {
    const bare = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
    return /[dmyhs]/i.test(bare) && !/general/i.test(bare);
  };
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? '';
  return [...xfs.matchAll(/<xf\b[^>]*>/g)].map((m) => {
    const id = Number(attr(m[0], 'numFmtId') ?? 0);
    return BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDateCode(custom.get(id) as string));
  });
}

/** Excel serial → ISO date (or date-time when there is a time part). */
export function serialToIso(serial: number, date1904: boolean): string | null {
  if (!Number.isFinite(serial)) return null;
  const ms = Math.round((serial - (date1904 ? 24_107 : 25_569)) * 86_400_000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const iso = d.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('.000Z', 'Z');
}

const colIndex = (ref: string) => {
  let n = 0;
  for (const ch of /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? '') n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

interface Ctx {
  strings: string[];
  dates: boolean[];
  date1904: boolean;
}

function cellValue(open: string, inner: string, ctx: Ctx): string | null {
  const t = attr(open, 't');
  const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
  switch (t) {
    case 's':
      return v === undefined ? null : (ctx.strings[Number(v)] ?? null);
    case 'inlineStr':
      return runText(/<is>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? '');
    case 'str':
      return v === undefined ? null : xmlUnescape(v);
    case 'b':
      return v === undefined ? null : v.trim() === '1' ? 'TRUE' : 'FALSE';
    case 'e':
      return null;
    case 'd':
      return v === undefined ? null : xmlUnescape(v);
    default: {
      if (v === undefined || v.trim() === '') return null;
      const n = Number(v);
      if (!Number.isFinite(n)) return xmlUnescape(v);
      const s = Number(attr(open, 's') ?? 0);
      if (ctx.dates[s]) return serialToIso(n, ctx.date1904);
      return String(n);
    }
  }
}

function parseRow(xml: string, ctx: Ctx): { rowNo: number | undefined; cells: (string | null)[] } {
  const rowNo = Number(attr(/^<row\b[^>]*>/.exec(xml)?.[0] ?? '', 'r')) || undefined;
  const cells: (string | null)[] = [];
  let next = 0;
  for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const open = `<c${m[1] ?? ''}>`;
    const ref = attr(open, 'r');
    const idx = ref ? colIndex(ref) : next;
    next = idx + 1;
    const value = m[2] === undefined ? null : cellValue(open, m[2], ctx);
    while (cells.length < idx) cells.push(null);
    cells[idx] = value;
  }
  return { rowNo, cells };
}

/** Every non-empty row of every worksheet, in workbook order. */
export async function* xlsxRows(file: string): AsyncGenerator<SheetRow> {
  let entries: Map<string, ZipEntry>;
  let ctx: Ctx;
  let sheets: { name: string; entry: ZipEntry }[];
  try {
    entries = await centralDirectory(file);
    const wb = await entryText(file, entries.get('xl/workbook.xml'));
    const rels = await entryText(file, entries.get('xl/_rels/workbook.xml.rels'));
    if (!wb) throw new UnreadableFileError('no xl/workbook.xml: not an xlsx workbook');
    const targets = new Map<string, string>();
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = attr(m[0], 'Id');
      const target = attr(m[0], 'Target');
      if (id && target) targets.set(id, target.replace(/^\/?(xl\/)?/, 'xl/'));
    }
    sheets = [];
    for (const m of wb.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
      const name = attr(m[0], 'name');
      const rid = /\sr:id="([^"]*)"/.exec(m[0])?.[1];
      const entry = rid ? entries.get(targets.get(rid) ?? '') : undefined;
      if (name !== undefined && entry) sheets.push({ name: xmlUnescape(name), entry });
    }
    const pr = /<(?:\w+:)?workbookPr\b[^>]*>/.exec(wb)?.[0] ?? '';
    ctx = {
      strings: sharedStrings(await entryText(file, entries.get('xl/sharedStrings.xml'))),
      dates: dateStyles(await entryText(file, entries.get('xl/styles.xml'))),
      date1904: ['1', 'true'].includes(attr(pr, 'date1904') ?? ''),
    };
  } catch (err) {
    throw err instanceof UnreadableFileError
      ? err
      : new UnreadableFileError('the workbook could not be read', { cause: err });
  }
  for (const { name, entry } of sheets) {
    let buffer = '';
    let seq = 0;
    try {
      for await (const chunk of entryChunks(file, entry)) {
        buffer += chunk;
        let consumed = 0;
        for (const m of buffer.matchAll(/<row\b[^>]*\/>|<row\b[^>]*>[\s\S]*?<\/row>/g)) {
          consumed = (m.index ?? 0) + m[0].length;
          seq += 1;
          if (m[0].endsWith('/>') && !m[0].includes('</row>')) continue;
          const { rowNo, cells } = parseRow(m[0], ctx);
          if (rowNo) seq = rowNo;
          if (cells.every((c) => c === null || c.trim() === '')) continue;
          yield { sheet: name, rowNo: seq, cells };
        }
        buffer = buffer.slice(consumed);
      }
    } catch (err) {
      throw new UnreadableFileError(`sheet "${name}" could not be read`, { cause: err });
    }
  }
}
