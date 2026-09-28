// Export files: Supabase Storage (private bucket insight-exports, 10-minute signed URLs) through its REST API, or a
// local directory when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are absent (local development and tests).
// The streaming .xlsx writer (exceljs WorkbookWriter) lives here too.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import ExcelJS from 'exceljs';
import type { FileStore, SheetColumn, SpreadsheetWriter } from '../application/ports.js';

const TIMEOUT = 10_000;

export function supabaseFileStore(url: string, serviceKey: string, bucket: string): FileStore {
  const base = `${url.replace(/\/$/, '')}/storage/v1`;
  const auth = { authorization: `Bearer ${serviceKey}`, apikey: serviceKey };
  const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');
  return {
    async put(path, body, contentType) {
      const res = await fetch(`${base}/object/${bucket}/${enc(path)}`, {
        method: 'POST',
        headers: { ...auth, 'content-type': contentType, 'x-upsert': 'true' },
        body,
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`storage put ${res.status}`);
    },
    async signedUrl(path, expiresInSec) {
      const res = await fetch(`${base}/object/sign/${bucket}/${enc(path)}`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ expiresIn: expiresInSec }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!res.ok) throw new Error(`storage sign ${res.status}`);
      const body = (await res.json()) as { signedURL?: string };
      return `${base}${body.signedURL ?? ''}`;
    },
    async remove(paths) {
      if (!paths.length) return;
      const res = await fetch(`${base}/object/${bucket}`, {
        method: 'DELETE',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ prefixes: paths }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!res.ok) throw new Error(`storage delete ${res.status}`);
    },
  };
}

export function localFileStore(dir: string): FileStore {
  const file = (path: string) => {
    const p = normalize(join(dir, path));
    if (!p.startsWith(normalize(dir))) throw new Error('path escapes the export directory');
    return p;
  };
  return {
    async put(path, body) {
      await mkdir(dirname(file(path)), { recursive: true });
      await writeFile(file(path), body);
    },
    signedUrl: async (path) => `${pathToFileURL(file(path)).href}?expires=${Date.now() + 600_000}`,
    async remove(paths) {
      for (const p of paths) await rm(file(p), { force: true });
    },
  };
}

export function createFileStore(o: { supabaseUrl?: string | undefined; serviceKey?: string | undefined; bucket: string; localDir?: string | undefined }): FileStore {
  if (o.supabaseUrl && o.serviceKey) return supabaseFileStore(o.supabaseUrl, o.serviceKey, o.bucket);
  return localFileStore(o.localDir ?? join(tmpdir(), o.bucket));
}

const cell = (v: unknown, type: string): ExcelJS.CellValue => {
  if (v === null || v === undefined) return null;
  if (type === 'datetime' && typeof v === 'string') return new Date(v);
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return v as ExcelJS.CellValue;
};

/** exceljs streaming writer: rows are committed as they arrive, so memory stays flat for 100k rows. */
export const xlsxWriter: SpreadsheetWriter = {
  async write(sheetName, columns: readonly SheetColumn[], pages) {
    const out = new PassThrough();
    const parts: Buffer[] = [];
    out.on('data', (c: Buffer) => parts.push(c));
    const ended = new Promise<void>((resolve, reject) => {
      out.on('end', resolve);
      out.on('error', reject);
    });
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: false, useSharedStrings: false });
    const ws = wb.addWorksheet(sheetName.slice(0, 31));
    ws.columns = columns.map((c) => ({ header: c.label, key: c.key, width: Math.min(40, Math.max(10, c.label.length + 2)) }));
    for await (const rows of pages) {
      for (const r of rows) ws.addRow(Object.fromEntries(columns.map((c) => [c.key, cell(r[c.key], c.type)]))).commit();
    }
    ws.commit();
    await wb.commit();
    await ended;
    return new Uint8Array(Buffer.concat(parts));
  },
};
