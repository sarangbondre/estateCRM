'use client';
// C-20 Dashboard summary card and P-06 Dashboards panel (PRD §5.4, BRD §8, US-30): Demand / Supply / Other scopes /
// Data quality tabs per the endpoints' x-roles (Data operators only have Data quality), prototype .kpis tiles and .bars
// rows; every tile opens its list: the drill-down plan in the Table panel (P-07), else a chat question.
// insight: getDemandDashboard, getSupplyDashboard, getScopesDashboard, getQualityDashboard.
import { useState } from 'react';
import type { CSSProperties } from 'react';
import { useResource } from '../../lib/api';
import { relative } from '../../lib/format';
import type { CardProps, PanelProps, ShellActions } from '../../shell/types';
import { Card, ErrorNote, Loading } from '../Card';
import { Select, Tabs } from '../common';
import { barWidths, dashboardTabsFor, DASHBOARD_TABS, isGridTile, tileQuestion } from './logic';
import type { Dashboard, DashboardKey, GridTile, QueryPlan, Tile } from './logic';
import { formatFigure } from './views';

const PERIODS = [
  { value: 'today', label: 'Today' },
  { value: 'this_week', label: 'This week' },
  { value: 'this_month', label: 'This month' },
  { value: 'this_quarter', label: 'This quarter' },
  { value: 'last_30_days', label: 'Last 30 days' },
] as const;

const tileButton: CSSProperties = { font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer', width: '100%' };

function openTile(shell: ShellActions, dashboard: string, title: string, plan: QueryPlan | undefined, part?: string) {
  if (plan && typeof plan.planId === 'string')
    shell.openPanel({ kind: 'table', title: part ? `${title} · ${part}` : title, props: { plan } });
  else shell.send(tileQuestion(dashboard, title, part));
}

function KpiTile({ tile, dashboard, shell }: { tile: Tile; dashboard: string; shell: ShellActions }) {
  return (
    <button type="button" className="kpi" style={tileButton} onClick={() => openTile(shell, dashboard, tile.title, tile.drillDown)}>
      <div className="l">{tile.title}</div>
      <div className="v">{formatFigure(tile.value ?? null, tile.unit)}</div>
      <span className="sr-only">Open the list</span>
    </button>
  );
}

function BreakdownTile({ tile, dashboard, shell }: { tile: Tile; dashboard: string; shell: ShellActions }) {
  const rows = (tile.breakdown ?? []).slice(0, 12);
  const widths = barWidths(rows.map((r) => r.value));
  return (
    <div style={{ gridColumn: '1 / -1' }}>
      <div className="small muted" style={{ marginBottom: 4 }}>
        {tile.title}
        {tile.value != null ? ` · ${formatFigure(tile.value, tile.unit)}` : ''}
      </div>
      <div className="bars">
        {rows.map((r, i) => (
          <button
            type="button"
            key={`${r.key ?? r.label ?? ''}-${i}`}
            className="bar-row"
            style={{ ...tileButton, display: 'grid', padding: 0, height: 'auto', border: 0, background: 'none' }}
            onClick={() => openTile(shell, dashboard, tile.title, r.drillDown ?? tile.drillDown, r.label ?? r.key)}
          >
            <span>{r.label ?? r.key ?? '—'}</span>
            <span className="bar-track" aria-hidden="true">
              <span className="bar s" style={{ display: 'block', width: `${widths[i]}%` }} />
            </span>
            <span className="num">{formatFigure(r.value ?? null, tile.unit)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Grid({ tile, dashboard, shell }: { tile: GridTile; dashboard: string; shell: ShellActions }) {
  const cols = tile.columns.slice(0, 12);
  const rows = tile.rows.slice(0, 20);
  const cell = (r: string, c: string) => tile.cells.find((x) => x.row === r && x.column === c);
  return (
    <div className="tw" tabIndex={0} role="region" aria-label="Scrollable table" style={{ gridColumn: '1 / -1' }}>
      <table>
        <caption className="sr-only">{tile.title}</caption>
        <thead>
          <tr>
            <th scope="col">{tile.title}</th>
            {cols.map((c, i) => (
              <th key={`${c.key ?? i}`} scope="col" className="n">
                {c.label ?? c.key}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.key ?? i}`}>
              <th scope="row">{r.label ?? r.key}</th>
              {cols.map((c, j) => {
                const x = cell(r.key ?? '', c.key ?? '');
                return (
                  <td key={`${c.key ?? j}`} className="n">
                    {x && x.value ? (
                      <button
                        type="button"
                        className="btn ghost sm"
                        style={{ padding: '0 2px' }}
                        aria-label={`${x.label ?? `${r.label ?? r.key}, ${c.label ?? c.key}`}: ${x.value}. Open the list`}
                        onClick={() => openTile(shell, dashboard, tile.title, x.drillDown, x.label ?? `${r.label ?? r.key} ${c.label ?? c.key}`)}
                      >
                        {formatFigure(x.value, 'count')}
                      </button>
                    ) : (
                      '·'
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Tiles({ tiles, dashboard, shell }: { tiles: readonly (Tile | GridTile)[]; dashboard: string; shell: ShellActions }) {
  return (
    <div className="kpis">
      {tiles.map((t, i) =>
        isGridTile(t) ? (
          <Grid key={t.tileId ?? i} tile={t} dashboard={dashboard} shell={shell} />
        ) : (t.breakdown?.length ?? 0) > 0 ? (
          <BreakdownTile key={t.tileId ?? i} tile={t} dashboard={dashboard} shell={shell} />
        ) : (
          <KpiTile key={t.tileId ?? i} tile={t} dashboard={dashboard} shell={shell} />
        ),
      )}
    </div>
  );
}

function DashboardView({ dashboard, shell }: { dashboard: DashboardKey; shell: ShellActions }) {
  const [period, setPeriod] = useState<string>('this_month');
  const res = useResource<Dashboard>(`/v1/dashboards/${dashboard}`, { period });
  const label = DASHBOARD_TABS.find((t) => t.key === dashboard)?.label ?? dashboard;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="filters">
        <Select label="Period" value={period} options={PERIODS} onChange={(v) => setPeriod(v ?? 'this_month')} placeholder="This month" />
      </div>
      {res.loading && !res.data && <Loading label={`Loading ${label} dashboard`} />}
      {res.error !== undefined && !res.data && <ErrorNote error={res.error} onRetry={res.reload} />}
      {res.data && (
        <>
          {(res.data.sections ?? []).length === 0 && <p className="small muted">Nothing to show for this period.</p>}
          {(res.data.sections ?? []).map((s, i) => (
            <section key={s.sectionId ?? i} aria-label={s.title}>
              <div className="qh">{s.title}</div>
              <Tiles tiles={(s.tiles ?? []).slice(0, 24)} dashboard={label} shell={shell} />
            </section>
          ))}
          <p className="small faint">
            Data as of {relative(res.data.dataAsOf)}. Every tile opens its list.
          </p>
        </>
      )}
    </div>
  );
}

/** P-06 Dashboards panel. */
function DashboardsPanel({ props, shell }: PanelProps<{ tab?: DashboardKey }>) {
  const tabs = dashboardTabsFor(shell.me.role);
  const initial = tabs.find((t) => t.key === props.tab) ?? tabs[0];
  const [tab, setTab] = useState(initial?.label ?? '');
  const current = tabs.find((t) => t.label === tab) ?? initial;
  if (!current) return <p className="small muted">Your role has no dashboards.</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Tabs tabs={tabs.map((t) => t.label)} value={current.label} onChange={setTab} label="Dashboards" />
      <DashboardView key={current.key} dashboard={current.key} shell={shell} />
    </div>
  );
}

interface SummaryProps {
  dashboard?: DashboardKey;
  headline?: Tile[];
}

/** C-20: headline tiles (from chat, or the first allowed dashboard) and buttons to open each dashboard. */
function DashboardSummaryCard({ spec, shell }: CardProps<SummaryProps>) {
  const tabs = dashboardTabsFor(shell.me.role);
  const chosen = tabs.find((t) => t.key === spec.props.dashboard) ?? tabs[0];
  const given = Array.isArray(spec.props.headline) ? spec.props.headline : null;
  const res = useResource<Dashboard>(!given && chosen ? `/v1/dashboards/${chosen.key}` : null);
  const tiles: Tile[] =
    given ??
    (res.data?.sections ?? [])
      .flatMap((s) => s.tiles ?? [])
      .filter((t): t is Tile => !isGridTile(t) && !(t as Tile).breakdown?.length)
      .slice(0, 8);
  const open = (key: DashboardKey) => shell.openPanel({ kind: 'dashboards', title: 'Dashboards', props: { tab: key } });

  return (
    <Card
      kicker="Dashboard"
      title={chosen ? `${chosen.label} at a glance` : 'Dashboards'}
      footer={
        <>
          {tabs.map((t) => (
            <button key={t.key} type="button" className="btn sm" onClick={() => open(t.key)}>
              {t.label}
            </button>
          ))}
        </>
      }
    >
      {!chosen && <p className="small muted">Your role has no dashboards.</p>}
      {chosen && !given && res.loading && !res.data && <Loading label="Loading dashboard" />}
      {chosen && !given && res.error !== undefined && !res.data && <ErrorNote error={res.error} onRetry={res.reload} />}
      {tiles.length > 0 && <Tiles tiles={tiles} dashboard={chosen?.label ?? 'dashboard'} shell={shell} />}
      {chosen && tiles.length === 0 && (given || res.data) && <p className="small muted">No headline figures yet.</p>}
    </Card>
  );
}

export { DashboardsPanel, DashboardSummaryCard };
