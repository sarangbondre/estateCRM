// Intake stand-ins for ingestion tests: extractor rows (libs/testing synthetic data or hand-made) mapped to intake's
// IntakeRow (the strict-mode normalisation intake performs), and an in-memory IntakeRowsClient.
import { createHash, randomUUID } from 'node:crypto';
import type { ExtractorRow } from '@11e/testing';
import { BatchNotFoundError } from '../../src/application/ports.js';
import type { IntakeRow, IntakeRowBatch, IntakeRowsClient, MigrationMapEntry } from '../../src/application/ports.js';

const str = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
const list = (v: unknown) => (str(v) ? String(v).split('|').map((x) => x.trim()).filter(Boolean) : []);
const bool = (v: unknown) => (v === null || v === undefined ? null : v === true || v === 'true' || v === 'Yes');

export function toIntakeRow(r: Partial<ExtractorRow> & { record_id: string }, rowNo = 1): IntakeRow {
  const reason = str(r.review_reason);
  const sideRaw = str(r.side);
  const row: IntakeRow = {
    rowId: randomUUID(),
    rowNo,
    externalSource: 'extractor',
    externalRef: r.record_id,
    parentExternalRef: str(r.parent_record_id),
    splitIndex: str(r.split_index),
    contentHash: '',
    routeTo: str(r.route_to),
    needsReview: r.needs_review === true || sideRaw === null,
    reviewReason: reason,
    reviewReasonCode: reason?.includes('side defaulted') ? 'side_defaulted' : reason ? 'other' : sideRaw === null ? 'side_unclear' : null,
    recordScope: str(r.record_scope) ?? 'Property',
    dealTypes: list(r.deal_type),
    market: str(r.market),
    segment: str(r.segment),
    propertyTypes: list(r.property_type),
    propertyDetail: str(r.property_detail),
    landUse: str(r.land_use),
    side: sideRaw as 'Supply' | 'Demand' | 'None' | null,
    sideEvidence: str(r.side_evidence),
    saleMode: str(r.sale_mode),
    deadlineDate: str(r.deadline_date),
    tenancyStatus: str(r.tenancy_status),
    tenure: str(r.tenure),
    agreementForm: str(r.agreement_form),
    isJodi: bool(r.is_jodi),
    possessionStatus: str(r.possession_status),
    possessionDate: str(r.possession_date),
    furnishing: str(r.furnishing),
    sector: str(r.sector),
    includesProperty: str(r.includes_property),
    businessDescription: str(r.business_description),
    participantRole: str(r.participant_role),
    signalType: str(r.signal_type),
    projectName: str(r.project_name),
    developerName: str(r.developer_name),
    bhkMin: num(r.bhk_min),
    bhkMax: num(r.bhk_max),
    features: str(r.features),
    locality: str(r.locality),
    city: str(r.city),
    state: str(r.state),
    landmark: str(r.landmark),
    locationText: str(r.location_text),
    areaSqftMin: num(r.area_sqft_min),
    areaSqftMax: num(r.area_sqft_max),
    areaBasis: str(r.area_basis),
    landAreaValue: num(r.land_area_value),
    landAreaUnit: str(r.land_area_unit),
    landAreaSqft: num(r.land_area_sqft),
    areaText: str(r.area_text),
    priceText: str(r.price_text),
    salePriceInrMin: num(r.sale_price_inr_min),
    salePriceInrMax: num(r.sale_price_inr_max),
    saleRateInr: num(r.sale_rate_inr),
    saleRateUnit: str(r.sale_rate_unit),
    priceNegotiable: bool(r.price_negotiable),
    rentMonthlyInrMin: num(r.rent_monthly_inr_min),
    rentMonthlyInrMax: num(r.rent_monthly_inr_max),
    rentRatePsf: num(r.rent_rate_psf),
    depositInr: num(r.deposit_inr),
    depositMonths: num(r.deposit_months),
    currentRentInr: num(r.current_rent_inr),
    yieldPct: num(r.yield_pct),
    contactName: str(r.contact_name),
    companyName: str(r.company_name),
    partyType: str(r.party_type),
    phones: list(r.phones),
    whatsappPhone: str(r.whatsapp_phone),
    emails: list(r.emails),
    reraNumber: str(r.rera_number),
    otherContact: str(r.other_contact),
    sourceChannel: str(r.source_channel),
    sourceName: str(r.source_name),
    sourceEdition: str(r.source_edition),
    sourceSupplement: str(r.source_supplement),
    sourceDate: str(r.source_date),
    sourcePage: num(r.source_page),
    sourceFiles: str(r.source_files),
    firstSeenDate: str(r.first_seen_date),
    lastSeenDate: str(r.last_seen_date),
    timesSeen: num(r.times_seen),
    possibleRepeatOf: str(r.possible_repeat_of),
    rawText: str(r.raw_text),
    sourceLanguage: str(r.source_language),
    ocrUsed: bool(r.ocr_used),
    extractionConfidence: num(r.extraction_confidence),
    extractorNotes: str(r.extractor_notes),
    senderName: str(r.sender_name),
    senderPhone: str(r.sender_phone),
    textVariants: str(r.text_variants),
    crmNotes: str(r.crm_notes),
    sourceType: 'Channel',
    captureMode: 'uploaded',
    anonymised: false,
  };
  const { rowId: _r, rowNo: _n, contentHash: _h, ...facts } = row;
  void [_r, _n, _h];
  row.contentHash = createHash('sha256').update(JSON.stringify(facts)).digest('hex');
  return row;
}

/** In-memory intake: batches and migration maps per upload. */
export class FakeIntake implements IntakeRowsClient {
  readonly batches = new Map<string, IntakeRowBatch>();
  readonly maps = new Map<string, MigrationMapEntry[]>();
  calls = 0;

  add(uploadId: string, batchNo: number, rows: IntakeRow[]): void {
    this.batches.set(`${uploadId}:${batchNo}`, { uploadId, batchNo, anonymised: false, vocabularyVersion: 'v0.6', rows });
  }

  async batch(_t: string, uploadId: string, batchNo: number): Promise<IntakeRowBatch> {
    this.calls++;
    const b = this.batches.get(`${uploadId}:${batchNo}`);
    if (!b) throw new BatchNotFoundError(`batch ${batchNo} not found`);
    return b;
  }

  async migrationMap(_t: string, uploadId: string, cursor: string | null) {
    const all = this.maps.get(uploadId) ?? [];
    const start = cursor ? Number(cursor) : 0;
    const items = all.slice(start, start + 1000);
    return { items, nextCursor: start + 1000 < all.length ? String(start + 1000) : null };
  }
}

/** A minimal strict-mode supply row. */
export function supplyRow(over: Partial<ExtractorRow> & { record_id: string }): Partial<ExtractorRow> & { record_id: string } {
  return {
    record_scope: 'Property',
    side: 'Supply',
    deal_type: 'Sale',
    segment: 'Residential',
    property_type: 'Apartment',
    locality: 'Powai',
    city: 'Mumbai',
    bhk_min: 2,
    bhk_max: 2,
    area_sqft_min: 900,
    area_basis: 'Carpet',
    sale_price_inr_min: 20_000_000,
    contact_name: 'Seller Person',
    party_type: 'Owner',
    phones: '+919000100001',
    source_channel: 'Newspaper',
    source_name: 'Times of India',
    source_edition: 'Mumbai',
    source_date: '2026-09-01',
    first_seen_date: '2026-09-01',
    last_seen_date: '2026-09-01',
    times_seen: 1,
    raw_text: 'synthetic ad text',
    ...over,
  };
}
