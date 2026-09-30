// INT-07: pilot anonymise-on-import (CR-006 Z-9, LLD §4.9): consistent fakes, applied at split so no original contact
// is written anywhere but the source file, which is deleted right after the split.
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findPhoneLikeNumbers, generate, isSyntheticPhone } from '@11e/testing';
import { Anonymiser } from '../src/domain/anonymisation.js';
import { createHarness, newTenant } from './support/harness.js';
import type { Harness } from './support/harness.js';
import { synthFile } from './support/files.js';
import { processAll, uploadAndSplit } from './support/flows.js';

const anon = new Anonymiser((s) => createHmac('sha256', 'k').update(s).digest('hex'));

describe('Anonymiser (domain)', () => {
  it('gives the same fake for the same contact in any written form', () => {
    expect(anon.phone('+91 90000 11111')).toBe(anon.phone('09000011111'));
    expect(anon.phone('9000011111')).toMatch(/^\+9100000\d{6}$/);
    expect(anon.name('Rahul  Sharma')).toBe(anon.name('rahul sharma'));
    expect(anon.email('A.B@Example.com')).toMatch(/^u[0-9a-f]{10}@example\.invalid$/);
    expect(anon.other('www.acme.example.com')).toMatch(/^contact-[0-9a-f]{8}$/);
    expect(
      new Anonymiser((s) => createHmac('sha256', 'other-key').update(s).digest('hex')).phone('9000011111'),
    ).not.toBe(anon.phone('9000011111'));
  });

  it('replaces contacts inside free text and keeps everything else', () => {
    const out = anon.text('2BHK Powai 1.8 Cr, Flat 1203. Contact Sanjay 90000 01234 or s.k@example.com');
    expect(out).toContain('2BHK Powai 1.8 Cr');
    expect(out).toContain(anon.phone('90000 01234'));
    expect(out).toContain(anon.email('s.k@example.com'));
    expect(out).not.toMatch(/Sanjay|01234|s\.k@/);
  });

  it('maps a row by column target; company and RERA are kept; unmapped columns are scanned', () => {
    const row = anon.row(
      ['contact_name', 'phones', 'company_name', 'rera_number', null],
      ['Test Person', '9000011111|9000022222', 'Acme Realty', 'P99912345678', 'call 90000 33333'],
    );
    expect(row).toEqual([
      anon.name('Test Person'),
      `${anon.phone('9000011111')}|${anon.phone('9000022222')}`,
      'Acme Realty',
      'P99912345678',
      `call ${anon.phone('90000 33333')}`,
    ]);
  });

  it('leaves building_name and floor as they are (not contact data, CR-012)', () => {
    expect(anon.row(['building_name', 'floor'], ['Sea Breeze Tower', '12 of 20'])).toEqual([
      'Sea Breeze Tower',
      '12 of 20',
    ]);
  });
});

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

describe('anonymise at split (pilot)', () => {
  it('writes no original contact to chunk files or raw rows, deletes the source, and is consistent across uploads', async () => {
    const opts = { rows: 300, seed: 41, whatsappRate: 0.2 };
    const rows = generate(opts);
    const originals = new Set<string>();
    for (const { row } of rows) {
      for (const col of [
        'phones',
        'whatsapp_phone',
        'sender_phone',
        'emails',
        'contact_name',
        'sender_name',
        'other_contact',
      ] as const) {
        const v = row[col];
        if (typeof v === 'string')
          for (const p of v.split('|')) if (p.trim().length > 4) originals.add(p.trim());
      }
    }
    // company names are kept by design (LLD §4.9) even when the extractor also put one in contact_name
    for (const { row } of rows) if (typeof row.company_name === 'string') originals.delete(row.company_name);
    expect(originals.size).toBeGreaterThan(100);
    const { bytes } = await synthFile(opts);
    const t = newTenant();
    const u = await uploadAndSplit(h, t, bytes);
    expect(h.files.objects.has(`intake-uploads/${t}/${u.id}/source`)).toBe(false);
    const chunkText = [...h.files.objects.entries()]
      .filter(([k]) => k.startsWith(`intake-uploads/${t}/${u.id}/chunks/`))
      .map(([, v]) => new TextDecoder().decode(v))
      .join('\n');
    for (const v of originals) {
      const i = chunkText.indexOf(v);
      expect(i < 0, `${v}: …${chunkText.slice(Math.max(0, i - 80), i + 40)}…`).toBe(true);
    }
    // no real-looking synthetic mobile survives (the anonymised +9100000 form is allowed)
    // (12-hex record ids and other hex strings can contain phone-like digit runs: masked before scanning)
    const scanned = chunkText.replace(/\b[0-9a-f]{12,64}\b/gi, '<hex>');
    expect(
      findPhoneLikeNumbers(scanned).filter((p) => isSyntheticPhone(p) && !p.startsWith('+9100000')),
    ).toEqual([]);

    await processAll(h, t, u.id);
    const raw = await h.db
      .selectFrom('raw_rows')
      .select(['external_ref', 'original', 'normalised', 'anonymised'])
      .where('upload_id', '=', u.id)
      .execute();
    expect(raw.length).toBe(300);
    expect(raw.every((r) => r.anonymised)).toBe(true);
    const stored = JSON.stringify(raw.map((r) => [r.original, r.normalised]));
    for (const v of originals) expect(stored.includes(v), v).toBe(false);

    // a second upload of the same people gives the same fakes (records' phone-based person dedup keeps working)
    const u2 = await uploadAndSplit(h, t, bytes);
    await processAll(h, t, u2.id);
    const again = await h.db
      .selectFrom('uploads')
      .select(['rows_unchanged', 'rows_accepted'])
      .where('id', '=', u2.id)
      .executeTakeFirst();
    expect(again?.rows_unchanged).toBe(300);
    expect(again?.rows_accepted).toBe(0);
  });
});
