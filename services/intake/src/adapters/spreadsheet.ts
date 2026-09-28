// Streaming spreadsheet reader (intake LLD §2 adapters/spreadsheet): xlsx via ./xlsx.ts (zip central directory +
// streamed worksheet XML), CSV with a small RFC 4180 state machine. The format is sniffed from the bytes (the declared
// MIME type is not trusted); legacy binary .xls (OLE2) has no approved reader and is reported as unreadable. The object
// is first streamed to a temp file (sha256 computed on the way, constant memory).
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { UnreadableFileError } from '../application/ports.js';
import type { FileStore, SheetRow, SpreadsheetReader, WorkbookScan } from '../application/ports.js';
import { xlsxRows } from './xlsx.js';

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0];
const startsWith = (b: Uint8Array, sig: number[]) => sig.every((v, i) => b[i] === v);

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
