// PdfRendererPort with @react-pdf/renderer (docs/06-implementation-rules.md §1.3). Renders only the snapshot, which
// was built from an allow-list (no contacts, unit or wing). Placeholder "11estates" wordmark (questionnaire A10).
import { Document, Image, Page, StyleSheet, Text, View, renderToBuffer } from '@react-pdf/renderer';
import { createElement as h } from 'react';
import type { ReactElement } from 'react';
import type { SnapshotOption } from '../domain/proposals.js';
import type { PdfInput, PdfRendererPort } from '../application/ports.js';

const styles = StyleSheet.create({
  page: { padding: 32, fontSize: 10, fontFamily: 'Helvetica', color: '#1f2933' },
  brand: { fontSize: 18, fontFamily: 'Helvetica-Bold', color: '#0b6e4f' },
  header: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16 },
  muted: { color: '#6b7280' },
  cover: { marginBottom: 14, lineHeight: 1.4 },
  option: { borderTop: '1pt solid #d1d5db', paddingTop: 10, marginTop: 10 },
  title: { fontSize: 12, fontFamily: 'Helvetica-Bold', marginBottom: 4 },
  row: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 2 },
  cell: { width: '50%', marginBottom: 2 },
  photos: { flexDirection: 'row', marginTop: 6 },
  photo: { width: 160, height: 110, marginRight: 8, objectFit: 'cover' },
  footer: { position: 'absolute', bottom: 20, left: 32, right: 32, fontSize: 8, color: '#6b7280' },
});

const inr = (v: number | null) =>
  v === null ? null : v >= 10_000_000 ? `Rs ${(v / 10_000_000).toFixed(2)} Cr` : v >= 100_000 ? `Rs ${(v / 100_000).toFixed(2)} L` : `Rs ${v}`;

function facts(o: SnapshotOption): [string, string][] {
  const out: [string, string][] = [];
  const add = (k: string, v: string | number | null | undefined) => {
    if (v !== null && v !== undefined && v !== '') out.push([k, String(v)]);
  };
  add('Building', o.buildingName);
  add('Location', [o.locality, o.micromarket].filter(Boolean).join(', '));
  add('Deal', o.dealType);
  add('Type', o.propertyTypes.join(', '));
  add('Carpet area', o.carpetAreaSqft ? `${o.carpetAreaSqft} sq ft` : null);
  add('Built-up area', o.builtupAreaSqft ? `${o.builtupAreaSqft} sq ft` : null);
  if (!o.carpetAreaSqft && !o.builtupAreaSqft) add('Area', o.areaSqftMin ? `${o.areaSqftMin}${o.areaSqftMax && o.areaSqftMax !== o.areaSqftMin ? `–${o.areaSqftMax}` : ''} sq ft` : null);
  add('Price', inr(o.salePriceInrMin));
  add('Rent / month', inr(o.rentMonthlyInrMin));
  add('Deposit', inr(o.depositInr));
  add('Available from', o.availableFrom);
  add('Furnishing', o.furnishing);
  add('Project RERA', o.projectRera);
  if (o.bundleOf) add('Bundle', `${o.bundleOf} units together`);
  return out;
}

function documentFor(input: PdfInput, withPhotos: boolean): ReactElement {
  const s = input.snapshot;
  const options = s.options.map((o) =>
    h(
      View,
      { key: String(o.position), style: styles.option, wrap: false },
      h(Text, { style: styles.title }, `${o.position}. ${o.title}`),
      h(
        View,
        { style: styles.row },
        ...facts(o).map(([k, v]) => h(Text, { key: k, style: styles.cell }, `${k}: ${v}`)),
      ),
      withPhotos && input.photoUrls[o.position]?.length
        ? h(
            View,
            { style: styles.photos },
            ...(input.photoUrls[o.position] ?? []).slice(0, 3).map((src) => h(Image, { key: src, src, style: styles.photo })),
          )
        : null,
    ),
  );
  return h(
    Document,
    { title: `Proposal ${input.code}`, author: '11estates' },
    h(
      Page,
      { size: 'A4', style: styles.page },
      h(
        View,
        { style: styles.header },
        h(Text, { style: styles.brand }, '11estates'),
        h(View, null, h(Text, null, `Proposal ${input.code}`), h(Text, { style: styles.muted }, input.generatedAt.toISOString().slice(0, 10))),
      ),
      s.preparedFor ? h(Text, { style: styles.muted }, `Prepared for: ${s.preparedFor}`) : null,
      s.coverNote ? h(Text, { style: styles.cover }, s.coverNote) : null,
      ...options,
      h(Text, { style: styles.footer, fixed: true }, `11 Estates · ${s.agentRera} · Details subject to confirmation`),
    ),
  );
}

export function createPdfRenderer(): PdfRendererPort {
  return {
    async render(input) {
      try {
        return new Uint8Array(await renderToBuffer(documentFor(input, true) as never));
      } catch {
        // A photo that cannot be fetched must not block the proposal: render without photos.
        return new Uint8Array(await renderToBuffer(documentFor(input, false) as never));
      }
    },
  };
}
