'use client';
// P-07 Table panel (PRD §5.4, US-31/32): rows from a chat answer or a dashboard drill-down, re-run through insight
// runQuery (POST /v1/queries) when only the plan is given or for the next page; client-side sort by column, a filter on
// stored fields, "How I got this" and the Excel export (createExport). Rows with a record code open its panel.
import { useEffect, useMemo, useState } from 'react';
import type { operations } from '@11e/contracts/insight';
import { call } from '../../lib/api';
import type { Body, Ok } from '../../lib/contract';
import type { PanelProps } from '../../shell/types';
import { ErrorNote, HowIGotThis, Loading } from '../Card';
import { Input, Select } from '../common';
import { filterRows, howNote, howParts, sortRows } from './logic';
import type { Column, HowIGotThisData, QueryPlan, QueryResult, Row, SortDir } from './logic';
import { DataTable, ExportButton } from './views';

interface Props {
  result?: QueryResult;
  plan?: QueryPlan;
  sourceMessageId?: string | null;
}

const PAGE = 50;

function TablePanel({ props, shell }: PanelProps<Props>) {
  const plan = props.plan ?? props.result?.howIGotThis?.plan ?? null;
  const [data, setData] = useState<{ columns: Column[]; rows: Row[]; cursor: string | null; how: HowIGotThisData | null }>(() => ({
    columns: props.result?.columns ?? [],
    rows: props.result?.rows ?? [],
    cursor: props.result?.nextCursor ?? null,
    how: props.result?.howIGotThis ?? null,
  }));
  const [state, setState] = useState<{ loading: boolean; error?: unknown }>({ loading: !props.result && !!plan });
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(null);
  const [filterKey, setFilterKey] = useState<string | null>(null);
  const [filterText, setFilterText] = useState('');
  const [shown, setShown] = useState(PAGE);

  const load = async (cursor: string | null) => {
    if (!plan) return;
    setState({ loading: true });
    try {
      const body: Body<operations['runQuery']> = { plan, limit: 100, ...(cursor ? { cursor } : {}) };
      const r = await call<Ok<operations['runQuery']>>('POST', '/v1/queries', { body });
      const page = r.data;
      setData((d) => ({
        columns: page.columns?.length ? page.columns : d.columns,
        rows: cursor ? [...d.rows, ...(page.rows ?? [])] : (page.rows ?? []),
        cursor: page.nextCursor ?? null,
        how: page.howIGotThis ?? d.how,
      }));
      setState({ loading: false });
    } catch (error) {
      setState({ loading: false, error });
    }
  };

  useEffect(() => {
    if (!props.result && plan) void load(null);
    // Load once per panel open; the plan object comes from props.
  }, []);

  const rows = useMemo(() => {
    const filtered = filterRows(data.rows, data.columns, filterKey ?? '', filterText);
    if (!sort) return filtered;
    const type = data.columns.find((c) => c.key === sort.key)?.type ?? 'string';
    return sortRows(filtered, sort.key, sort.dir, type);
  }, [data, filterKey, filterText, sort]);

  const onSort = (key: string) =>
    setSort((s) => (s?.key === key ? (s.dir === 'asc' ? { key, dir: 'desc' } : null) : { key, dir: 'asc' }));

  if (!plan && !props.result) return <p className="small muted">Nothing to show. Ask a question in chat first.</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="filters" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Select
          label="Filter on"
          value={filterKey}
          options={data.columns.map((c) => ({ value: c.key, label: c.label || c.key }))}
          onChange={setFilterKey}
          placeholder="All columns"
        />
        <Input label="Contains" value={filterText} onChange={setFilterText} placeholder="Type to filter" />
        <span className="grow" />
        <ExportButton plan={plan} shell={shell} sourceMessageId={props.sourceMessageId ?? null} small={false} />
      </div>
      <p className="small muted" role="status" style={{ margin: 0 }}>
        {rows.length} of {data.rows.length} loaded row{data.rows.length === 1 ? '' : 's'}
        {data.cursor ? ' (more available)' : ''}
        {sort ? ` · sorted by ${data.columns.find((c) => c.key === sort.key)?.label ?? sort.key} ${sort.dir === 'asc' ? 'ascending' : 'descending'}` : ''}
      </p>
      {state.loading && data.rows.length === 0 && <Loading label="Running the query" />}
      {state.error !== undefined && <ErrorNote error={state.error} onRetry={() => void load(data.rows.length ? data.cursor : null)} />}
      {(data.columns.length > 0 || !state.loading) && (
        <DataTable columns={data.columns} rows={rows.slice(0, shown)} shell={shell} sort={sort} onSort={onSort} caption="Query result" />
      )}
      <div className="row">
        {rows.length > shown && (
          <button type="button" className="btn sm" onClick={() => setShown((n) => n + PAGE)}>
            Show {Math.min(PAGE, rows.length - shown)} more
          </button>
        )}
        {data.cursor && plan && (
          <button type="button" className="btn sm" disabled={state.loading} onClick={() => void load(data.cursor)}>
            {state.loading ? 'Loading…' : 'Load more rows'}
          </button>
        )}
      </div>
      {data.how && <HowIGotThis parts={howParts(data.how)} {...(howNote(data.how) ? { note: howNote(data.how) as string } : {})} />}
    </div>
  );
}

export default TablePanel;
