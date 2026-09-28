'use client';
// "My exports" card (PRD §5.4 /exports, US-32): my exports newest first with status chips, a download link when ready
// (signed URL valid 10 min, file kept 24 h), one export followed live when opened by code, and a form to start an
// export from an allowed list template. insight: listExports, getExport, createExport, getPlanCatalogue.
import { useEffect, useState } from 'react';
import type { operations } from '@11e/contracts/insight';
import { ApiError, call, get, useResource } from '../../lib/api';
import type { Body, Ok } from '../../lib/contract';
import { count, relative } from '../../lib/format';
import type { CardProps, ShellActions } from '../../shell/types';
import { ActionButton, Card, Chip, Done, ErrorNote, Loading, useAction } from '../Card';
import { Checkbox, Input, Select, usePaged } from '../common';
import { canExportContacts, cleanFileName, exportPending, exportTone } from './logic';
import type { Export, QueryPlan } from './logic';

interface Props {
  export?: string;
  plan?: QueryPlan;
}

function statusText(e: Export): string {
  switch (e.status) {
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Running';
    case 'completed':
      return 'Ready';
    case 'failed':
      return 'Failed';
    case 'expired':
      return 'Expired';
    default:
      return String(e.status ?? 'Unknown');
  }
}

function DownloadLink({ e }: { e: Export }) {
  const [url, setUrl] = useState<string | null>(e.downloadUrl ?? null);
  const [state, setState] = useState<{ pending: boolean; error?: unknown; gone?: boolean }>({ pending: false });
  if (e.status !== 'completed') return null;
  if (state.gone) return <span className="small muted">Expired</span>;
  if (url)
    return (
      <a className="btn sm primary" href={url} download={e.fileName ?? true} rel="noopener">
        Download
      </a>
    );
  const fetchLink = async () => {
    setState({ pending: true });
    try {
      const fresh = await get<Ok<operations['getExport']>>(`/v1/exports/${encodeURIComponent(e.exportId || e.code)}`);
      setUrl(fresh.downloadUrl ?? null);
      setState({ pending: false, ...(fresh.downloadUrl ? {} : { gone: fresh.status === 'expired' }) });
    } catch (error) {
      setState({ pending: false, error, ...(error instanceof ApiError && error.status === 410 ? { gone: true } : {}) });
    }
  };
  return (
    <>
      {state.error !== undefined && !state.gone && <ErrorNote error={state.error} />}
      <ActionButton small onClick={fetchLink} pending={state.pending}>
        Get download link
      </ActionButton>
    </>
  );
}

function ExportLine({ e }: { e: Export }) {
  const rows = e.rowCount ?? e.estimatedRows;
  return (
    <div className="qitem2">
      <div className="grow">
        <b className="mono">{e.code}</b> <span>{e.fileName ?? ''}</span>
        <div className="small muted">
          {rows != null ? `${count(rows)} rows · ` : ''}
          {e.includesContacts ? 'with contacts · ' : ''}
          started {relative(e.createdAt)}
          {e.status === 'completed' && e.expiresAt ? ` · link until ${relative(e.expiresAt)}` : ''}
          {e.status === 'failed' && e.errorCode ? ` · ${e.errorCode.replace(/-/g, ' ')}` : ''}
        </div>
      </div>
      <Chip tone={exportTone(e.status)}>{statusText(e)}</Chip>
      <DownloadLink key={`${e.exportId}-${e.status}`} e={e} />
    </div>
  );
}

/** One export followed live (polls while queued or running). */
function FollowExport({ id }: { id: string }) {
  const [live, setLive] = useState(true);
  const res = useResource<Ok<operations['getExport']>>(`/v1/exports/${encodeURIComponent(id)}`, undefined, live ? 4000 : undefined);
  const status = res.data?.status;
  useEffect(() => {
    if (status && !exportPending(status)) setLive(false);
  }, [status]);
  useEffect(() => {
    if (res.error !== undefined && !res.data) setLive(false);
  }, [res.error, res.data]);
  if (!res.data && res.loading) return <Loading label={`Loading ${id}`} />;
  if (!res.data) {
    const gone = res.error instanceof ApiError && res.error.status === 410;
    return gone ? (
      <p className="small muted">{id} has expired (files are kept 24 hours). Start a new export.</p>
    ) : (
      <ErrorNote
        error={res.error}
        onRetry={() => {
          setLive(true);
          res.reload();
        }}
      />
    );
  }
  return <ExportLine e={res.data} />;
}

function CreateExport({ shell, onCreated, plan }: { shell: ShellActions; onCreated: (e: Export) => void; plan?: QueryPlan }) {
  const catalogue = useResource<Ok<operations['getPlanCatalogue']>>(plan ? null : '/v1/chat/plan-catalogue');
  const templates = (catalogue.data?.items ?? []).filter((t) => t.kind === 'list' || t.kind === 'export').slice(0, 50);
  const [planId, setPlanId] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [contacts, setContacts] = useState(false);
  const chosen: QueryPlan | null = plan ?? (() => {
    const t = templates.find((x) => x.planId === planId);
    return t ? { planId: t.planId, templateVersion: t.version } : null;
  })();
  const allowContacts = canExportContacts(shell.me.role);

  const create = useAction(
    (key) => {
      const body: Body<operations['createExport']> = {
        plan: chosen as QueryPlan,
        includeContacts: allowContacts && contacts,
        ...(cleanFileName(fileName) ? { fileName: cleanFileName(fileName) } : {}),
      };
      return call<Ok<operations['createExport']>>('POST', '/v1/exports', { body, idempotencyKey: key });
    },
    (r) => onCreated(r.data),
  );

  return (
    <form
      onSubmit={(ev) => {
        ev.preventDefault();
        if (chosen) void create.run();
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <div className="qh">New export</div>
      {!plan && catalogue.loading && <Loading label="Loading lists" />}
      {!plan && catalogue.error !== undefined && <ErrorNote error={catalogue.error} onRetry={catalogue.reload} />}
      <div className="form-grid">
        {plan ? (
          <p className="small" style={{ margin: 0 }}>
            List: <span className="mono">{plan.planId}</span>
          </p>
        ) : (
          <Select
            label="List"
            value={planId}
            required
            options={templates.map((t) => ({ value: t.planId, label: t.description || t.planId }))}
            onChange={setPlanId}
          />
        )}
        <Input label="File name" value={fileName} onChange={setFileName} placeholder="e.g. Andheri 2 BHK rentals" />
      </div>
      {allowContacts && (
        <Checkbox label="Include contact columns (audit-logged)" checked={contacts} onChange={setContacts} />
      )}
      {create.error !== undefined && <ErrorNote error={create.error} />}
      <div className="row">
        <span className="grow" />
        <ActionButton type="submit" primary pending={create.pending} disabled={!chosen}>
          Start export
        </ActionButton>
      </div>
      <p className="small faint" style={{ margin: 0 }}>
        Up to 20,000 rows in the pilot. You get a notification when the file is ready; the link works for 24 hours.
      </p>
    </form>
  );
}

function ExportsCard({ spec, shell, patch }: CardProps<Props>) {
  const focus = spec.props.export ?? null;
  const list = usePaged<Export>('/v1/exports', { limit: 20 });
  const [creating, setCreating] = useState(!!spec.props.plan);
  const [created, setCreated] = useState<string | null>(null);

  return (
    <Card
      kicker="Exports"
      title={focus ? `Export ${focus}` : 'My exports'}
      footer={
        <>
          {created && <Done>Export {created} started</Done>}
          <span className="grow" />
          <button type="button" className="btn sm" onClick={() => list.reload()}>
            Refresh
          </button>
          {!creating && (
            <button type="button" className="btn sm" onClick={() => setCreating(true)}>
              New export
            </button>
          )}
        </>
      }
    >
      {focus && <FollowExport id={focus} />}
      {creating && (
        <CreateExport
          shell={shell}
          {...(spec.props.plan ? { plan: spec.props.plan } : {})}
          onCreated={(e) => {
            setCreating(false);
            setCreated(e.code);
            if (!focus && e.code) patch({ export: e.code });
            void list.reload();
          }}
        />
      )}
      {focus && <div className="qh">All my exports</div>}
      {list.loading && list.items.length === 0 && <Loading label="Loading exports" />}
      {list.error !== undefined && <ErrorNote error={list.error} onRetry={() => void list.reload()} />}
      {!list.loading && list.items.length === 0 && list.error === undefined && (
        <p className="small muted" style={{ margin: 0 }}>
          No exports yet. Ask a question and use Excel on the table, or start one here.
        </p>
      )}
      {list.items
        .filter((e) => !focus || (e.code !== focus && e.exportId !== focus))
        .slice(0, 50)
        .map((e) => (
          <ExportLine key={e.exportId ?? e.code} e={e} />
        ))}
      {list.hasMore && list.items.length < 50 && (
        <button type="button" className="btn sm" onClick={() => void list.more()} disabled={list.loading}>
          Load more
        </button>
      )}
    </Card>
  );
}

export default ExportsCard;
