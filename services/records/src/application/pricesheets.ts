// Project price sheets (REC-07, US-17, records LLD §4.11): one transaction per sheet; lines update or create
// configuration offers (Sale, Primary); price_sheet.applied.v1 is the life-curve basis for Sale/Primary in journeys.
import { segmentOfPropertyType } from '@11e/vocabulary';
import type { PropertyType } from '@11e/vocabulary';
import { CODE_PADS } from '../domain/codes.js';
import { RecordsError } from '../domain/errors.js';
import { possessionDateStart } from '../domain/property.js';
import { assertRanges } from '../domain/vocabulary.js';
import type { Actor, App } from './context.js';
import { vocabularyOf } from './context.js';
import { agg, emitOffersCreated, emitOffersUpdated, emitPriceChanged, emitProject } from './emit.js';
import { changedColumns } from './fields.js';
import { mustFind } from './lookup.js';
import type { OfferRow, PriceSheetRow, PropertyRow } from './model.js';
import type { Tx } from './ports.js';
import { deriveProperty, emptyOffer, emptyProperty } from './supply.js';
import type { Dto } from './supply.js';

export interface PriceSheetLine {
  offerId?: string | null | undefined;
  propertyType: string;
  bhkMin?: number | null | undefined;
  bhkMax?: number | null | undefined;
  areaSqftMin?: number | null | undefined;
  areaSqftMax?: number | null | undefined;
  areaBasis?: 'Carpet' | 'Builtup' | 'Saleable' | null | undefined;
  salePriceInrMin?: number | null | undefined;
  salePriceInrMax?: number | null | undefined;
  unitCount?: number | null | undefined;
  possessionDate?: string | null | undefined;
}

export interface PriceSheetInput {
  sheetDate: string;
  receivedVia?: string | undefined;
  lines: PriceSheetLine[];
  missingConfigurations?: 'keep' | 'zero_units' | undefined;
}

interface Config {
  offer: OfferRow;
  property: PropertyRow;
}

/** Matches a line to a configuration by offerId, else by (property type, bhk range). */
export function matchLine(line: PriceSheetLine, configs: readonly Config[]): Config | undefined {
  if (line.offerId) return configs.find((c) => c.offer.id === line.offerId);
  return configs.find(
    (c) =>
      c.property.property_types.includes(line.propertyType) &&
      (c.property.bhk_min ?? null) === (line.bhkMin ?? null) &&
      (c.property.bhk_max ?? null) === (line.bhkMax ?? null),
  );
}

export async function addPriceSheet(app: App, actor: Actor, projectIdOrCode: string, input: PriceSheetInput): Promise<PriceSheetRow> {
  return app.uow.run(
    actor,
    async (tx) => {
      const project = await mustFind(tx, 'projects', projectIdOrCode, { lock: true });
      if (project.latest_price_sheet_date && input.sheetDate < project.latest_price_sheet_date) {
        throw new RecordsError('stale-price-sheet', `the latest applied sheet is dated ${project.latest_price_sheet_date}`);
      }
      const vocab = await vocabularyOf(app, tx);
      const errors: { field: string; code: string }[] = [];
      input.lines.forEach((l, i) => {
        const canonical = vocab?.canonical('property_type', l.propertyType);
        if (vocab && !canonical) errors.push({ field: `lines/${i}/propertyType`, code: 'value-not-in-list' });
        else if (canonical) l.propertyType = canonical;
        assertRanges([
          [`lines/${i}/bhk`, l.bhkMin, l.bhkMax],
          [`lines/${i}/areaSqft`, l.areaSqftMin, l.areaSqftMax],
          [`lines/${i}/salePriceInr`, l.salePriceInrMin, l.salePriceInrMax],
        ]);
      });
      if (errors.length) throw new RecordsError('vocabulary-value-invalid', undefined, { errors });

      const offers = await tx.store.find('offers', { project_id: project.id, status: 'active' }, { limit: 1000 });
      const properties = new Map((await tx.store.getMany('properties', offers.map((o) => o.property_id))).map((p) => [p.id, p]));
      const configs: Config[] = offers.flatMap((offer) => {
        const property = properties.get(offer.property_id);
        return property ? [{ offer, property }] : [];
      });
      const created: string[] = [];
      const updated: string[] = [];
      const priceChanged: string[] = [];
      const matched = new Set<string>();

      for (const [i, line] of input.lines.entries()) {
        const config = matchLine(line, configs);
        if (line.offerId && !config) {
          throw new RecordsError('validation-failed', 'offerId is not a configuration of this project', {
            errors: [{ field: `lines/${i}/offerId`, code: 'not-found' }],
          });
        }
        if (config) {
          matched.add(config.offer.id);
          if (await applyLine(tx, config, line)) updated.push(config.offer.id);
          if (await emitPriceChanged(tx, config.offer, 'price_sheet')) priceChanged.push(config.offer.id);
        } else {
          created.push(await createConfiguration(app, tx, project, line));
        }
      }
      if (input.missingConfigurations === 'zero_units') {
        for (const c of configs.filter((x) => !matched.has(x.offer.id) && x.offer.unit_count !== 0)) {
          await tx.store.update('offers', c.offer.id, { unit_count: 0 });
          updated.push(c.offer.id);
          if (await emitPriceChanged(tx, c.offer, 'price_sheet')) priceChanged.push(c.offer.id);
        }
      }

      const sheet: PriceSheetRow = {
        id: app.ids.next(),
        tenant_id: tx.tenantId,
        project_id: project.id,
        sheet_date: input.sheetDate,
        received_via: input.receivedVia ?? null,
        lines: input.lines,
        created_offers: created,
        updated_offers: [...new Set(updated)],
        price_changed_offers: [...new Set(priceChanged)],
        created_by: actor.userId,
        created_at: tx.now,
        updated_at: tx.now,
      };
      await tx.store.insert('price_sheets', sheet);
      const version = project.version + 1;
      await tx.store.update('projects', project.id, { latest_price_sheet_date: input.sheetDate, version });
      await tx.events.emit('price_sheet.applied.v1', agg('project', project.id, version), {
        projectId: project.id,
        priceSheetId: sheet.id,
        sheetDate: input.sheetDate,
        changedOfferIds: [...new Set([...created, ...updated])],
      });
      await tx.store.update('projects', project.id, { version: version + 1 });
      await emitProject(tx, 'project.updated.v1', project.id);
      await emitOffersCreated(tx, created);
      // Every configuration's facts carry the latest priceSheetDate.
      const all = (await tx.store.find('offers', { project_id: project.id, status: 'active' }, { limit: 1000 })).filter((o) => !created.includes(o.id));
      for (const o of all) await tx.store.update('offers', o.id, { version: o.version + 1 });
      await emitOffersUpdated(tx, all.map((o) => o.id));
      return sheet;
    },
    { timeoutMs: 10_000 },
  );
}

async function applyLine(tx: Tx, c: Config, line: PriceSheetLine): Promise<boolean> {
  const offerPatch: Partial<OfferRow> = {};
  if (line.salePriceInrMin !== undefined) offerPatch.sale_price_inr_min = line.salePriceInrMin;
  if (line.salePriceInrMax !== undefined) offerPatch.sale_price_inr_max = line.salePriceInrMax;
  if (line.unitCount !== undefined) offerPatch.unit_count = line.unitCount;
  if (line.possessionDate !== undefined) {
    offerPatch.possession_date = line.possessionDate;
    offerPatch.possession_date_start = possessionDateStart(line.possessionDate);
  }
  const propertyPatch: Partial<PropertyRow> = {};
  if (line.areaSqftMin !== undefined) propertyPatch.area_sqft_min = line.areaSqftMin;
  if (line.areaSqftMax !== undefined) propertyPatch.area_sqft_max = line.areaSqftMax;
  if (line.areaBasis !== undefined) propertyPatch.area_basis = line.areaBasis;
  const offerChanged = changedColumns(c.offer as unknown as Dto, offerPatch as Dto);
  const propertyChanged = changedColumns(c.property as unknown as Dto, propertyPatch as Dto);
  if (offerChanged.length) await tx.store.update('offers', c.offer.id, offerPatch);
  if (propertyChanged.length) await tx.store.update('properties', c.property.id, { ...propertyPatch, version: c.property.version + 1 });
  return offerChanged.length + propertyChanged.length > 0;
}

/** A configuration = a project property (one per configuration) + a Sale/Primary offer on it. */
async function createConfiguration(app: App, tx: Tx, project: { id: string; locality: string | null; city: string | null; state: string | null; micromarket_id: string | null; possession_date: string | null }, line: PriceSheetLine) {
  const base: PropertyRow = {
    ...emptyProperty(app, tx, await tx.codes.next('PRP', CODE_PADS.PRP)),
    segment: segmentOfPropertyType(line.propertyType as PropertyType) ?? null,
    property_types: [line.propertyType],
    locality: project.locality,
    city: project.city,
    state: project.state,
    micromarket_id: project.micromarket_id,
    bhk_min: line.bhkMin ?? null,
    bhk_max: line.bhkMax ?? null,
    area_sqft_min: line.areaSqftMin ?? null,
    area_sqft_max: line.areaSqftMax ?? null,
    area_basis: line.areaBasis ?? null,
    project_id: project.id,
  };
  const { row: property } = await deriveProperty(app, tx, base, { micromarketGiven: project.micromarket_id !== null });
  const possession = line.possessionDate ?? project.possession_date;
  const offer: OfferRow = {
    ...emptyOffer(app, tx, await tx.codes.next('INV', CODE_PADS.INV), property.id, 'Sale'),
    project_id: project.id,
    market: 'Primary',
    sale_price_inr_min: line.salePriceInrMin ?? null,
    sale_price_inr_max: line.salePriceInrMax ?? null,
    unit_count: line.unitCount ?? null,
    possession_date: possession,
    possession_date_start: possessionDateStart(possession),
    // A developer's sheet is automatic enrichment (R-10 reading: not a call with the owner).
    record_stage: 'Enriched',
    source_type: 'Direct',
    capture_mode: 'typed_in',
  };
  await tx.store.insert('properties', property);
  await tx.store.insert('offers', offer);
  return offer.id;
}
