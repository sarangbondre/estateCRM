// Read-side queries (application Queries port): keyset pagination on (sort column, id), one driving index per
// filter (records LLD §3), batched view loading (no N+1), every statement tenant-filtered.
import { sql } from 'kysely';
import type { Kysely, RawBuilder, SelectQueryBuilder, Transaction } from 'kysely';
import type {
  DemandRow,
  DeskItemRow,
  EnquiryRow,
  MarketDataRow,
  MergeCandidateRow,
  MergeRow,
  MicromarketRow,
  OfferRow,
  PersonPhoneRow,
  PersonRow,
  PhotoRow,
  PriceSheetRow,
  ProjectRow,
  PropertyRow,
  SecondSourceRow,
  SightingRow,
  SourceAdRow,
  TouchRow,
  VocabularyReleaseRow,
} from '../../application/model.js';
import type {
  After,
  CandidateFilter,
  DemandFilter,
  DemandView,
  DeskFilter,
  EnquiryFilter,
  MarketDataFilter,
  MicromarketRef,
  OfferFilter,
  OfferView,
  PageRequest,
  PartyView,
  PersonFilter,
  PersonView,
  ProjectFilter,
  ProjectView,
  PropertyCandidateData,
  PropertyCandidateQuery,
  PropertyFilter,
  PropertyView,
  Queries,
  SortKey,
  SourceAdFilter,
  SourceAdView,
} from '../../application/queries.js';
import { buildingNorm as normBuilding, norm } from '../../domain/text.js';
import { SCHEMA } from '../../config.js';
import type { RecordsDb } from './schema.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic joins/aliases on a loosely typed builder
type Q = SelectQueryBuilder<any, any, any>;
type Loose = Kysely<Record<string, Record<string, unknown>>>;

const LEVEL_DEPTH: Record<string, number> = { zone: 0, micromarket: 1, locality: 2, sub_locality: 3 };

const byIdOrder = <T extends { id: string }>(ids: readonly string[], rows: T[]): T[] => {
  const m = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => m.get(id)).filter((r): r is T => r !== undefined);
};

/** Keyset condition for `(col, id)` in the given direction; `cast` is the SQL type of the sort value. */
function keyset(q: Q, col: string, idCol: string, dir: 'asc' | 'desc', after: After | undefined, cast: string): Q {
  if (!after) return q;
  const op = sql.raw(dir === 'desc' ? '<' : '>');
  const k: RawBuilder<unknown> =
    after.k === null ? sql`null` : sql`cast(${after.k} as ${sql.raw(cast)})`;
  return q.where(sql<boolean>`(${sql.ref(col)}, ${sql.ref(idCol)}) ${op} (${k}, cast(${after.id} as uuid))`);
}

function order(q: Q, col: string, idCol: string, dir: 'asc' | 'desc'): Q {
  return q.orderBy(col, dir).orderBy(idCol, dir);
}

const sortOf = (sort: SortKey): { col: 'updated_at' | 'created_at'; dir: 'asc' | 'desc' } => ({
  col: sort.includes('created') ? 'created_at' : 'updated_at',
  dir: sort.startsWith('-') ? 'desc' : 'asc',
});

export class KyselyQueries implements Queries {
  readonly #db: Loose;
  readonly #t: string;

  constructor(trx: Transaction<RecordsDb> | Kysely<RecordsDb>, tenantId: string) {
    this.#db = trx as unknown as Loose;
    this.#t = tenantId;
  }

  #from(table: string, alias?: string): Q {
    const name = alias ? `${table} as ${alias}` : table;
    return (this.#db.selectFrom(name as never) as unknown as Q).where(`${alias ?? table}.tenant_id`, '=', this.#t);
  }

  async #in<T>(table: string, column: string, values: readonly unknown[], extra?: (q: Q) => Q): Promise<T[]> {
    const list = [...new Set(values)].filter((v) => v !== null && v !== undefined);
    if (!list.length) return [];
    let q = this.#from(table).selectAll().where(`${table}.${column}`, 'in', list);
    if (extra) q = extra(q);
    return (await q.limit(5000).execute()) as T[];
  }

  // --- views ---------------------------------------------------------------------------------------------------

  async micromarketRefs(ids: readonly string[]): Promise<MicromarketRef[]> {
    const rows = await this.#in<MicromarketRow>('micromarkets', 'id', ids);
    return byIdOrder(
      ids.filter((x, i) => ids.indexOf(x) === i),
      rows,
    ).map((m) => ({ id: m.id, name: m.name, level: m.level }));
  }

  async #personHeads(ids: readonly string[]) {
    const rows = await this.#in<PersonRow>('persons', 'id', ids);
    return new Map(rows.map((p) => [p.id, p]));
  }

  async offerViews(ids: readonly string[]): Promise<OfferView[]> {
    if (!ids.length) return [];
    const offers = byIdOrder(ids, await this.#in<OfferRow>('offers', 'id', ids));
    const propertyIds = offers.map((o) => o.property_id);
    const [properties, photos, parties, projects, demands, ingested] = await Promise.all([
      this.#in<PropertyRow>('properties', 'id', propertyIds),
      this.#in<{ offer_id: string; photo_id: string; sort: number }>('offer_photos', 'offer_id', ids, (q) =>
        q.orderBy('sort').orderBy('photo_id'),
      ),
      this.#in<{ subject_id: string; person_id: string }>('record_parties', 'subject_id', [...ids, ...propertyIds]),
      this.#in<ProjectRow>('projects', 'id', offers.map((o) => o.project_id)),
      this.#in<DemandRow>('demands', 'id', offers.map((o) => o.sourced_for_demand_id)),
      this.#in<{ id: string; external_ref: string }>('ingested_records', 'id', offers.map((o) => o.ingested_record_id)),
    ]);
    const props = new Map(properties.map((p) => [p.id, p]));
    const mms = new Map(
      (await this.micromarketRefs(properties.map((p) => p.micromarket_id).filter((x): x is string => !!x))).map((m) => [m.id, m]),
    );
    const projectMap = new Map(projects.map((p) => [p.id, p]));
    const demandCodes = new Map(demands.map((d) => [d.id, d.code]));
    const refs = new Map(ingested.map((i) => [i.id, i.external_ref]));
    return offers.flatMap((o) => {
      const property = props.get(o.property_id);
      if (!property) return [];
      const project = o.project_id ? projectMap.get(o.project_id) : undefined;
      const contact = [
        ...new Set(parties.filter((p) => p.subject_id === o.id || p.subject_id === o.property_id).map((p) => p.person_id)),
      ];
      return [
        {
          offer: o,
          property,
          micromarket: property.micromarket_id ? (mms.get(property.micromarket_id) ?? null) : null,
          photoIds: photos.filter((p) => p.offer_id === o.id).map((p) => p.photo_id),
          contactPersonIds: contact,
          project: project ? { code: project.code, latestPriceSheetDate: project.latest_price_sheet_date } : null,
          sourcedForDemandCode: o.sourced_for_demand_id ? (demandCodes.get(o.sourced_for_demand_id) ?? null) : null,
          externalRef: o.ingested_record_id ? (refs.get(o.ingested_record_id) ?? null) : null,
        },
      ];
    });
  }

  async propertyViews(ids: readonly string[]): Promise<PropertyView[]> {
    if (!ids.length) return [];
    const properties = byIdOrder(ids, await this.#in<PropertyRow>('properties', 'id', ids));
    const [offers, parties] = await Promise.all([
      this.#in<OfferRow>('offers', 'property_id', ids, (q) =>
        q.where('offers.status', '=', 'active').orderBy('offers.created_at').orderBy('offers.id'),
      ),
      this.#in<{ subject_type: string; subject_id: string; person_id: string; role: string; party_type_at_capture: string | null }>(
        'record_parties',
        'subject_id',
        ids,
        (q) => q.where('record_parties.subject_type', '=', 'property'),
      ),
    ]);
    const people = await this.#personHeads(parties.map((p) => p.person_id));
    const mms = new Map(
      (await this.micromarketRefs(properties.map((p) => p.micromarket_id).filter((x): x is string => !!x))).map((m) => [m.id, m]),
    );
    return properties.map((property) => ({
      property,
      micromarket: property.micromarket_id ? (mms.get(property.micromarket_id) ?? null) : null,
      offers: offers.filter((o) => o.property_id === property.id),
      parties: parties
        .filter((p) => p.subject_id === property.id)
        .flatMap((p): PartyView[] => {
          const person = people.get(p.person_id);
          if (!person) return [];
          return [
            {
              personId: person.id,
              personCode: person.code,
              initials: person.name_initials,
              role: p.role,
              partyType: p.party_type_at_capture ?? person.party_type,
            },
          ];
        }),
    }));
  }

  async demandViews(ids: readonly string[]): Promise<DemandView[]> {
    if (!ids.length) return [];
    const demands = byIdOrder(ids, await this.#in<DemandRow>('demands', 'id', ids));
    const parties = await this.#in<{ subject_id: string; person_id: string }>('record_parties', 'subject_id', ids, (q) =>
      q.where('record_parties.subject_type', '=', 'demand'),
    );
    const people = await this.#personHeads(demands.map((d) => d.person_id).filter((x): x is string => !!x));
    const mms = new Map((await this.micromarketRefs(demands.flatMap((d) => d.micromarket_ids))).map((m) => [m.id, m]));
    return demands.map((demand) => {
      const person = demand.person_id ? people.get(demand.person_id) : undefined;
      const contacts = new Set(parties.filter((p) => p.subject_id === demand.id).map((p) => p.person_id));
      if (demand.person_id) contacts.add(demand.person_id);
      return {
        demand,
        person: person ? { code: person.code, initials: person.name_initials } : null,
        micromarkets: demand.micromarket_ids.map((id) => mms.get(id)).filter((m): m is MicromarketRef => !!m),
        contactPersonIds: [...contacts],
      };
    });
  }

  async personViews(ids: readonly string[]): Promise<PersonView[]> {
    if (!ids.length) return [];
    const persons = byIdOrder(ids, await this.#in<PersonRow>('persons', 'id', ids));
    const [phones, emails, parties, demands, enquiries] = await Promise.all([
      this.#in<PersonPhoneRow>('person_phones', 'person_id', ids, (q) =>
        q.orderBy('person_phones.is_primary', 'desc').orderBy('person_phones.created_at'),
      ),
      this.#in<{ person_id: string }>('person_emails', 'person_id', ids),
      this.#in<{ person_id: string; subject_type: string; subject_id: string }>('record_parties', 'person_id', ids),
      this.#in<{ person_id: string; id: string }>('demands', 'person_id', ids, (q) => q.where('demands.status', '=', 'active')),
      this.#in<{ person_id: string }>('enquiries', 'person_id', ids),
    ]);
    return persons.map((person) => {
      const mine = parties.filter((p) => p.person_id === person.id);
      const demandIds = new Set([
        ...demands.filter((d) => d.person_id === person.id).map((d) => d.id),
        ...mine.filter((p) => p.subject_type === 'demand').map((p) => p.subject_id),
      ]);
      return {
        person,
        phones: phones.filter((p) => p.person_id === person.id),
        hasEmail: emails.some((e) => e.person_id === person.id),
        linked: {
          offers: new Set(mine.filter((p) => p.subject_type === 'offer' || p.subject_type === 'property').map((p) => p.subject_id)).size,
          demands: demandIds.size,
          enquiries: enquiries.filter((e) => e.person_id === person.id).length,
        },
      };
    });
  }

  async projectViews(ids: readonly string[]): Promise<ProjectView[]> {
    if (!ids.length) return [];
    const projects = byIdOrder(ids, await this.#in<ProjectRow>('projects', 'id', ids));
    const configs = await this.#in<OfferRow>('offers', 'project_id', ids, (q) =>
      q.where('offers.status', '=', 'active').orderBy('offers.created_at').orderBy('offers.id'),
    );
    const views = await this.offerViews(configs.map((c) => c.id));
    const mms = new Map(
      (await this.micromarketRefs(projects.map((p) => p.micromarket_id).filter((x): x is string => !!x))).map((m) => [m.id, m]),
    );
    return projects.map((project) => ({
      project,
      micromarket: project.micromarket_id ? (mms.get(project.micromarket_id) ?? null) : null,
      configurations: views.filter((v) => v.offer.project_id === project.id),
    }));
  }

  async sourceAdViews(ids: readonly string[]): Promise<SourceAdView[]> {
    if (!ids.length) return [];
    const ads = byIdOrder(ids, await this.#in<SourceAdRow>('source_ads', 'id', ids));
    const children = await this.#in<{
      source_ad_id: string;
      external_ref: string;
      split_index: string | null;
      primary_subject_type: string | null;
      primary_subject_id: string | null;
    }>('ingested_records', 'source_ad_id', ids, (q) => q.orderBy('ingested_records.split_index').orderBy('ingested_records.id'));
    const byType = (t: string) => children.filter((c) => c.primary_subject_type === t).map((c) => c.primary_subject_id);
    const [offers, demands, desks, persons] = await Promise.all([
      this.#in<{ id: string; code: string }>('offers', 'id', byType('offer')),
      this.#in<{ id: string; code: string }>('demands', 'id', byType('demand')),
      this.#in<{ id: string; code: string }>('desk_items', 'id', byType('desk_item')),
      this.#in<{ id: string; code: string }>('persons', 'id', byType('person')),
    ]);
    const codes = new Map([...offers, ...demands, ...desks, ...persons].map((r) => [r.id, r.code]));
    return ads.map((ad) => ({
      ad,
      children: children
        .filter((c) => c.source_ad_id === ad.id)
        .slice(0, 100)
        .map((c) => ({
          externalRef: c.external_ref,
          splitIndex: c.split_index,
          subjectType: c.primary_subject_type ?? 'unrouted',
          subjectId: c.primary_subject_id,
          code: c.primary_subject_id ? (codes.get(c.primary_subject_id) ?? null) : null,
        })),
    }));
  }

  // --- lists ---------------------------------------------------------------------------------------------------

  async listOffers(f: OfferFilter, sort: SortKey, page: PageRequest): Promise<OfferRow[]> {
    const { col, dir } = sortOf(sort);
    const joinProperty =
      f.segment !== undefined ||
      f.propertyType !== undefined ||
      f.micromarketIds !== undefined ||
      f.locality !== undefined ||
      f.city !== undefined ||
      f.outsideLaunchArea !== undefined ||
      f.bhkMin !== undefined ||
      f.bhkMax !== undefined ||
      f.areaSqftMin !== undefined ||
      f.areaSqftMax !== undefined;
    const propertyFilters = (pq: Q, p: string): Q => {
      let x = pq.where(`${p}.tenant_id`, '=', this.#t);
      if (f.segment !== undefined) x = x.where(`${p}.segment`, '=', f.segment);
      if (f.propertyType !== undefined) x = x.where(sql<boolean>`${sql.ref(`${p}.property_types`)} @> array[${f.propertyType}]::text[]`);
      if (f.micromarketIds !== undefined) x = x.where(`${p}.micromarket_id`, 'in', f.micromarketIds.length ? f.micromarketIds : [null]);
      if (f.locality !== undefined) x = x.where(`${p}.locality_norm`, '=', norm(f.locality));
      if (f.city !== undefined) x = x.where(`${p}.city_norm`, '=', norm(f.city));
      if (f.outsideLaunchArea !== undefined) x = x.where(`${p}.outside_launch_area`, '=', f.outsideLaunchArea);
      if (f.bhkMin !== undefined) x = x.where(sql<boolean>`coalesce(${sql.ref(`${p}.bhk_max`)}, ${sql.ref(`${p}.bhk_min`)}) >= ${f.bhkMin}`);
      if (f.bhkMax !== undefined) x = x.where(sql<boolean>`coalesce(${sql.ref(`${p}.bhk_min`)}, ${sql.ref(`${p}.bhk_max`)}) <= ${f.bhkMax}`);
      if (f.areaSqftMin !== undefined) x = x.where(sql<boolean>`coalesce(${sql.ref(`${p}.area_sqft_max`)}, ${sql.ref(`${p}.area_sqft_min`)}) >= ${f.areaSqftMin}`);
      if (f.areaSqftMax !== undefined) x = x.where(sql<boolean>`coalesce(${sql.ref(`${p}.area_sqft_min`)}, ${sql.ref(`${p}.area_sqft_max`)}) <= ${f.areaSqftMax}`);
      return x;
    };
    let q: Q;
    if (f.micromarketIds !== undefined || f.locality !== undefined) {
      // A location filter is selective: drive from the matching properties (LLD §3.5 "driving index"), materialised
      // so the plan does not depend on per-tenant statistics.
      q = (this.#db
        .with((wb) => wb('p').materialized(), (db) => propertyFilters((db.selectFrom('properties' as never) as unknown as Q).select('properties.id'), 'properties'))
        .selectFrom('offers' as never) as unknown as Q)
        .innerJoin('p', 'p.id', 'offers.property_id')
        .selectAll('offers')
        .where('offers.tenant_id', '=', this.#t);
    } else {
      q = this.#from('offers').selectAll('offers');
      if (joinProperty) q = propertyFilters(q.innerJoin('properties', 'properties.id', 'offers.property_id'), 'properties');
    }
    q = f.code !== undefined ? q.where('offers.code', '=', f.code).where('offers.status', '!=', 'voided') : q.where('offers.status', '=', 'active');
    const eq: [keyof OfferFilter, string][] = [
      ['dealType', 'deal_type'],
      ['market', 'market'],
      ['sourceType', 'source_type'],
      ['ownerUserId', 'owner_user_id'],
      ['recordStage', 'record_stage'],
      ['publicationLevel', 'publication_level'],
      ['tenancyStatus', 'tenancy_status'],
      ['saleMode', 'sale_mode'],
      ['furnishing', 'furnishing'],
      ['possessionStatus', 'possession_status'],
      ['propertyId', 'property_id'],
      ['projectId', 'project_id'],
      ['sourcedForDemandId', 'sourced_for_demand_id'],
      ['needsReview', 'needs_review'],
      ['hasPriceGap', 'has_price_gap'],
    ];
    for (const [k, c] of eq) if (f[k] !== undefined) q = q.where(`offers.${c}`, '=', f[k]);
    if (f.priceInrMin !== undefined || f.priceInrMax !== undefined) {
      const price =
        f.dealType === 'Lease'
          ? sql`offers.rent_monthly_inr_min`
          : f.dealType !== undefined
            ? sql`offers.sale_price_inr_min`
            : sql`coalesce(offers.sale_price_inr_min, offers.rent_monthly_inr_min)`;
      if (f.priceInrMin !== undefined) q = q.where(sql<boolean>`${price} >= ${f.priceInrMin}`);
      if (f.priceInrMax !== undefined) q = q.where(sql<boolean>`${price} <= ${f.priceInrMax}`);
    }
    if (f.updatedSince !== undefined) q = q.where('offers.updated_at', '>=', f.updatedSince);
    q = keyset(q, `offers.${col}`, 'offers.id', dir, page.after, 'timestamptz');
    return (await order(q, `offers.${col}`, 'offers.id', dir).limit(page.limit).execute()) as OfferRow[];
  }

  async listProperties(f: PropertyFilter, page: PageRequest): Promise<PropertyRow[]> {
    let q = this.#from('properties').selectAll();
    q = f.code !== undefined ? q.where('code', '=', f.code) : q.where('status', '=', 'active');
    if (f.segment !== undefined) q = q.where('segment', '=', f.segment);
    if (f.propertyType !== undefined) q = q.where(sql<boolean>`property_types @> array[${f.propertyType}]::text[]`);
    if (f.micromarketIds !== undefined) q = q.where('micromarket_id', 'in', f.micromarketIds.length ? f.micromarketIds : [null]);
    if (f.locality !== undefined) q = q.where('locality_norm', '=', norm(f.locality));
    if (f.city !== undefined) q = q.where('city_norm', '=', norm(f.city));
    if (f.outsideLaunchArea !== undefined) q = q.where('outside_launch_area', '=', f.outsideLaunchArea);
    if (f.buildingName !== undefined) {
      const b = normBuilding(f.buildingName) ?? norm(f.buildingName) ?? '';
      q = q.where('building_norm', 'like', `${b.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    }
    if (f.projectId !== undefined) q = q.where('project_id', '=', f.projectId);
    if (f.updatedSince !== undefined) q = q.where('updated_at', '>=', f.updatedSince);
    q = keyset(q, 'updated_at', 'id', 'desc', page.after, 'timestamptz');
    return (await order(q, 'updated_at', 'id', 'desc').limit(page.limit).execute()) as PropertyRow[];
  }

  async listProjects(f: ProjectFilter, page: PageRequest): Promise<ProjectRow[]> {
    let q = this.#from('projects').selectAll();
    if (f.code !== undefined) q = q.where('code', '=', f.code);
    if (f.micromarketIds !== undefined) q = q.where('micromarket_id', 'in', f.micromarketIds.length ? f.micromarketIds : [null]);
    if (f.locality !== undefined) q = q.where('locality_norm', '=', norm(f.locality));
    if (f.city !== undefined) q = q.where('city_norm', '=', norm(f.city));
    if (f.outsideLaunchArea !== undefined) q = q.where('outside_launch_area', '=', f.outsideLaunchArea);
    if (f.developerPersonId !== undefined) q = q.where('developer_person_id', '=', f.developerPersonId);
    if (f.hasRera !== undefined) q = q.where(sql<boolean>`(rera_number is not null) = ${f.hasRera}`);
    if (f.updatedSince !== undefined) q = q.where('updated_at', '>=', f.updatedSince);
    q = keyset(q, 'updated_at', 'id', 'desc', page.after, 'timestamptz');
    return (await order(q, 'updated_at', 'id', 'desc').limit(page.limit).execute()) as ProjectRow[];
  }

  async listDemands(f: DemandFilter, sort: SortKey, page: PageRequest): Promise<DemandRow[]> {
    const { col, dir } = sortOf(sort);
    let q = this.#from('demands').selectAll();
    q = f.code !== undefined ? q.where('code', '=', f.code).where('status', '!=', 'voided') : q.where('status', '=', 'active');
    if (f.dealType !== undefined) q = q.where(sql<boolean>`deal_types @> array[${f.dealType}]::text[]`);
    if (f.propertyType !== undefined) q = q.where(sql<boolean>`property_types @> array[${f.propertyType}]::text[]`);
    if (f.micromarketIds !== undefined) q = q.where(sql<boolean>`micromarket_ids && ${f.micromarketIds}::uuid[]`);
    if (f.locality !== undefined) q = q.where(sql<boolean>`localities @> array[${f.locality}]::text[]`);
    const eq: [keyof DemandFilter, string][] = [
      ['market', 'market'],
      ['segment', 'segment'],
      ['outsideLaunchArea', 'outside_launch_area'],
      ['sourceType', 'source_type'],
      ['ownerUserId', 'owner_user_id'],
      ['needsReview', 'needs_review'],
      ['recordStage', 'record_stage'],
      ['personId', 'person_id'],
    ];
    for (const [k, c] of eq) if (f[k] !== undefined) q = q.where(c, '=', f[k]);
    if (f.budgetInrMin !== undefined) q = q.where(sql<boolean>`coalesce(budget_inr_max, budget_inr_min) >= ${f.budgetInrMin}`);
    if (f.budgetInrMax !== undefined) q = q.where(sql<boolean>`coalesce(budget_inr_min, budget_inr_max) <= ${f.budgetInrMax}`);
    if (f.areaSqftMin !== undefined) q = q.where(sql<boolean>`coalesce(area_sqft_max, area_sqft_min) >= ${f.areaSqftMin}`);
    if (f.areaSqftMax !== undefined) q = q.where(sql<boolean>`coalesce(area_sqft_min, area_sqft_max) <= ${f.areaSqftMax}`);
    if (f.updatedSince !== undefined) q = q.where('updated_at', '>=', f.updatedSince);
    q = keyset(q, col, 'id', dir, page.after, 'timestamptz');
    return (await order(q, col, 'id', dir).limit(page.limit).execute()) as DemandRow[];
  }

  async listPeople(f: PersonFilter, page: PageRequest): Promise<PersonRow[]> {
    let q = this.#from('persons').selectAll();
    q = f.code !== undefined ? q.where('code', '=', f.code) : q.where('status', '=', 'active');
    if (f.partyType !== undefined) q = q.where('party_type', '=', f.partyType);
    if (f.participantRole !== undefined) q = q.where('participant_role', '=', f.participantRole);
    if (f.flag !== undefined) q = q.where(sql<boolean>`flags @> array[${f.flag}]::text[]`);
    if (f.companyName !== undefined) {
      const c = norm(f.companyName) ?? '';
      q = q.where('company_norm', 'like', `${c.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    }
    q = keyset(q, 'updated_at', 'id', 'desc', page.after, 'timestamptz');
    return (await order(q, 'updated_at', 'id', 'desc').limit(page.limit).execute()) as PersonRow[];
  }

  async listTouches(demandId: string, page: PageRequest): Promise<TouchRow[]> {
    let q = this.#from('touches').selectAll().where('demand_id', '=', demandId);
    q = keyset(q, 'occurred_at', 'id', 'asc', page.after, 'timestamptz');
    return (await order(q, 'occurred_at', 'id', 'asc').limit(page.limit).execute()) as TouchRow[];
  }

  async listEnquiries(f: EnquiryFilter, page: PageRequest): Promise<EnquiryRow[]> {
    let q = this.#from('enquiries').selectAll();
    if (f.offerId !== undefined) q = q.where('offer_id', '=', f.offerId);
    if (f.projectId !== undefined) q = q.where('project_id', '=', f.projectId);
    if (f.demandId !== undefined) q = q.where('demand_id', '=', f.demandId);
    if (f.campaignRef !== undefined) q = q.where('campaign_ref', '=', f.campaignRef);
    if (f.receivedSince !== undefined) q = q.where('received_at', '>=', f.receivedSince);
    q = keyset(q, 'received_at', 'id', 'desc', page.after, 'timestamptz');
    return (await order(q, 'received_at', 'id', 'desc').limit(page.limit).execute()) as EnquiryRow[];
  }

  async listSourceAds(f: SourceAdFilter, page: PageRequest): Promise<SourceAdRow[]> {
    let q = this.#from('source_ads').selectAll();
    if (f.externalRef !== undefined) q = q.where('external_ref', '=', f.externalRef);
    if (f.hasSplits !== undefined) q = q.where(sql<boolean>`(split_count > 1) = ${f.hasSplits}`);
    if (f.sourceName !== undefined) {
      q = q.where('source_name', '=', f.sourceName);
      if (f.sourceDate !== undefined) q = q.where('source_date', '=', f.sourceDate);
      q = keyset(q, 'source_date', 'id', 'desc', page.after, 'date');
      return (await order(q, 'source_date', 'id', 'desc').limit(page.limit).execute()) as SourceAdRow[];
    }
    if (f.sourceDate !== undefined) q = q.where('source_date', '=', f.sourceDate);
    q = keyset(q, 'created_at', 'id', 'desc', page.after, 'timestamptz');
    return (await order(q, 'created_at', 'id', 'desc').limit(page.limit).execute()) as SourceAdRow[];
  }

  async listSightings(subjects: readonly { type: string; id: string }[], page: PageRequest): Promise<SightingRow[]> {
    if (!subjects.length) return [];
    let q = this.#from('sightings').selectAll();
    q = q.where((eb) => eb.or(subjects.map((s) => eb.and([eb('subject_type', '=', s.type), eb('subject_id', '=', s.id)]))));
    q = keyset(q, 'seen_on', 'id', 'desc', page.after, 'date');
    return (await order(q, 'seen_on', 'id', 'desc').limit(page.limit).execute()) as SightingRow[];
  }

  async listSecondSources(
    f: { propertyId?: string | undefined; status?: string | undefined; priceGap?: boolean | undefined },
    page: PageRequest,
  ): Promise<SecondSourceRow[]> {
    let q = this.#from('second_sources').selectAll();
    if (f.propertyId !== undefined) {
      q = q.where('property_id', '=', f.propertyId);
      if (f.status !== undefined) q = q.where('status', '=', f.status);
      if (f.priceGap !== undefined) q = q.where('price_gap', '=', f.priceGap);
      q = keyset(q, 'seen_on', 'id', 'desc', page.after, 'date');
      return (await order(q, 'seen_on', 'id', 'desc').limit(page.limit).execute()) as SecondSourceRow[];
    }
    // Price-gap review queue: open gaps oldest first.
    q = q.where('status', '=', f.status ?? 'open').where('price_gap', '=', f.priceGap ?? true);
    q = keyset(q, 'seen_on', 'id', 'asc', page.after, 'date');
    return (await order(q, 'seen_on', 'id', 'asc').limit(page.limit).execute()) as SecondSourceRow[];
  }

  async listPhotos(propertyId: string, page: PageRequest): Promise<PhotoRow[]> {
    let q = this.#from('photos').selectAll().where('property_id', '=', propertyId);
    q = keyset(q, 'created_at', 'id', 'asc', page.after, 'timestamptz');
    return (await order(q, 'created_at', 'id', 'asc').limit(page.limit).execute()) as PhotoRow[];
  }

  async listPriceSheets(projectId: string, page: PageRequest): Promise<PriceSheetRow[]> {
    let q = this.#from('price_sheets').selectAll().where('project_id', '=', projectId);
    q = keyset(q, 'sheet_date', 'id', 'desc', page.after, 'date');
    return (await order(q, 'sheet_date', 'id', 'desc').limit(page.limit).execute()) as PriceSheetRow[];
  }

  async listCandidates(f: CandidateFilter, page: PageRequest): Promise<MergeCandidateRow[]> {
    let q = this.#from('merge_candidates').selectAll();
    if (f.uploadId !== undefined) q = q.where('upload_id', '=', f.uploadId);
    q = q.where('status', '=', f.status ?? 'open');
    if (f.aggregateType !== undefined) q = q.where('aggregate_type', '=', f.aggregateType);
    if (f.reason !== undefined) q = q.where('reason', '=', f.reason);
    q = keyset(q, 'score', 'id', 'desc', page.after, 'numeric');
    return (await order(q, 'score', 'id', 'desc').limit(page.limit).execute()) as MergeCandidateRow[];
  }

  async listDesk(desk: string, f: DeskFilter, page: PageRequest): Promise<DeskItemRow[]> {
    let q = this.#from('desk_items').selectAll().where('desk', '=', desk).where('status', '=', 'active');
    q = q.where(sql<boolean>`(archived_at is not null) = ${f.archived ?? false}`);
    if (f.assigneeUserId !== undefined) q = q.where('assignee_user_id', '=', f.assigneeUserId);
    if (f.sector !== undefined) q = q.where('sector', '=', f.sector);
    if (f.dealType !== undefined) q = q.where(sql<boolean>`deal_types @> array[${f.dealType}]::text[]`);
    if (f.side !== undefined) q = q.where('side', '=', f.side);
    if (desk === 'watchlist') {
      if (f.deadlineWithinDays !== undefined && f.today !== undefined) {
        q = q.where(sql<boolean>`deadline_date <= cast(${f.today} as date) + ${f.deadlineWithinDays}::int`);
      }
      // Deadline ascending (≤ 14 days first), undated items last.
      const key = `coalesce(deadline_date, date '9999-12-31')`;
      if (page.after) {
        q = q.where(sql<boolean>`(${sql.raw(key)}, id) > (cast(${page.after.k} as date), cast(${page.after.id} as uuid))`);
      }
      return (await q.orderBy(sql.raw(key), 'asc').orderBy('id', 'asc').limit(page.limit).execute()) as DeskItemRow[];
    }
    q = keyset(q, 'created_at', 'id', 'desc', page.after, 'timestamptz');
    return (await order(q, 'created_at', 'id', 'desc').limit(page.limit).execute()) as DeskItemRow[];
  }

  async listNetwork(f: DeskFilter, page: PageRequest): Promise<PersonRow[]> {
    let q = this.#from('persons').selectAll().where('status', '=', 'active').where('participant_role', 'is not', null);
    void f;
    q = keyset(q, 'updated_at', 'id', 'desc', page.after, 'timestamptz');
    return (await order(q, 'updated_at', 'id', 'desc').limit(page.limit).execute()) as PersonRow[];
  }

  async listMicromarkets(
    f: { parentId?: string | undefined; level?: string | undefined; q?: string | undefined },
    page: PageRequest,
  ): Promise<MicromarketRow[]> {
    let q = this.#from('micromarkets').selectAll();
    if (f.parentId !== undefined) {
      q = q.where('parent_id', '=', f.parentId);
    }
    if (f.level !== undefined) q = q.where('level', '=', f.level);
    if (f.q !== undefined) {
      const n = norm(f.q) ?? '';
      q = q.where('name_norm', 'like', `${n.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    }
    q = keyset(q, 'name_norm', 'id', 'asc', page.after, 'text');
    return (await order(q, 'name_norm', 'id', 'asc').limit(page.limit).execute()) as MicromarketRow[];
  }

  async listVocabularyReleases(page: PageRequest): Promise<VocabularyReleaseRow[]> {
    let q = this.#from('vocabulary_releases').selectAll().where('status', '!=', 'pending');
    q = keyset(q, 'activated_at', 'id', 'desc', page.after, 'timestamptz');
    return (await order(q, 'activated_at', 'id', 'desc').limit(page.limit).execute()) as VocabularyReleaseRow[];
  }

  async listMarketData(f: MarketDataFilter, page: PageRequest): Promise<MarketDataRow[]> {
    let q = this.#from('market_data_points').selectAll();
    if (f.micromarketIds !== undefined) q = q.where('micromarket_id', 'in', f.micromarketIds.length ? f.micromarketIds : [null]);
    if (f.dealType !== undefined) q = q.where('deal_type', '=', f.dealType);
    if (f.segment !== undefined) q = q.where('segment', '=', f.segment);
    if (f.source !== undefined) q = q.where('source', '=', f.source);
    if (f.observedFrom !== undefined) q = q.where('observed_on', '>=', f.observedFrom);
    if (f.observedTo !== undefined) q = q.where('observed_on', '<=', f.observedTo);
    if (!f.includeVoided) q = q.where('voided_at', 'is', null);
    q = keyset(q, 'observed_on', 'id', 'desc', page.after, 'date');
    return (await order(q, 'observed_on', 'id', 'desc').limit(page.limit).execute()) as MarketDataRow[];
  }

  // --- dedup and reference lookups -------------------------------------------------------------------------------

  async propertyCandidates(c: PropertyCandidateQuery): Promise<PropertyCandidateData[]> {
    const place = (q: Q): Q =>
      c.micromarketId !== null
        ? q.where('micromarket_id', '=', c.micromarketId)
        : c.localityNorm !== null
          ? q.where('micromarket_id', 'is', null).where('locality_norm', '=', c.localityNorm)
          : q.where(sql<boolean>`false`);
    const found: PropertyRow[] = [];
    if (c.buildingNorm !== null) {
      found.push(
        ...((await place(this.#from('properties').selectAll())
          .where('status', '=', 'active')
          .where('building_norm', '=', c.buildingNorm)
          .limit(50)
          .execute()) as PropertyRow[]),
      );
    }
    const lo = c.areaSqftMin ?? c.areaSqftMax;
    const hi = c.areaSqftMax ?? c.areaSqftMin;
    if (lo !== null && hi !== null) {
      found.push(
        ...((await place(this.#from('properties').selectAll())
          .where('status', '=', 'active')
          .where('segment', c.segment === null ? 'is' : '=', c.segment)
          .where('area_sqft_min', '>=', Math.floor(lo * 0.85))
          .where('area_sqft_min', '<=', Math.ceil(hi * 1.15))
          .limit(50)
          .execute()) as PropertyRow[]),
      );
    }
    const exclude = new Set(c.excludeIds ?? []);
    const unique = [...new Map(found.filter((p) => !exclude.has(p.id)).map((p) => [p.id, p])).values()];
    if (!unique.length) return [];
    const ids = unique.map((p) => p.id);
    const [offers, parties, lineage] = await Promise.all([
      this.#in<OfferRow>('offers', 'property_id', ids, (q) => q.where('offers.status', '=', 'active')),
      this.#in<{ subject_id: string; person_id: string }>('record_parties', 'subject_id', ids),
      this.#in<{ property_id: string; external_source: string; parent_external_ref: string | null; source_channel: string | null }>(
        'ingested_records',
        'property_id',
        ids,
      ),
    ]);
    const phones = await this.#in<PersonPhoneRow>('person_phones', 'person_id', parties.map((p) => p.person_id));
    return unique.map((property) => {
      const people = new Set(parties.filter((p) => p.subject_id === property.id).map((p) => p.person_id));
      return {
        property,
        offers: offers.filter((o) => o.property_id === property.id),
        phoneHashes: [...new Set(phones.filter((p) => people.has(p.person_id)).map((p) => p.phone_hash))],
        lineage: lineage
          .filter((l) => l.property_id === property.id)
          .map((l) => ({ externalSource: l.external_source, parentExternalRef: l.parent_external_ref, sourceChannel: l.source_channel })),
      };
    });
  }

  async personsByPhoneHashes(hashes: readonly string[]): Promise<{ person: PersonRow; phoneHash: string }[]> {
    if (!hashes.length) return [];
    const rows = (await this.#from('person_phones', 'ph')
      .innerJoin('persons as p', 'p.id', 'ph.person_id')
      .where('p.tenant_id', '=', this.#t)
      .where('ph.phone_hash', 'in', [...new Set(hashes)])
      .where('p.status', '=', 'active')
      .selectAll('p')
      .select('ph.phone_hash as matched_hash')
      .orderBy('p.last_activity_at', 'desc')
      .orderBy('p.id')
      .limit(50)
      .execute()) as (PersonRow & { matched_hash: string })[];
    return rows.map(({ matched_hash, ...person }) => ({ person: person as PersonRow, phoneHash: matched_hash }));
  }

  async personsByEmailHashes(hashes: readonly string[]): Promise<{ person: PersonRow; emailHash: string }[]> {
    if (!hashes.length) return [];
    const rows = (await this.#from('person_emails', 'em')
      .innerJoin('persons as p', 'p.id', 'em.person_id')
      .where('p.tenant_id', '=', this.#t)
      .where('em.email_hash', 'in', [...new Set(hashes)])
      .where('p.status', '=', 'active')
      .selectAll('p')
      .select('em.email_hash as matched_hash')
      .orderBy('p.last_activity_at', 'desc')
      .orderBy('p.id')
      .limit(50)
      .execute()) as (PersonRow & { matched_hash: string })[];
    return rows.map(({ matched_hash, ...person }) => ({ person: person as PersonRow, emailHash: matched_hash }));
  }

  async demandCandidates(c: { personId: string | null; companyNorm: string | null; since: Date; excludeId?: string }): Promise<DemandRow[]> {
    const base = () =>
      this.#from('demands')
        .selectAll()
        .where('status', '=', 'active')
        .where('closed_at', 'is', null)
        .where(sql<boolean>`(exit_state is null or exit_state = 'Dormant')`)
        .where('created_at', '>=', c.since);
    const out: DemandRow[] = [];
    if (c.personId) {
      out.push(...((await base().where('person_id', '=', c.personId).orderBy('created_at', 'desc').limit(50).execute()) as DemandRow[]));
    }
    if (c.companyNorm) {
      out.push(...((await base().where('company_norm', '=', c.companyNorm).orderBy('created_at', 'desc').limit(50).execute()) as DemandRow[]));
    }
    return [...new Map(out.filter((d) => d.id !== c.excludeId).map((d) => [d.id, d])).values()];
  }

  async resolveMicromarket(nameNorm: string): Promise<MicromarketRow | undefined> {
    const rows = await this.micromarketsNamed([nameNorm]);
    return rows.sort((a, b) => (LEVEL_DEPTH[b.level] ?? 0) - (LEVEL_DEPTH[a.level] ?? 0))[0];
  }

  async micromarketsNamed(namesNorm: readonly string[], excludeId?: string): Promise<MicromarketRow[]> {
    const names = [...new Set(namesNorm)].filter(Boolean);
    if (!names.length) return [];
    let q = this.#from('micromarkets')
      .selectAll()
      .where((eb) => eb.or([eb('name_norm', 'in', names), eb(sql`aliases_norm`, '&&', sql`${names}::text[]`)]));
    if (excludeId) q = q.where('id', '!=', excludeId);
    return (await q.limit(50).execute()) as MicromarketRow[];
  }

  async micromarketDescendants(ids: readonly string[]): Promise<string[]> {
    if (!ids.length) return [];
    const r = await sql<{ id: string }>`
      with recursive tree(id, depth) as (
        select id, 0 from ${sql.table(`${SCHEMA}.micromarkets`)} where tenant_id = ${this.#t} and id = any(${[...ids]}::uuid[])
        union all
        select m.id, t.depth + 1 from ${sql.table(`${SCHEMA}.micromarkets`)} m join tree t on m.parent_id = t.id
        where m.tenant_id = ${this.#t} and t.depth < 4
      )
      select distinct id from tree limit 200`.execute(this.#db);
    return r.rows.map((x) => x.id);
  }

  async purgeablePersons(cutoff: Date, limit: number): Promise<string[]> {
    const t = this.#t;
    const r = await sql<{ id: string }>`
      select p.id from ${sql.table(`${SCHEMA}.persons`)} p
      where p.tenant_id = ${t} and p.purged_at is null and p.last_activity_at < ${cutoff}
        and not exists (select 1 from ${sql.table(`${SCHEMA}.demands`)} d
                        where d.tenant_id = ${t} and d.person_id = p.id and d.updated_at >= ${cutoff})
        and not exists (select 1 from ${sql.table(`${SCHEMA}.record_parties`)} rp
                        join ${sql.table(`${SCHEMA}.offers`)} o on o.tenant_id = rp.tenant_id
                          and (o.id = rp.subject_id or o.property_id = rp.subject_id)
                        where rp.tenant_id = ${t} and rp.person_id = p.id and o.updated_at >= ${cutoff})
      order by p.last_activity_at limit ${limit}`.execute(this.#db);
    return r.rows.map((x) => x.id);
  }

  async purgeableSourceAds(cutoff: Date, limit: number): Promise<string[]> {
    const t = this.#t;
    const r = await sql<{ id: string }>`
      select a.id from ${sql.table(`${SCHEMA}.source_ads`)} a
      where a.tenant_id = ${t} and a.purged_at is null and a.created_at < ${cutoff}
        and not exists (select 1 from ${sql.table(`${SCHEMA}.offers`)} o where o.tenant_id = ${t} and o.source_ad_id = a.id and o.updated_at >= ${cutoff})
        and not exists (select 1 from ${sql.table(`${SCHEMA}.demands`)} d where d.tenant_id = ${t} and d.source_ad_id = a.id and d.updated_at >= ${cutoff})
      order by a.created_at, a.id limit ${limit}`.execute(this.#db);
    return r.rows.map((x) => x.id);
  }

  async purgeableUnitDetails(cutoff: Date, limit: number): Promise<string[]> {
    const t = this.#t;
    const r = await sql<{ id: string }>`
      select p.id from ${sql.table(`${SCHEMA}.properties`)} p
      where p.tenant_id = ${t} and p.updated_at < ${cutoff}
        and (p.wing is not null or p.unit_no is not null or p.floor_no is not null)
        and not exists (select 1 from ${sql.table(`${SCHEMA}.offers`)} o where o.tenant_id = ${t} and o.property_id = p.id and o.updated_at >= ${cutoff})
      order by p.updated_at, p.id limit ${limit}`.execute(this.#db);
    return r.rows.map((x) => x.id);
  }

  async oldEnquiryMessages(cutoff: Date, limit: number): Promise<string[]> {
    const rows = (await this.#from('enquiries')
      .select('id')
      .where('message', 'is not', null)
      .where('received_at', '<', cutoff)
      .orderBy('received_at')
      .limit(limit)
      .execute()) as { id: string }[];
    return rows.map((r) => r.id);
  }

  async offerCounters(ids: readonly string[]) {
    const out = new Map<string, { sightings: number; enquiries: number; secondSources: number; openGap: boolean }>();
    if (!ids.length) return out;
    const t = this.#t;
    const list = [...ids];
    const [s, e, g] = await Promise.all([
      sql<{ id: string; n: string }>`select subject_id as id, count(*)::text as n from ${sql.table(`${SCHEMA}.sightings`)}
        where tenant_id = ${t} and subject_type = 'offer' and subject_id = any(${list}::uuid[]) group by subject_id`.execute(this.#db),
      sql<{ id: string; n: string }>`select offer_id as id, count(*)::text as n from ${sql.table(`${SCHEMA}.enquiries`)}
        where tenant_id = ${t} and offer_id = any(${list}::uuid[]) group by offer_id`.execute(this.#db),
      sql<{ id: string; n: string; gap: boolean }>`select offer_id as id, count(*)::text as n, bool_or(price_gap and status = 'open') as gap
        from ${sql.table(`${SCHEMA}.second_sources`)} where tenant_id = ${t} and offer_id = any(${list}::uuid[]) group by offer_id`.execute(this.#db),
    ]);
    for (const id of ids) out.set(id, { sightings: 0, enquiries: 0, secondSources: 0, openGap: false });
    for (const r of s.rows) out.get(r.id)!.sightings = Number(r.n);
    for (const r of e.rows) out.get(r.id)!.enquiries = Number(r.n);
    for (const r of g.rows) Object.assign(out.get(r.id)!, { secondSources: Number(r.n), openGap: r.gap });
    return out;
  }

  async demandTouchCounts(ids: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>(ids.map((id) => [id, 0]));
    if (!ids.length) return out;
    const r = await sql<{ id: string; n: string }>`select demand_id as id, count(*)::text as n from ${sql.table(`${SCHEMA}.touches`)}
      where tenant_id = ${this.#t} and demand_id = any(${[...ids]}::uuid[]) group by demand_id`.execute(this.#db);
    for (const x of r.rows) out.set(x.id, Number(x.n));
    return out;
  }

  async activeMergesTouching(ids: readonly string[]): Promise<MergeRow[]> {
    if (!ids.length) return [];
    return (await this.#from('merges')
      .selectAll()
      .where('status', '=', 'active')
      .where((eb) => eb.or([eb('survivor_id', 'in', [...ids]), eb(sql`merged_ids`, '&&', sql`${[...ids]}::uuid[]`)]))
      .limit(100)
      .execute()) as MergeRow[];
  }

  async adjacentIds(ids: readonly string[]): Promise<Map<string, string[]>> {
    const rows = await this.#in<{ micromarket_id: string; adjacent_id: string }>('micromarket_adjacency', 'micromarket_id', ids);
    const out = new Map<string, string[]>();
    for (const id of ids) out.set(id, []);
    for (const r of rows) out.get(r.micromarket_id)?.push(r.adjacent_id);
    return out;
  }
}
