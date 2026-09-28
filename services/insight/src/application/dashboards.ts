// GetDashboard (LLD §4.8): every tile reads a rollup, daily facts or a small table (never a base-table scan), in
// parallel; results are memoised per (tenant, dashboard, filters) for 30 s. Filters are stored fields only; labels are
// generated for display.
import { addDays, istDay, resolvePeriod } from '../domain/dates.js';
import type { PeriodPreset } from '../domain/dates.js';
import {
  DEMAND_QUEUE_TILES,
  LIFE_ORDER,
  SUPPLY_QUEUE_TILES,
  breakdownTile,
  classificationGrid,
  drill,
  periodOf,
  planFiltersOf,
  valueTile,
} from '../domain/dashboards/definitions.js';
import type { DashboardFilters, DashboardName, Section, Tile } from '../domain/dashboards/definitions.js';
import { ACTIVE_OFFER_STATUSES } from '../domain/plans/catalogue.js';
import { translateTerm } from '../domain/plans/termTranslator.js';
import type { PlanFilter } from '../domain/plans/types.js';
import { matchKey } from '@11e/vocabulary';
import type { Clock, DashboardReader, DimFilter, ReadModelInfo, ReferenceData } from './ports.js';

export interface DashboardDeps {
  reader: DashboardReader;
  refs: ReferenceData;
  info: ReadModelInfo;
  clock: Clock;
}

export interface DashboardQuery {
  period?: PeriodPreset;
  from?: string;
  to?: string;
  segment?: string;
  dealType?: string;
  market?: string;
  propertyType?: string;
  micromarket?: string;
  ownerUserId?: string;
  saleMode?: string;
  tenancyStatus?: string;
}

export interface Dashboard {
  dashboard: DashboardName;
  filters: Record<string, unknown>;
  generatedAt: string;
  dataAsOf: string;
  sections: Section[];
}

export type DashboardOutcome =
  | { ok: true; dashboard: Dashboard }
  | { ok: false; code: 'validation-failed' | 'unknown-vocabulary-value'; errors: { field: string; code: string; message: string }[] };

const VOCAB_PARAMS: readonly [keyof DashboardQuery, string][] = [
  ['segment', 'segment'],
  ['dealType', 'deal_type'],
  ['market', 'market'],
  ['propertyType', 'property_type'],
  ['saleMode', 'sale_mode'],
  ['tenancyStatus', 'tenancy_status'],
];

const MEMO_MS = 30_000;
const memo = new Map<string, { at: number; value: Dashboard }>();

export async function resolveFilters(
  deps: DashboardDeps,
  tenantId: string,
  q: DashboardQuery,
): Promise<{ ok: true; filters: DashboardFilters } | Exclude<DashboardOutcome, { ok: true }>> {
  const now = deps.clock.now();
  const preset = q.period ?? 'this_month';
  const range = resolvePeriod(preset, now, { from: q.from, to: q.to });
  if (!range || range.from > range.to)
    return { ok: false, code: 'validation-failed', errors: [{ field: 'from', code: 'required', message: 'period=custom needs from (and to ≥ from)' }] };
  const filters: DashboardFilters = { preset, range, ...(q.from ? { from: q.from } : {}), ...(q.to ? { to: q.to } : {}) };
  const vocab = await deps.refs.vocabulary(tenantId);
  const errors: { field: string; code: string; message: string }[] = [];
  for (const [param, field] of VOCAB_PARAMS) {
    const raw = q[param];
    if (raw === undefined) continue;
    const t = translateTerm(field, raw, vocab.values[field] ?? []);
    if (!t) errors.push({ field: param, code: 'unknown-vocabulary-value', message: `"${raw}" is not a ${field} value (labels are not accepted)` });
    else (filters as unknown as Record<string, string>)[param] = t.maps[field] as string;
  }
  if (q.micromarket !== undefined) {
    const index = await deps.refs.locations(tenantId);
    const hit = index.size ? index.get(matchKey(q.micromarket)) : { name: q.micromarket.trim(), level: 'micromarket' };
    if (!hit) errors.push({ field: 'micromarket', code: 'unknown-vocabulary-value', message: `unknown micromarket "${q.micromarket}"` });
    else filters.micromarket = hit.name;
  }
  if (q.ownerUserId) filters.ownerUserId = q.ownerUserId;
  if (errors.length) return { ok: false, code: 'unknown-vocabulary-value', errors };
  return { ok: true, filters };
}

const dims = (f: DashboardFilters): DimFilter => {
  const d: DimFilter = {};
  for (const k of ['segment', 'dealType', 'market', 'propertyType', 'micromarket', 'ownerUserId', 'saleMode', 'tenancyStatus'] as const) {
    const v = f[k];
    if (v !== undefined) d[k] = v;
  }
  return d;
};

export async function getDashboard(deps: DashboardDeps, tenantId: string, name: DashboardName, q: DashboardQuery): Promise<DashboardOutcome> {
  const r = await resolveFilters(deps, tenantId, q);
  if (!r.ok) return r;
  const key = `${tenantId}|${name}|${JSON.stringify(r.filters)}`;
  const hit = memo.get(key);
  const nowMs = deps.clock.now().getTime();
  if (hit && nowMs - hit.at < MEMO_MS && hit.at <= nowMs) return { ok: true, dashboard: hit.value };
  const builders = { demand: demandSections, supply: supplySections, scopes: scopesSections, quality: qualitySections };
  const [sections, asOf] = await Promise.all([builders[name](deps, tenantId, r.filters), deps.info.dataAsOf(tenantId)]);
  const now = deps.clock.now();
  const dashboard: Dashboard = {
    dashboard: name,
    filters: { period: r.filters.preset, from: r.filters.range.from, to: r.filters.range.to, ...dims(r.filters) },
    generatedAt: now.toISOString(),
    dataAsOf: (asOf ?? now).toISOString(),
    sections,
  };
  memo.set(key, { at: nowMs, value: dashboard });
  if (memo.size > 500) memo.delete(memo.keys().next().value as string);
  return { ok: true, dashboard };
}

const eq = (field: string, value: unknown): PlanFilter => ({ field, op: 'eq', value });
const saleMarket = (market: string | null): PlanFilter => (market ? eq('market', market) : { field: 'market', op: 'is_null', value: null });
const thisWeek = (today: string) => resolvePeriod('this_week', new Date(`${today}T06:30:00.000Z`)) ?? { from: today, to: today };

// ------------------------------------------------------------------------------------------ demand
async function demandSections(deps: DashboardDeps, t: string, f: DashboardFilters): Promise<Section[]> {
  const r = deps.reader;
  const d = dims(f);
  const today = istDay(deps.clock.now());
  const base = planFiltersOf(f, 'demand');
  const [bySource, merged, life, queues, srq, visits, followUps, dealsMonth, exitsByType, exitsByReason, grid] = await Promise.all([
    r.facts(t, ['demand_created'], f.range, d, 'source_type'),
    r.facts(t, ['records_merged'], f.range, {}, 'reason'),
    r.demandRollup(t, d, ['life_stage']),
    r.queueCounts(t, f.ownerUserId),
    r.openSourcingRequests(t),
    r.siteVisitsScheduled(t, thisWeek(today)),
    r.followUpsDue(t, today, f.ownerUserId),
    r.facts(t, ['deal_opened'], resolvePeriod('this_month', deps.clock.now()) ?? f.range, d, 'metric'),
    r.facts(t, ['demand_exit_lost', 'demand_exit_dormant', 'demand_exit_invalid'], f.range, d, 'metric'),
    r.facts(t, ['demand_exit_lost', 'demand_exit_dormant', 'demand_exit_invalid'], f.range, d, 'reason'),
    r.demandRollup(t, d, ['segment', 'deal_type_primary', 'market']),
  ]);
  const created = periodOf(f, 'created_at');
  return [
    {
      sectionId: 'demand_by_source',
      title: 'By source (first touch)',
      tiles: [
        breakdownTile('new_demand_by_source', 'New demand', bySource, {
          order: ['Channel', 'Digi', 'Direct'],
          drill: (s) => drill('list_demands', [...base, eq('source_type', s)], created),
          drillAll: drill('list_demands', base, created),
        }),
        valueTile('duplicates_merged', 'Duplicates merged', merged.find((m) => m.key === 'demand')?.n ?? 0),
      ],
    },
    {
      sectionId: 'demand_life_curve',
      title: 'Life curve',
      tiles: [
        breakdownTile('demand_life_curve', 'Open demand by life stage', life.map((x) => ({ key: x['life_stage'] ?? null, n: x.n })), {
          order: LIFE_ORDER,
          drill: (s) => drill('list_demands', [...base, eq('life_stage', s)]),
        }),
      ],
    },
    {
      sectionId: 'demand_team_queues',
      title: 'Team queues',
      tiles: [
        ...DEMAND_QUEUE_TILES.map((q) => valueTile(`queue_${q.section}`, q.title, queues[q.section] ?? 0, 'count', q.drill?.(f, today))),
        valueTile('sourcing_requests_open', 'Sourcing requests open', srq),
        valueTile('site_visits_this_week', 'Site visits this week', visits),
        valueTile(
          'deals_follow_up_due',
          'In process with follow-up due',
          followUps,
          'count',
          drill('list_deals', [...planFiltersOf(f, 'deal'), eq('status', 'open'), { field: 'follow_up_date', op: 'lte', value: today }]),
        ),
        valueTile('deals_this_month', 'Deals this month', dealsMonth.reduce((s, x) => s + x.n, 0), 'count',
          drill('list_deals', planFiltersOf(f, 'deal'), { preset: 'this_month', field: 'opened_at' })),
      ],
    },
    {
      sectionId: 'exits',
      title: 'Exits with reasons',
      tiles: [
        breakdownTile('exits_by_type', 'Exits', exitsByType.map((x) => ({ key: (x.key ?? '').replace('demand_exit_', '').replace(/^./, (c) => c.toUpperCase()), n: x.n })), {
          order: ['Lost', 'Dormant', 'Invalid'],
          drill: (type) => drill('list_demands', [...base, eq('exit_type', type)]),
        }),
        breakdownTile('exit_reasons', 'Exit reasons', exitsByReason.slice(0, 10)),
      ],
    },
    {
      sectionId: 'demand_by_classification',
      title: 'Classification (Wants labels)',
      tiles: [
        classificationGrid(
          'demand_classification_grid',
          'Open demand by segment and deal type',
          'Demand',
          grid.map((x) => ({ segment: x['segment'] ?? null, deal_type: x['deal_type_primary'] ?? null, market: x['market'] ?? null, n: x.n })),
          (segment, dealType, market) =>
            drill('list_demands', [...base, eq('segment', segment), eq('deal_type', dealType), ...(dealType === 'Sale' ? [saleMarket(market)] : [])]),
        ),
      ],
    },
  ];
}

// ------------------------------------------------------------------------------------------ supply
async function supplySections(deps: DashboardDeps, t: string, f: DashboardFilters): Promise<Section[]> {
  const r = deps.reader;
  const d = dims(f);
  const base = planFiltersOf(f, 'offer');
  const active = [...ACTIVE_OFFER_STATUSES];
  const [stock, activeOffers, created, merged, life, queues, status, stages, publication, grid, tags] = await Promise.all([
    r.stock(t),
    r.offerRollup(t, d, [], active),
    r.facts(t, ['offer_created'], f.range, d, 'metric'),
    r.facts(t, ['records_merged'], f.range, {}, 'reason'),
    r.offerRollup(t, d, ['life_stage'], active),
    r.queueCounts(t, f.ownerUserId),
    r.offerRollup(t, d, ['commercial_status']),
    r.offerRollup(t, d, ['record_stage'], active),
    r.offerRollup(t, d, ['publication_level'], active),
    r.offerRollup(t, d, ['segment', 'deal_type', 'market'], active),
    r.offerRollup(t, d, ['sale_mode', 'tenancy_status'], active),
  ]);
  const activeCount = activeOffers[0]?.n ?? 0;
  const verified = stages.filter((s) => s['record_stage'] === 'Verified' || s['record_stage'] === 'Qualified').reduce((s, x) => s + x.n, 0);
  const activeFilter: PlanFilter = { field: 'commercial_status', op: 'in', value: active };
  const pub = (level: string) => publication.find((p) => p['publication_level'] === level)?.n ?? 0;
  const tile = (id: string, title: string, n: number, extra: PlanFilter[]) => valueTile(id, title, n, 'count', drill('list_offers', [...base, ...extra]));
  return [
    {
      sectionId: 'supply_stock',
      title: 'Stock',
      tiles: [
        valueTile('properties', 'Properties', stock.properties),
        valueTile('projects', 'Projects', stock.projects),
        tile('active_offers', 'Active offers', activeCount, [activeFilter]),
        valueTile('new_offers', 'New offers', created.reduce((s, x) => s + x.n, 0), 'count', drill('list_offers', base, periodOf(f, 'created_at'))),
        valueTile('duplicates_linked', 'Duplicates linked', merged.find((m) => m.key === 'offer')?.n ?? 0),
      ],
    },
    {
      sectionId: 'supply_life_curve',
      title: 'Life curve',
      tiles: [
        breakdownTile('supply_life_curve', 'Active offers by life stage', life.map((x) => ({ key: x['life_stage'] ?? null, n: x.n })), {
          order: LIFE_ORDER,
          drill: (s) => drill('list_offers', [...base, activeFilter, eq('life_stage', s)]),
        }),
      ],
    },
    {
      sectionId: 'supply_queues_listings',
      title: 'Queues and listings',
      tiles: [
        ...SUPPLY_QUEUE_TILES.map((q) => valueTile(`queue_${q.section}`, q.title, queues[q.section] ?? 0)),
        tile('upcoming', 'Upcoming', status.find((s) => s['commercial_status'] === 'Upcoming')?.n ?? 0, [eq('commercial_status', 'Upcoming')]),
        valueTile('share_verified', 'Share verified', activeCount ? Math.round((verified / activeCount) * 1000) / 10 : null, 'pct',
          drill('list_offers', [...base, activeFilter, { field: 'record_stage', op: 'in', value: ['Verified', 'Qualified'] }])),
        tile('listed_public', 'Listed Public', pub('Public'), [activeFilter, eq('publication_level', 'Public')]),
        tile('listed_anonymous', 'Listed Anonymous', pub('Anonymous'), [activeFilter, eq('publication_level', 'Anonymous')]),
      ],
    },
    {
      sectionId: 'supply_by_classification',
      title: 'Classification (For labels)',
      tiles: [
        classificationGrid(
          'supply_classification_grid',
          'Active offers by segment and deal type',
          'Supply',
          grid.map((x) => ({ segment: x['segment'] ?? null, deal_type: x['deal_type'] ?? null, market: x['market'] ?? null, n: x.n })),
          (segment, dealType, market) =>
            drill('list_offers', [...base, activeFilter, eq('segment', segment), eq('deal_type', dealType), ...(dealType === 'Sale' ? [saleMarket(market)] : [])]),
        ),
        tile('deal_tag_auction', 'Auction', tags.filter((x) => x['sale_mode'] === 'Auction').reduce((s, x) => s + x.n, 0), [activeFilter, eq('sale_mode', 'Auction')]),
        tile('deal_tag_tenanted', 'Tenanted', tags.filter((x) => x['tenancy_status'] === 'Tenanted').reduce((s, x) => s + x.n, 0), [activeFilter, eq('tenancy_status', 'Tenanted')]),
      ],
    },
  ];
}

// ------------------------------------------------------------------------------------------ other scopes
async function scopesSections(deps: DashboardDeps, t: string, _f: DashboardFilters): Promise<Section[]> {
  void _f;
  const today = istDay(deps.clock.now());
  const [items, wl] = await Promise.all([deps.reader.deskItems(t), deps.reader.watchlist(t, today, addDays(today, 14))]);
  const scope = (s: string) => items.filter((i) => i.record_scope === s);
  const by = (rows: typeof items, key: (i: (typeof items)[number]) => string | null) => {
    const m = new Map<string | null, number>();
    for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + r.n);
    return [...m.entries()].map(([k, n]) => ({ key: k, n }));
  };
  const desk = (s: string): Tile[] => [
    breakdownTile(`${s.toLowerCase()}_by_side_sector`, `${s} desk by side and sector`, by(scope(s), (i) => `${i.side ?? 'Side not set'} · ${i.sector ?? 'Sector not set'}`)),
    valueTile(`${s.toLowerCase()}_includes_property`, `${s} items with a property`, scope(s).filter((i) => i.with_property).reduce((a, i) => a + i.n, 0)),
  ];
  return [
    { sectionId: 'business_capital', title: 'Business and Capital desks', tiles: [...desk('Business'), ...desk('Capital')] },
    { sectionId: 'archive', title: 'Archive (Equipment)', tiles: [breakdownTile('equipment_by_side', 'Equipment by side', by(scope('Equipment'), (i) => i.side))] },
    { sectionId: 'network', title: 'Network (Market Participants)', tiles: [breakdownTile('participants_by_role', 'Participants by role', by(scope('Market Participant'), (i) => i.participant_role))] },
    {
      sectionId: 'watchlist',
      title: 'Watchlist',
      tiles: [
        breakdownTile('watchlist_by_signal', 'Signals by type', wl.bySignal),
        valueTile('watchlist_deadlines_14d', 'Deadlines in the next 14 days', wl.deadlinesSoon),
        valueTile('watchlist_open_tasks', 'Open follow-up tasks', wl.openTasks),
      ],
    },
  ];
}

// ------------------------------------------------------------------------------------------ data quality
async function qualitySections(deps: DashboardDeps, t: string, f: DashboardFilters): Promise<Section[]> {
  const r = deps.reader;
  const now = deps.clock.now();
  const [uploads, review, merges, side, source] = await Promise.all([
    r.uploads(t, f.range),
    r.reviewOpenByReason(t),
    r.mergeCandidates(t, f.range),
    r.sideDefaulted(t, f.range),
    r.offerRollup(t, dims(f), ['source_type', 'record_stage', 'commercial_status']),
  ]);
  const src = (s: string | null) => s ?? 'Not set';
  const uploadsDrill = { planId: 'upload_quality', templateVersion: 1, groupBy: ['source_type'], period: periodOf(f, 'started_at') };
  const sources = [...new Set(source.map((x) => x['source_type'] ?? null))];
  const share = (pred: (x: (typeof source)[number]) => boolean) =>
    sources.map((s) => {
      const rows = source.filter((x) => (x['source_type'] ?? null) === s);
      const total = rows.reduce((a, x) => a + x.n, 0);
      const hit = rows.filter(pred).reduce((a, x) => a + x.n, 0);
      return { key: s, n: total ? Math.round((hit / total) * 1000) / 10 : 0 };
    });
  const MATCHED = ['Matched', 'In proposal', 'Site visit', 'In process', 'Closed'];
  return [
    {
      sectionId: 'uploads',
      title: 'Uploads per source',
      tiles: [
        { ...breakdownTile('rows_accepted', 'Rows accepted', uploads.bySource.map((u) => ({ key: src(u.source), n: u.accepted }))), drillDown: uploadsDrill },
        breakdownTile('rows_rejected_by_reason', 'Rows rejected (by reason)', uploads.rejectionReasons),
        breakdownTile('rows_needing_review', 'Rows needing review', uploads.bySource.map((u) => ({ key: src(u.source), n: u.needsReview }))),
        valueTile('possible_repeats', 'Duplicates (possible repeats)', uploads.possibleRepeats),
        breakdownTile(
          'days_since_last_upload',
          'Days since the last upload',
          uploads.bySource.map((u) => ({ key: src(u.source), n: u.lastStartedAt ? Math.floor((now.getTime() - u.lastStartedAt.getTime()) / 86_400_000) : 0 })),
          { unit: 'days' },
        ),
      ],
    },
    {
      sectionId: 'review',
      title: 'Review queue',
      tiles: [
        breakdownTile('review_by_reason', 'Open review items by reason', review),
        valueTile('uncertain_merges', 'Uncertain merges', merges.find((m) => m.key === 'uncertain_merge')?.n ?? 0),
        valueTile('price_gaps', 'Price gaps', merges.find((m) => m.key === 'price_gap')?.n ?? 0),
      ],
    },
    {
      sectionId: 'side_checks',
      title: 'Side checks',
      tiles: [breakdownTile('side_defaulted_per_upload', 'Side defaulted per upload', side)],
    },
    {
      sectionId: 'source_quality',
      title: 'Source quality',
      tiles: [
        breakdownTile('share_verified_by_source', 'Share of offers verified', share((x) => x['record_stage'] === 'Verified' || x['record_stage'] === 'Qualified'), { unit: 'pct' }),
        breakdownTile('share_matched_by_source', 'Share of offers matched', share((x) => MATCHED.includes(x['commercial_status'] ?? '')), { unit: 'pct' }),
        breakdownTile('share_closed_by_source', 'Share of offers closed', share((x) => x['commercial_status'] === 'Closed'), { unit: 'pct' }),
      ],
    },
  ];
}
