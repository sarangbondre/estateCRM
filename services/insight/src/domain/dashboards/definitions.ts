// Dashboards (BRD §8, PRD US-30, LLD §4.8): tile and grid builders, the queue tiles (journeys section keys, R-18)
// and the drill-down plans every tile opens through POST /v1/queries. Pure: the adapter supplies aggregates.
import type { DayRange, PeriodPreset } from '../dates.js';
import { labelFor } from '../labels/labelGenerator.js';
import type { PlanFilter, QueryPlan } from '../plans/types.js';

export type DashboardName = 'demand' | 'supply' | 'scopes' | 'quality';

export interface DashboardFilters {
  preset: PeriodPreset;
  range: DayRange;
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

export interface Breakdown {
  key: string;
  label: string;
  value: number;
  drillDown?: QueryPlan;
}

export interface Tile {
  tileId: string;
  title: string;
  value: number | null;
  unit: 'count' | 'inr' | 'pct' | 'days';
  breakdown?: Breakdown[];
  drillDown?: QueryPlan;
}

export interface GridTile {
  tileId: string;
  title: string;
  rows: { key: string; label: string }[];
  columns: { key: string; label: string }[];
  cells: { row: string; column: string; value: number; label?: string; drillDown?: QueryPlan }[];
  /**
   * Always null: a grid has no single drill-down (its cells do). It also keeps a grid from validating as a plain
   * `Tile` under the contract's `oneOf [Tile, GridTile]` (Tile.drillDown must be an object).
   */
  drillDown: null;
}

export interface Section {
  sectionId: string;
  title: string;
  tiles: (Tile | GridTile)[];
}

// ------------------------------------------------------------------------------------------ drill-down plans

const eq = (field: string, value: unknown): PlanFilter => ({ field, op: 'eq', value });

/** Dashboard filters as plan filters of an offer or demand template (stored fields only). */
export function planFiltersOf(f: DashboardFilters, side: 'offer' | 'demand' | 'deal'): PlanFilter[] {
  const out: PlanFilter[] = [];
  if (f.segment) out.push(eq('segment', f.segment));
  if (f.dealType) out.push(eq('deal_type', f.dealType));
  if (f.market && side !== 'deal') out.push(eq('market', f.market));
  if (f.propertyType && side !== 'deal') out.push(eq('property_type', f.propertyType));
  if (f.micromarket) out.push(eq('location', f.micromarket));
  if (f.ownerUserId) out.push(eq('owner_user_id', f.ownerUserId));
  if (side === 'offer') {
    if (f.saleMode) out.push(eq('sale_mode', f.saleMode));
    if (f.tenancyStatus) out.push(eq('tenancy_status', f.tenancyStatus));
  }
  return out;
}

export function drill(
  planId: string,
  filters: PlanFilter[],
  period?: { preset: PeriodPreset; from?: string; to?: string; field?: string },
): QueryPlan {
  const plan: QueryPlan = { planId, templateVersion: 1 };
  // one filter per field: the tile's own filter wins over the dashboard filter
  const seen = new Set<string>();
  const merged = [...filters].reverse().filter((x) => (seen.has(x.field) ? false : (seen.add(x.field), true))).reverse();
  if (merged.length) plan.filters = merged;
  if (period) plan.period = period;
  return plan;
}

export function periodOf(f: DashboardFilters, field: string) {
  return f.preset === 'custom'
    ? { preset: 'custom' as const, from: f.range.from, to: f.range.to, field }
    : { preset: f.preset, field };
}

// ------------------------------------------------------------------------------------------ queue tiles (R-18)

export interface QueueTileDef {
  section: string;
  title: string;
  drill?: (f: DashboardFilters, today: string) => QueryPlan;
}

export const DEMAND_QUEUE_TILES: readonly QueueTileDef[] = [
  { section: 'to_contact', title: 'To contact' },
  { section: 'to_qualify', title: 'To qualify' },
  { section: 'reconfirm_due', title: 'Reconfirm due' },
  {
    section: 'in_sourcing',
    title: 'In sourcing',
    drill: (f) => drill('list_demands', [...planFiltersOf(f, 'demand'), eq('commercial_status', 'Sourcing')]),
  },
  { section: 'open_matches', title: 'Open matches' },
  { section: 'proposals_out', title: 'Proposals out' },
];

export const SUPPLY_QUEUE_TILES: readonly QueueTileDef[] = [
  { section: 'must_call', title: 'Must call' },
  { section: 'should_call', title: 'Should call' },
];

// ------------------------------------------------------------------------------------------ builders

export function breakdownTile(
  tileId: string,
  title: string,
  items: { key: string | null; n: number }[],
  opts: { unit?: Tile['unit']; label?: (key: string) => string; drill?: (key: string) => QueryPlan; drillAll?: QueryPlan; order?: readonly string[] } = {},
): Tile {
  const rows = items.map((i) => ({ key: i.key ?? 'unknown', n: i.n }));
  if (opts.order) {
    const rank = (k: string) => {
      const i = opts.order?.indexOf(k) ?? -1;
      return i < 0 ? 999 : i;
    };
    rows.sort((a, b) => rank(a.key) - rank(b.key) || b.n - a.n);
  } else rows.sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
  const tile: Tile = {
    tileId,
    title,
    value: opts.unit === 'pct' || opts.unit === 'days' ? null : rows.reduce((s, r) => s + r.n, 0),
    unit: opts.unit ?? 'count',
    breakdown: rows.map((r) => ({
      key: r.key,
      label: opts.label ? opts.label(r.key) : r.key === 'unknown' ? 'Not set' : r.key,
      value: r.n,
      ...(opts.drill && r.key !== 'unknown' ? { drillDown: opts.drill(r.key) } : {}),
    })),
  };
  if (opts.drillAll) tile.drillDown = opts.drillAll;
  return tile;
}

export function valueTile(tileId: string, title: string, value: number | null, unit: Tile['unit'] = 'count', drillDown?: QueryPlan): Tile {
  return { tileId, title, value, unit, ...(drillDown ? { drillDown } : {}) };
}

export const GRID_SEGMENTS = ['Residential', 'Commercial', 'Industrial', 'Land'] as const;

/** Classification grid columns (Sale split by market; BRD §4.2 table). `Any` only exists on the demand side. */
export function gridColumns(side: 'Supply' | 'Demand') {
  const cols = [
    { key: 'Sale|Secondary', dealType: 'Sale', market: 'Secondary' },
    { key: 'Sale|Primary', dealType: 'Sale', market: 'Primary' },
    ...(side === 'Demand' ? [{ key: 'Sale|Any', dealType: 'Sale', market: 'Any' }] : []),
    { key: 'Sale|', dealType: 'Sale', market: null },
    { key: 'Lease', dealType: 'Lease', market: null },
    { key: 'JV', dealType: 'JV', market: null },
    { key: 'Pagdi', dealType: 'Pagdi', market: null },
  ];
  return cols.map((c) => ({
    ...c,
    label: c.dealType === 'Sale' ? `Sale${c.market ? ` · ${c.market === 'Secondary' ? 'Resale' : c.market === 'Primary' ? 'New project' : 'Any'}` : ' · market not set'}` : c.dealType,
  }));
}

export function classificationGrid(
  tileId: string,
  title: string,
  side: 'Supply' | 'Demand',
  rows: { segment: string | null; deal_type: string | null; market: string | null; n: number }[],
  drillOf: (segment: string, dealType: string, market: string | null) => QueryPlan,
): GridTile {
  const cols = gridColumns(side);
  const colOf = (dealType: string | null, market: string | null) =>
    cols.find((c) => c.dealType === dealType && (c.dealType !== 'Sale' || c.market === (market ?? null)));
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!r.segment) continue;
    const c = colOf(r.deal_type, r.market);
    if (!c) continue;
    const k = `${r.segment}\u0000${c.key}`;
    counts.set(k, (counts.get(k) ?? 0) + r.n);
  }
  const cells: GridTile['cells'] = [];
  for (const seg of GRID_SEGMENTS)
    for (const c of cols) {
      const value = counts.get(`${seg}\u0000${c.key}`) ?? 0;
      const label = labelFor(side, c.dealType, c.market, seg);
      cells.push({
        row: seg,
        column: c.key,
        value,
        ...(label ? { label } : {}),
        drillDown: drillOf(seg, c.dealType, c.market),
      });
    }
  return {
    tileId,
    title,
    rows: GRID_SEGMENTS.map((s) => ({ key: s, label: s })),
    columns: cols.map((c) => ({ key: c.key, label: c.label })),
    cells,
    drillDown: null,
  };
}

export const LIFE_ORDER = ['Fresh', 'Ageing', 'Stale', 'Expired', 'Paused'] as const;
