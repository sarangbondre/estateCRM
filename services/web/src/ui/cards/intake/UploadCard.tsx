'use client';
// C-04 Upload (PRD §5.4, US-01, US-02): Attach → (Mapping | duplicate check) → Start → Progress → Report. Intake
// contract: createUpload, inspectUpload, getUpload, patchUpload, listTemplates, putUploadMapping, startUpload,
// cancelUpload, getUploadProgress, listRowErrors, getRejectedRowsLink. The file bytes go straight to the signed
// storage URL returned by createUpload (the only direct call; everything else goes through the gateway).
import { useEffect, useId, useState } from 'react';
import type { DragEvent } from 'react';
import type { operations as IntakeOps } from '@11e/contracts/intake';
import { ActionButton, Card, Chip, Done, ErrorNote, Loading, useAction } from '../Card';
import { Input, Select } from '../common';
import { ApiError, call, newIdempotencyKey, useResource } from '../../lib/api';
import type { Ok } from '../../lib/contract';
import { count, date } from '../../lib/format';
import type { CardProps, ShellActions } from '../../shell/types';
import { usePolled } from './hooks';
import {
  RECORD_SCOPES,
  SOURCE_TYPES,
  STAGES,
  UPLOAD_ACCEPT,
  buildCreateUpload,
  buildMappingBody,
  canCancel,
  etaText,
  fileProblem,
  initialColumnMap,
  isMappingTarget,
  isTerminal,
  MAPPING_TARGETS,
  mappingProblems,
  pollUpload,
  rejectionReasons,
  reportTiles,
  rowErrorLabel,
  stagePercents,
  stepFor,
  targetLabel,
} from './logic';
import type { ColumnMap, Progress, SourceType, Upload } from './logic';

export interface UploadProps {
  /** Upload id or code (UPL-…) to show, e.g. from "UPL-000123" in the composer. */
  upload?: string;
  /** Set by the card once an upload exists, so a reload shows the right step. */
  uploadId?: string;
}

type Templates = Ok<IntakeOps['listTemplates']>;
type Created = Ok<IntakeOps['createUpload']>;
type RowErrors = Ok<IntakeOps['listRowErrors']>;
type Link = Ok<IntakeOps['getRejectedRowsLink']>;

const path = (id: string, sub = '') => `/v1/uploads/${encodeURIComponent(id)}${sub}`;

export function UploadCard({ spec, shell, patch }: CardProps<UploadProps>) {
  const [created, setCreated] = useState<string | null>(null);
  const id = created ?? spec.props.uploadId ?? spec.props.upload ?? null;
  if (!id) {
    return (
      <AttachStep
        shell={shell}
        onCreated={(u) => {
          setCreated(u.id);
          patch({ uploadId: u.id });
        }}
      />
    );
  }
  return <UploadFlow id={id} shell={shell} />;
}

// ---------------------------------------------------------------------------------------------------------------
// Attach

function AttachStep({ shell, onCreated }: { shell: ShellActions; onCreated: (u: Upload) => void }) {
  const pilot = shell.me.environment.pilot;
  const inputId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [sourceType, setSourceType] = useState<SourceType | null>(null);
  const [sourceDetail, setSourceDetail] = useState('');
  const [anonymise, setAnonymise] = useState<boolean>(pilot);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [importCrmNotes, setImportCrmNotes] = useState(false);
  const [phase, setPhase] = useState('');
  const templates = useResource<Templates>('/v1/templates', { limit: 50, ...(sourceType ? { sourceType } : {}) });

  const problem = file ? fileProblem(file) : null;
  const ready = !!file && !problem && !!sourceType;

  const attach = useAction(
    async (key) => {
      if (!file || !sourceType) throw new Error('Choose a file and a source type.');
      const body = buildCreateUpload(file, { sourceType, sourceDetail, anonymise, templateId, importCrmNotes });
      setPhase('Creating the upload');
      const created = (await call<Created>('POST', '/v1/uploads', { body, idempotencyKey: key })).data;
      setPhase('Sending the file');
      await putFile(created.uploadUrl, file, body.contentType);
      setPhase('Checking the file');
      const inspected = await call<Upload>('POST', path(created.upload.id, '/inspect'), {
        idempotencyKey: newIdempotencyKey(),
      });
      return inspected.data ?? created.upload;
    },
    (u) => {
      setPhase('');
      onCreated(u);
    },
  );

  const onDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) setFile(f);
  };

  return (
    <Card
      kicker="Upload"
      title="Attach a sheet"
      footer={
        <>
          <ActionButton primary onClick={() => void attach.run()} pending={attach.pending} disabled={!ready}>
            Upload and check
          </ActionButton>
          {attach.pending && phase && <span className="small muted">{phase}…</span>}
          {attach.error !== undefined && <ErrorNote error={attach.error} onRetry={() => void attach.run()} />}
        </>
      }
    >
      <p className="small muted">
        Excel (.xlsx, .xls) or CSV, up to 50 MB. Lead-form and enquiry exports should be uploaded at least daily so Must
        call can meet its 24 h target.
      </p>
      <label
        className="dropzone"
        htmlFor={inputId}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        style={{ display: 'block' }}
      >
        {file ? (
          <>
            <b>{file.name}</b>
            <br />
            <span className="small">{count(Math.ceil(file.size / 1024))} KB · choose or drop another file to replace it</span>
          </>
        ) : (
          <>Drop a file here, or choose one</>
        )}
        <input
          id={inputId}
          type="file"
          accept={UPLOAD_ACCEPT}
          aria-label="Sheet file"
          style={{ display: 'block', margin: '8px auto 0' }}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>
      {problem && (
        <p role="alert" className="err-note">
          {problem}
        </p>
      )}
      <div className="form-grid">
        <Select
          label="Source type"
          required
          value={sourceType}
          options={SOURCE_TYPES}
          onChange={(v) => setSourceType((SOURCE_TYPES as readonly string[]).includes(v ?? '') ? (v as SourceType) : null)}
        />
        <Input
          label="Source detail"
          value={sourceDetail}
          onChange={setSourceDetail}
          placeholder="e.g. TOI classifieds, Meta lead form"
        />
        <Select
          label="Mapping template (optional)"
          value={templateId}
          placeholder="None"
          options={(templates.data?.items ?? []).slice(0, 50).map((t) => ({ value: t.id, label: t.name }))}
          onChange={setTemplateId}
        />
      </div>
      <PlainCheckbox
        label="Anonymise contacts on import"
        checked={anonymise}
        disabled={pilot}
        onChange={setAnonymise}
        hint={pilot ? 'Always on during the pilot (sample or anonymised data only).' : undefined}
      />
      <PlainCheckbox
        label="Initial import: keep crm_notes as notes"
        checked={importCrmNotes}
        onChange={setImportCrmNotes}
        hint="Only for the one-time import of the old CRM export."
      />
    </Card>
  );
}

async function putFile(url: string, file: File, contentType: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'PUT', headers: { 'content-type': contentType }, body: file });
  } catch {
    throw new ApiError(0, { code: 'upload-failed', detail: 'The file could not be sent. Check your connection and try again.' });
  }
  if (!res.ok) {
    throw new ApiError(res.status, { code: 'upload-failed', detail: `Storage refused the file (${res.status}). Try again.` });
  }
}

function PlainCheckbox({
  label,
  checked,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  hint?: string | undefined;
}) {
  const id = useId();
  return (
    <div className="check">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby={hint ? `${id}-h` : undefined}
      />
      <label htmlFor={id}>{label}</label>
      {hint && (
        <span id={`${id}-h`} className="small faint">
          {' '}
          {hint}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Flow for an existing upload

function UploadFlow({ id, shell }: { id: string; shell: ShellActions }) {
  const up = usePolled<Upload>(path(id), (u) => pollUpload(u?.status), false);
  const u = up.data;
  if (!u) {
    return (
      <Card kicker="Upload" title={id}>
        {up.error !== undefined ? <ErrorNote error={up.error} onRetry={up.reload} /> : <Loading label="Loading the upload" />}
      </Card>
    );
  }
  const step = stepFor(u.status);
  const chips = (
    <>
      {u.code && <Chip>{u.code}</Chip>}
      {u.mode && <Chip>{u.mode === 'strict' ? 'Standard columns' : 'Mapping mode'}</Chip>}
      <Chip tone={step === 'report' ? 'good' : step === 'failed' ? 'bad' : 'plain'}>{String(u.status ?? 'unknown').replace(/_/g, ' ')}</Chip>
    </>
  );
  const common = { upload: u, shell, reload: up.reload };
  return (
    <Card
      kicker={STEP_KICKER[step]}
      title={u.fileName || u.code}
      chips={chips}
      label={`Upload ${u.fileName || u.code}`}
    >
      {up.error !== undefined && <ErrorNote error={up.error} onRetry={up.reload} />}
      {step === 'awaiting_file' && <AwaitingFile {...common} />}
      {step === 'inspecting' && <Inspecting {...common} />}
      {step === 'mapping' && <MappingStep key={`${u.sheetName ?? ''}|${(u.header ?? []).join('\u0001')}`} {...common} />}
      {step === 'ready' && <ReadyStep {...common} />}
      {step === 'duplicate' && <DuplicateStep {...common} />}
      {step === 'progress' && <ProgressStep {...common} />}
      {(step === 'report' || step === 'failed' || step === 'cancelled') && <ReportStep {...common} />}
    </Card>
  );
}

const STEP_KICKER: Record<ReturnType<typeof stepFor>, string> = {
  attach: 'Upload',
  awaiting_file: 'Upload',
  inspecting: 'Upload · checking',
  mapping: 'Upload · mapping',
  ready: 'Upload · ready',
  duplicate: 'Upload · duplicate',
  progress: 'Processing',
  report: 'Report',
  failed: 'Report · failed',
  cancelled: 'Upload · cancelled',
};

interface StepProps {
  upload: Upload;
  shell: ShellActions;
  reload: () => void;
}

function CancelButton({ upload, reload }: StepProps) {
  const cancel = useAction((key) => call<Upload>('POST', path(upload.id, '/cancel'), { idempotencyKey: key }), reload);
  if (!canCancel(upload.status)) return null;
  return (
    <>
      <ActionButton small onClick={() => void cancel.run()} pending={cancel.pending}>
        Cancel upload
      </ActionButton>
      {cancel.error !== undefined && <ErrorNote error={cancel.error} />}
    </>
  );
}

function AwaitingFile(p: StepProps) {
  return (
    <>
      <p className="small">The file did not reach storage, so this upload cannot continue. Start a new upload.</p>
      <div className="row">
        <ActionButton primary onClick={() => p.shell.send('/upload')}>
          New upload
        </ActionButton>
        <CancelButton {...p} />
      </div>
    </>
  );
}

function Inspecting(p: StepProps) {
  return (
    <>
      <Loading label="Checking the file: sheets, header row, standard or mapping mode, duplicates" />
      <div className="row">
        <CancelButton {...p} />
      </div>
    </>
  );
}

// Mapping ------------------------------------------------------------------------------------------------------

function MappingStep({ upload, reload, shell }: StepProps) {
  const header = (upload.header ?? []).slice(0, 200);
  const templates = useResource<Templates>('/v1/templates', { limit: 50, sourceType: upload.sourceType });
  const [templateId, setTemplateId] = useState<string | null>(upload.templateId ?? null);
  const [map, setMap] = useState<ColumnMap>(() =>
    initialColumnMap(header, upload.columnMap ?? upload.suggestedMapping ?? null),
  );
  const [scope, setScope] = useState<string | null>(null);
  const [saveTpl, setSaveTpl] = useState(false);
  const [tplName, setTplName] = useState('');
  const [sheet, setSheet] = useState<string | null>(upload.sheetName ?? null);
  const gridId = useId();
  const problems = mappingProblems(map, scope);
  const sheets = upload.sheetNames ?? [];

  const pickTemplate = (tid: string | null) => {
    setTemplateId(tid);
    const t = templates.data?.items.find((x) => x.id === tid);
    if (t) setMap(initialColumnMap(header, upload.suggestedMapping ?? null, t.columnMap));
  };

  const changeSheet = useAction(
    () =>
      call<Upload>('PATCH', path(upload.id), {
        body: { sheetName: sheet },
        contentType: 'application/merge-patch+json',
        ifMatch: upload.version,
      }),
    reload,
  );

  const save = useAction(
    () =>
      call<Upload>('PUT', path(upload.id, '/mapping'), {
        body: buildMappingBody({
          columnMap: map,
          sheetName: upload.sheetName ?? null,
          constantRecordScope: scope,
          templateId,
          saveAsTemplate: saveTpl ? tplName : null,
        }),
        ifMatch: upload.version,
      }),
    () => {
      shell.toast('Mapping saved');
      reload();
    },
  );

  const scopeMapped = Object.values(map).includes('record_scope');

  return (
    <>
      <p className="small">
        These columns are not the standard layout. Map each column to a field, or leave it ignored. Suggestions are
        filled in; nothing is saved until you press Save mapping.
      </p>
      {sheets.length > 1 && (
        <div className="row">
          <Select label="Sheet" value={sheet} options={sheets} onChange={setSheet} />
          <ActionButton
            small
            onClick={() => void changeSheet.run()}
            pending={changeSheet.pending}
            disabled={!sheet || sheet === upload.sheetName}
          >
            Use this sheet
          </ActionButton>
          {changeSheet.error !== undefined && <ErrorNote error={changeSheet.error} />}
        </div>
      )}
      <Select
        label="Start from a template"
        value={templateId}
        placeholder="No template"
        options={(templates.data?.items ?? []).map((t) => ({ value: t.id, label: t.name }))}
        onChange={pickTemplate}
      />
      {header.length === 0 ? (
        <p className="small muted">No header row was found in this sheet.</p>
      ) : (
        <div className="map-grid" role="group" aria-label="Column mapping">
          {header.map((h, i) => (
            <div key={`${h}-${i}`}>
              <label className="col" htmlFor={`${gridId}-${i}`} title={h}>
                {h || `(column ${i + 1})`}
              </label>
              <select
                id={`${gridId}-${i}`}
                value={map[h] ?? ''}
                onChange={(e) => {
                  const v = e.target.value;
                  setMap((m) => ({ ...m, [h]: isMappingTarget(v) ? v : null }));
                }}
              >
                <option value="">Ignore</option>
                {MAPPING_TARGETS.map((t) => (
                  <option key={t} value={t}>
                    {targetLabel(t)}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}
      {!scopeMapped && (
        <Select
          label="Record scope for the whole file"
          value={scope}
          options={RECORD_SCOPES}
          onChange={setScope}
          placeholder="Choose (no column maps to record scope)"
        />
      )}
      <PlainCheckbox label="Save as a template for this source" checked={saveTpl} onChange={setSaveTpl} />
      {saveTpl && <Input label="Template name" required value={tplName} onChange={setTplName} />}
      {problems.length > 0 && (
        <ul className="small wn" aria-live="polite">
          {problems.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
      <div className="row">
        <ActionButton
          primary
          onClick={() => void save.run()}
          pending={save.pending}
          disabled={problems.length > 0 || (saveTpl && !tplName.trim())}
        >
          Save mapping
        </ActionButton>
        <CancelButton upload={upload} reload={reload} shell={shell} />
      </div>
      {save.error !== undefined && <ErrorNote error={save.error} onRetry={() => void save.run()} />}
    </>
  );
}

// Ready / duplicate / start --------------------------------------------------------------------------------------

function useStart(upload: Upload, reload: () => void, allowDuplicate: boolean) {
  return useAction(async (key) => {
    try {
      return await call<Upload>('POST', path(upload.id, '/start'), {
        body: allowDuplicate ? { allowDuplicate: true } : {},
        idempotencyKey: key,
      });
    } catch (err) {
      // The service moves the upload to awaiting_duplicate_confirmation; show that step instead of an error.
      if (err instanceof ApiError && err.code === 'duplicate-upload') return null;
      throw err;
    }
  }, reload);
}

function ReadyStep(p: StepProps) {
  const { upload, reload } = p;
  const [editing, setEditing] = useState(false);
  const start = useStart(upload, reload, false);
  const mapped = Object.values(upload.columnMap ?? {}).filter(Boolean).length;
  if (editing && upload.mode === 'mapping') {
    return (
      <>
        <MappingStep
          {...p}
          reload={() => {
            setEditing(false);
            reload();
          }}
        />
        <button type="button" className="btn ghost sm" onClick={() => setEditing(false)}>
          Keep the saved mapping
        </button>
      </>
    );
  }
  return (
    <>
      <p className="small">
        {upload.mode === 'strict'
          ? 'Standard columns found (strict mode): values outside the controlled lists will be rejected and listed in the report.'
          : `Mapping saved: ${mapped} column${mapped === 1 ? '' : 's'} mapped. Legacy terms are translated; rows that cannot be translated go to review.`}
        {upload.hasMigrationMap ? ' The migration_map sheet will be applied first.' : ''}
      </p>
      <p className="small muted">
        Processing runs in the background; you can keep working. Contacts are {upload.anonymise ? '' : 'not '}anonymised.
      </p>
      <div className="row">
        <ActionButton primary onClick={() => void start.run()} pending={start.pending}>
          Start processing
        </ActionButton>
        {upload.mode === 'mapping' && (
          <ActionButton small onClick={() => setEditing(true)}>
            Change mapping
          </ActionButton>
        )}
        <CancelButton {...p} />
      </div>
      {start.error !== undefined && <ErrorNote error={start.error} onRetry={() => void start.run()} />}
    </>
  );
}

function DuplicateStep(p: StepProps) {
  const { upload, reload } = p;
  const start = useStart(upload, reload, true);
  return (
    <>
      <p className="small">
        This exact file was already processed{upload.duplicateOfUploadId ? ' in an earlier upload' : ''}. Processing it
        again is safe (unchanged rows are skipped), but it is usually not needed.
      </p>
      <div className="row">
        <ActionButton primary onClick={() => void start.run()} pending={start.pending}>
          Process anyway
        </ActionButton>
        <CancelButton {...p} />
      </div>
      {start.error !== undefined && <ErrorNote error={start.error} onRetry={() => void start.run()} />}
    </>
  );
}

// Progress -------------------------------------------------------------------------------------------------------

function ProgressStep(p: StepProps) {
  const { upload, reload } = p;
  const prog = usePolled<Progress>(path(upload.id, '/progress'), (d) => !isTerminal(d?.status), true);
  const d = prog.data;
  const finished = isTerminal(d?.status);
  // Once the progress says finished, re-read the upload so the report shows.
  useEffect(() => {
    if (finished) reload();
  }, [finished, reload]);
  const bars = stagePercents({
    status: d?.status ?? upload.status,
    stage: d?.stage ?? upload.stage ?? null,
    chunksDone: d?.chunksDone ?? upload.chunksDone ?? 0,
    chunkCount: d?.chunkCount ?? upload.chunkCount ?? null,
  });
  const eta = etaText(d?.etaSeconds);
  return (
    <>
      <div aria-live="polite">
        {STAGES.map((s, k) => (
          <div className="stage" key={s.key}>
            <span>{s.label}</span>
            <div
              className="track"
              role="progressbar"
              aria-label={s.label}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={bars[k] ?? 0}
            >
              <i style={{ width: `${bars[k] ?? 0}%` }} />
            </div>
            <span className="num small muted" style={{ textAlign: 'right' }}>
              {bars[k] ?? 0}%
            </span>
          </div>
        ))}
      </div>
      <p className="small muted">
        {(d?.status ?? upload.status) === 'queued' ? 'Queued. ' : ''}
        {d ? `${count(d.counts?.read)} rows read so far` : ''}
        {d?.chunksFailed ? ` · ${count(d.chunksFailed)} chunks failed` : ''}
        {eta ? ` · ${eta}` : ''}
      </p>
      {prog.error !== undefined && <ErrorNote error={prog.error} onRetry={prog.reload} />}
      <div className="row">
        <CancelButton {...p} />
        <span className="small faint">Batches already processed stay applied if you cancel.</span>
      </div>
    </>
  );
}

// Report ---------------------------------------------------------------------------------------------------------

function ReportStep({ upload, shell }: StepProps) {
  const rejected = upload.counts?.rejected ?? 0;
  const errors = useResource<RowErrors>(rejected > 0 ? path(upload.id, '/row-errors') : null, { limit: 50 });
  const reasons = rejectionReasons(errors.data?.items ?? []);
  const canDownload =
    upload.uploadedBy === shell.me.userId ||
    ['Admin', 'Manager', 'Data operator'].includes(shell.me.role) ||
    shell.me.isDataOperator;
  const [link, setLink] = useState<Link | null>(null);
  const download = useAction(
    async () => (await call<Link>('GET', path(upload.id, '/rejected-rows'))).data,
    (l) => {
      setLink(l);
      window.open(l.url, '_blank', 'noopener,noreferrer');
    },
  );
  const tiles = reportTiles(upload.counts);
  const needsReview = upload.counts?.needsReview ?? 0;
  return (
    <>
      {upload.status === 'failed' && (
        <p role="alert" className="err-note">
          Processing failed{upload.failureReason ? `: ${upload.failureReason}` : '.'} Rows already processed stay applied.
        </p>
      )}
      {upload.status === 'cancelled' && <p className="small">This upload was cancelled. Rows already processed stay applied.</p>}
      {upload.status === 'completed' && (
        <Done>
          Finished{upload.completedAt ? ` ${date(upload.completedAt, true)}` : ''}. Rows needing review are already loaded
          and routed.
        </Done>
      )}
      <div className="report">
        {tiles.map(([label, n]) => (
          <div key={label}>
            {label}
            <b>{count(n)}</b>
          </div>
        ))}
      </div>
      {rejected > 0 && (
        <section aria-label="Rejection reasons">
          <div className="qh">Why rows were rejected</div>
          {errors.error !== undefined && <ErrorNote error={errors.error} onRetry={errors.reload} />}
          {errors.loading && !errors.data && <Loading label="Loading rejection reasons" />}
          {reasons.length > 0 && (
            <>
              <div className="row">
                {reasons.map((r) => (
                  <Chip key={r.code} tone="warn">
                    {r.label}: {count(r.count)}
                  </Chip>
                ))}
              </div>
              <table className="small">
                <thead>
                  <tr>
                    <th scope="col">Row</th>
                    <th scope="col">Field</th>
                    <th scope="col">Problem</th>
                    <th scope="col">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {(errors.data?.items ?? []).slice(0, 10).map((e) => (
                    <tr key={e.id}>
                      <td className="num">{e.rowNo}</td>
                      <td className="mono">{e.field}</td>
                      <td>{e.message || rowErrorLabel(e.code)}</td>
                      <td>{e.value ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="small faint">
                {errors.data?.nextCursor ? 'Showing reasons from the first 50 errors. ' : ''}The download has every
                rejected row with an error column.
              </p>
            </>
          )}
        </section>
      )}
      <div className="row">
        {rejected > 0 && (
          <ActionButton onClick={() => void download.run()} pending={download.pending} disabled={!canDownload}>
            Download rejected rows
          </ActionButton>
        )}
        <ActionButton primary={needsReview > 0} onClick={() => shell.send('/review')}>
          Review follow-ups{needsReview > 0 ? ` (${count(needsReview)})` : ''}
        </ActionButton>
        <ActionButton small onClick={() => shell.send('/upload')}>
          Upload another file
        </ActionButton>
      </div>
      {link && (
        <p className="small muted" role="status">
          Download started ({count(link.rowCount)} rows). The link works until {date(link.expiresAt, true)}.{' '}
          <a href={link.url} target="_blank" rel="noopener noreferrer">
            Open it again
          </a>
        </p>
      )}
      {download.error !== undefined && <ErrorNote error={download.error} />}
    </>
  );
}
