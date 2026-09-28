// Free-text parse for quick add (LLD §4.12, US-04 AC2, C-06): rules first (classification, BHK, area, price, contacts);
// only when scope, deal type or side are still unknown is the text REDACTED and sent to the model (one call, 2 s).
// Contacts found by rules go back to the caller (it is the caller's own text) and are never stored or logged.
import { detect, redact } from '@11e/redaction';
import { VOCABULARY_RELEASE_ID } from '@11e/vocabulary';
import type { Side } from '@11e/vocabulary';
import { phone as toE164 } from '../domain/cells.js';
import { classifyText } from '../domain/classify.js';
import { LOW_CONFIDENCE, mergeSuggestion, validateModelOutput } from '../domain/model-output.js';
import type { Classification } from '../domain/rows.js';
import type { App } from './context.js';
import { ModelUnavailableError } from './ports.js';

export interface ParseInput {
  text: string;
  sideHint?: Side | null | undefined;
  sourceType?: string | undefined;
}

export interface ParseOutput {
  classification: Omit<Classification, 'landUse'>;
  fields: Record<string, unknown>;
  contacts: { phones: string[]; emails: string[]; nameCandidate: string | null };
  confidence: number;
  needsReview: boolean;
  usedModel: boolean;
  modelUnavailable: boolean;
  vocabularyVersion: string;
}

const NO_SIDE = ['Market Participant', 'Market Signal'];
const complete = (c: Classification) =>
  c.recordScope !== null && (NO_SIDE.includes(c.recordScope) || (c.dealTypes.length > 0 && c.side !== null));

export async function parseFreeText(app: App, tenantId: string, input: ParseInput): Promise<ParseOutput> {
  const text = input.text;
  const r = classifyText(text);
  let c: Classification = {
    recordScope: r.recordScope,
    dealTypes: [...r.dealTypes],
    market: null,
    segment: r.segment,
    propertyTypes: [...r.propertyTypes],
    landUse: null,
    side: r.side ?? input.sideHint ?? null,
  };
  if (c.recordScope && NO_SIDE.includes(c.recordScope)) c.side = 'None';
  let confidence = complete(c) ? 0.8 : 0.4;
  let usedModel = false;
  let modelUnavailable = false;

  if (!complete(c)) {
    const redacted = redact(text);
    if (!redacted.uncertain) {
      try {
        const [out] = await app.model.classify([{ id: '1', text: redacted.text }]);
        if (out) {
          const s = validateModelOutput(out as Record<string, unknown>);
          const merged = s.confidence >= LOW_CONFIDENCE ? mergeSuggestion(c, s.classification) : undefined;
          if (merged) {
            c = merged;
            usedModel = true;
            confidence = s.confidence;
          }
        }
      } catch (err) {
        if (!(err instanceof ModelUnavailableError)) throw err;
        modelUnavailable = true;
      }
    }
  }

  const spans = detect(text, { kinds: ['PHONE', 'EMAIL', 'NAME'] });
  const phones = [
    ...new Set(
      spans
        .filter((d) => d.kind === 'PHONE')
        .map((d) => toE164(d.value))
        .filter((p): p is string => !!p),
    ),
  ];
  const emails = [
    ...new Set(spans.filter((d) => d.kind === 'EMAIL').map((d) => d.value.trim().toLowerCase())),
  ].filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  const nameCandidate = spans.find((d) => d.kind === 'NAME')?.value ?? null;

  const place =
    /\b(?:in|at|near)\s+([A-Z][A-Za-z]+(?:\s+(?:West|East|North|South|[A-Z][A-Za-z]+))?)/.exec(text)?.[1] ??
    null;
  const resolve = await app.localities.resolver(tenantId);
  const micromarket = place ? (resolve(place) ?? null) : null;
  const moveIn =
    /\b(immediate(?:ly)?|ready to move|from\s+\w+\s*\d{0,4}|by\s+\w+\s*\d{0,4})\b/i.exec(text)?.[0] ?? null;
  const company =
    /\b([A-Z][\w&]*(?:\s+[A-Z][\w&]*)*\s+(?:Realty|Realtors|Estates?|Properties|Associates|Developers|Builders|Consultants))\b/.exec(
      text,
    )?.[1] ?? null;
  const referrer =
    /\b(?:referred by|reference[:\s]+|ref[:\s]+)\s*([^,.;\n]{2,60})/i.exec(text)?.[1]?.trim() ?? null;
  const active = await app.uow.repos.vocabulary.active(tenantId);

  return {
    classification: {
      recordScope: c.recordScope,
      side: c.side,
      dealTypes: c.dealTypes,
      market: c.market,
      segment: c.segment,
      propertyTypes: c.propertyTypes,
    },
    fields: {
      bhkMin: r.bhkMin,
      bhkMax: r.bhkMax,
      areaSqftMin: r.areaSqftMin,
      areaSqftMax: r.areaSqftMax,
      areaBasis: /\bcarpet\b/i.test(text) ? 'Carpet' : /\bbuilt[\s-]?up\b/i.test(text) ? 'Builtup' : null,
      salePriceInrMin: r.salePriceInrMin,
      salePriceInrMax: r.salePriceInrMax,
      rentMonthlyInrMin: r.rentMonthlyInrMin,
      rentMonthlyInrMax: r.rentMonthlyInrMax,
      locality: micromarket ?? place,
      micromarketHint: micromarket,
      moveInText: moveIn,
      furnishing: r.furnishing,
      tenancyStatus: r.tenancyStatus,
      saleMode: r.saleMode,
      companyName: company,
      referrerText: referrer,
    },
    contacts: { phones, emails, nameCandidate },
    confidence,
    needsReview: !complete(c) || confidence < LOW_CONFIDENCE,
    usedModel,
    modelUnavailable,
    vocabularyVersion: active?.version ?? VOCABULARY_RELEASE_ID,
  };
}
