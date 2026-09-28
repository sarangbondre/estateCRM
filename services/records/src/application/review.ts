// Review resolution (records LLD §4.16, G-R1): rows held unrouted are routed with the final classification; a
// record whose kind changes (side Supply ↔ Demand, or scope) is voided and re-created from its stored facts.
import { randomUUID } from 'node:crypto';
import type { EventDataMap } from '@11e/contracts/events';
import type { App } from './context.js';
import { createFromRow } from './ingest.js';
import type { IngestedRecordRow, PersonRow, VoidReason } from './model.js';
import type { IntakeRow, Tx } from './ports.js';
import { voidSubject } from './voiding.js';

type Resolution = EventDataMap['review_item.resolved.v1'];

function applyClassification(row: IntakeRow, data: Resolution): IntakeRow {
  return {
    ...row,
    needsReview: false,
    reviewReason: null,
    reviewReasonCode: null,
    ...(data.recordScope !== undefined ? { recordScope: data.recordScope } : {}),
    ...(data.side !== undefined ? { side: data.side } : {}),
    ...(data.dealTypes !== undefined ? { dealTypes: data.dealTypes } : {}),
    ...(data.market !== undefined ? { market: data.market } : {}),
    ...(data.segment !== undefined ? { segment: data.segment } : {}),
    ...(data.propertyTypes !== undefined ? { propertyTypes: data.propertyTypes } : {}),
  };
}

/** An unrouted row gets its side: the stored snapshot is routed now (the snapshot is purged 30 days later). */
export async function recreateFromSnapshot(app: App, tx: Tx, rec: IngestedRecordRow, data: Resolution): Promise<void> {
  const [held] = await tx.store.find('unrouted_rows', { external_source: rec.external_source, external_ref: rec.external_ref }, { limit: 1, lock: true });
  if (!held || held.status !== 'waiting') return;
  const row = applyClassification(held.row_snapshot as IntakeRow, data);
  await tx.store.delete('ingested_records', { id: rec.id });
  await createFromRow(app, tx, row, { uploadId: held.upload_id, batchNo: held.batch_no ?? 0 });
  await tx.store.update('unrouted_rows', held.id, { status: 'routed', routed_at: tx.now });
}

/** Rebuilds a row (without contacts) from the stored record and re-creates it under the new kind. */
export async function reclassify(
  app: App,
  tx: Tx,
  rec: IngestedRecordRow,
  data: Resolution,
  kind: string,
  reason: VoidReason,
): Promise<void> {
  const facts = await rowFromSubject(tx, rec);
  if (!facts) return;
  await voidSubject(tx, rec, reason);
  await tx.store.delete('ingested_records', { id: rec.id });
  if (kind === 'unrouted') return;
  const row = applyClassification(facts.row, data);
  await createFromRow(app, tx, row, { uploadId: rec.last_upload_id, batchNo: 0, person: facts.person });
}

async function rowFromSubject(tx: Tx, rec: IngestedRecordRow): Promise<{ row: IntakeRow; person: PersonRow | null } | null> {
  const base: IntakeRow = {
    rowId: randomUUID(),
    rowNo: 0,
    externalSource: rec.external_source,
    externalRef: rec.external_ref,
    parentExternalRef: rec.parent_external_ref,
    splitIndex: rec.split_index,
    contentHash: rec.content_hash,
    needsReview: false,
    recordScope: rec.record_scope,
    sourceChannel: rec.source_channel,
    sourceType: 'Channel',
    captureMode: 'uploaded',
    anonymised: false,
  };
  const personOf = async (id: string | null | undefined) => (id ? ((await tx.store.get('persons', id)) ?? null) : null);
  if (rec.primary_subject_type === 'offer' && rec.property_id) {
    const property = await tx.store.get('properties', rec.property_id);
    const offers = await tx.store.find('offers', { property_id: rec.property_id, status: 'active' }, { limit: 20 });
    if (!property) return null;
    const sale = offers.find((o) => o.deal_type === 'Sale' || o.deal_type === 'Pagdi');
    const lease = offers.find((o) => o.deal_type === 'Lease');
    const [party] = await tx.store.find('record_parties', { subject_type: 'property', subject_id: property.id }, { limit: 1 });
    return {
      person: await personOf(party?.person_id),
      row: {
        ...base,
        side: 'Supply',
        sourceType: offers[0]?.source_type ?? 'Channel',
        dealTypes: offers.map((o) => o.deal_type),
        market: sale?.market ?? null,
        segment: property.segment,
        propertyTypes: property.property_types,
        propertyDetail: property.property_detail,
        landUse: property.land_use,
        locality: property.locality,
        city: property.city,
        state: property.state,
        landmark: property.landmark,
        locationText: property.location_text,
        areaSqftMin: property.area_sqft_min,
        areaSqftMax: property.area_sqft_max,
        areaBasis: property.area_basis,
        bhkMin: property.bhk_min,
        bhkMax: property.bhk_max,
        features: property.features,
        salePriceInrMin: sale?.sale_price_inr_min ?? null,
        salePriceInrMax: sale?.sale_price_inr_max ?? null,
        rentMonthlyInrMin: lease?.rent_monthly_inr_min ?? null,
        rentMonthlyInrMax: lease?.rent_monthly_inr_max ?? null,
        depositInr: lease?.deposit_inr ?? null,
      },
    };
  }
  if (rec.primary_subject_type === 'demand' && rec.primary_subject_id) {
    const d = await tx.store.get('demands', rec.primary_subject_id);
    if (!d) return null;
    return {
      person: await personOf(d.person_id),
      row: {
        ...base,
        side: 'Demand',
        sourceType: d.source_type,
        dealTypes: d.deal_types,
        market: d.market,
        segment: d.segment,
        propertyTypes: d.property_types,
        locality: d.localities[0] ?? null,
        areaSqftMin: d.area_sqft_min,
        areaSqftMax: d.area_sqft_max,
        areaBasis: d.area_basis,
        bhkMin: d.bhk_min,
        bhkMax: d.bhk_max,
        salePriceInrMin: d.budget_inr_min,
        salePriceInrMax: d.budget_inr_max,
        rentMonthlyInrMin: d.rent_monthly_inr_min,
        rentMonthlyInrMax: d.rent_monthly_inr_max,
      },
    };
  }
  if (rec.primary_subject_type === 'desk_item' && rec.primary_subject_id) {
    const item = await tx.store.get('desk_items', rec.primary_subject_id);
    if (!item) return null;
    return {
      person: await personOf(item.person_id),
      row: {
        ...base,
        side: item.side as IntakeRow['side'] & string,
        dealTypes: item.deal_types,
        sector: item.sector,
        signalType: item.signal_type,
        includesProperty: item.includes_property,
        businessDescription: item.business_description,
        deadlineDate: item.deadline_date,
      },
    };
  }
  if (rec.primary_subject_type === 'person' && rec.primary_subject_id) {
    return { person: await personOf(rec.primary_subject_id), row: { ...base, side: 'None' } };
  }
  return null;
}
