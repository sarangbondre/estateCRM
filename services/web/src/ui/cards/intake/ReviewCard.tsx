'use client';
// C-05 Review (PRD §5.4, US-07a AC5, US-07, US-08, US-09, BRD §4.7): review cards grouped by review reason. Intake:
// getReviewSummary, listReviewItems, resolveReviewItem, bulkResolveReviewItems. Records: listMergeCandidates,
// mergeRecords, dismissMergeCandidate (uncertain merges) and listPriceGaps, resolveSecondSource (price gaps).
// Review never blocks routing: the rows are already loaded and routed; a fix updates them.
import { useState } from 'react';
import type { operations as IntakeOps } from '@11e/contracts/intake';
import type { operations as RecordsOps } from '@11e/contracts/records';
import { ActionButton, Card, Chip, Done, ErrorNote, Loading, useAction } from '../Card';
import { KV, RecordLink, Select, VocabSelect, usePaged } from '../common';
import { call, useResource } from '../../lib/api';
import type { Ok } from '../../lib/contract';
import { count, date, relative } from '../../lib/format';
import { useVocabulary } from '../../lib/vocabulary';
import type { CardProps, ShellActions } from '../../shell/types';
import {
  BULK_MAX,
  SIDES,
  buildBulk,
  buildMerge,
  buildResolve,
  canReview,
  classificationText,
  dealTypeOptions,
  draftForReason,
  draftFrom,
  draftMissing,
  evidenceRows,
  fieldsFor,
  gapText,
  mergeReasonLabel,
  reasonHint,
  recordScopeOptions,
  reviewGroups,
  scorePct,
  sourcePriceText,
} from './logic';
import type { ClassDraft, ClassField, MergeCandidate, ReviewGroupKey, ReviewItem, SecondSource } from './logic';

export interface ReviewProps {
  /** Group to open first (a reason code, uncertain_merge or price_gap). */
  group?: string;
}

type Summary = Ok<IntakeOps['getReviewSummary']>;
type MergePage = Ok<RecordsOps['listMergeCandidates']>;
type GapPage = Ok<RecordsOps['listPriceGaps']>;
type BulkResult = Ok<IntakeOps['bulkResolveReviewItems']>;

const ROUTING_HINT = 'Review never blocks routing: these rows are already loaded and routed; a fix updates them (BRD §4.7).';

export function ReviewCard({ spec, shell, patch }: CardProps<ReviewProps>) {
  if (!canReview(shell.me)) {
    return (
      <Card kicker="Review" title="Review queue">
        <p className="small muted">
          The review queue is worked by Admins, Managers and Data operators, so it is not shown for your role. Ask your
          manager if you should have the Data operator permission.
        </p>
      </Card>
    );
  }
  return <ReviewQueue initial={spec.props.group ?? null} shell={shell} onGroup={(group) => patch({ group })} />;
}

function ReviewQueue({
  initial,
  shell,
  onGroup,
}: {
  initial: string | null;
  shell: ShellActions;
  onGroup: (g: string) => void;
}) {
  const summary = useResource<Summary>('/v1/review-items/summary');
  const merges = useResource<MergePage>('/v1/merge-candidates', { status: 'open', limit: 50 });
  const gaps = useResource<GapPage>('/v1/second-sources', { status: 'open', priceGap: true, limit: 50 });
  const groups = reviewGroups(summary.data?.groups, {
    merges: merges.data ? { open: merges.data.items?.length ?? 0, more: !!merges.data.nextCursor } : null,
    priceGaps: gaps.data ? { open: gaps.data.items?.length ?? 0, more: !!gaps.data.nextCursor } : null,
  });
  const [picked, setPicked] = useState<string | null>(initial);
  const current = groups.find((g) => g.key === picked) ?? groups[0] ?? null;
  const loading = (summary.loading && !summary.data) || (merges.loading && !merges.data) || (gaps.loading && !gaps.data);
  const reloadAll = () => {
    summary.reload();
    merges.reload();
    gaps.reload();
  };
  const total = groups.reduce((n, g) => n + g.open, 0);

  return (
    <Card
      kicker="Review"
      title="Review queue"
      chips={total > 0 ? <Chip tone="warn">{count(total)} open</Chip> : undefined}
      footer={
        <>
          <ActionButton small onClick={reloadAll}>
            Refresh
          </ActionButton>
          <span className="small faint">{ROUTING_HINT}</span>
        </>
      }
    >
      {summary.error !== undefined && <ErrorNote error={summary.error} onRetry={summary.reload} />}
      {merges.error !== undefined && <ErrorNote error={merges.error} onRetry={merges.reload} />}
      {gaps.error !== undefined && <ErrorNote error={gaps.error} onRetry={gaps.reload} />}
      {loading && groups.length === 0 && <Loading label="Loading the review queue" />}
      {!loading && groups.length === 0 && <Done>Nothing to review right now.</Done>}
      {groups.length > 0 && (
        <div className="row" role="group" aria-label="Review groups" style={{ flexWrap: 'wrap' }}>
          {groups.map((g) => (
            <button
              key={g.key}
              type="button"
              className={`btn sm${current?.key === g.key ? ' primary' : ''}`}
              aria-pressed={current?.key === g.key}
              onClick={() => {
                setPicked(g.key);
                onGroup(g.key);
              }}
            >
              {g.label} · {count(g.open)}
              {g.more ? '+' : ''}
            </button>
          ))}
        </div>
      )}
      {current && (
        <section aria-label={current.label}>
          <div className="qh">
            {current.label}
            {current.oldestAt ? <span className="small faint"> · oldest {relative(current.oldestAt)}</span> : null}
          </div>
          <p className="small muted">{reasonHint(current.key)}</p>
          <GroupBody key={current.key} group={current.key} shell={shell} onChanged={reloadAll} />
        </section>
      )}
    </Card>
  );
}

function GroupBody({ group, shell, onChanged }: { group: ReviewGroupKey; shell: ShellActions; onChanged: () => void }) {
  if (group === 'uncertain_merge') return <MergeList shell={shell} onChanged={onChanged} />;
  if (group === 'price_gap') return <PriceGapList onChanged={onChanged} />;
  return <ReasonList reason={group} shell={shell} onChanged={onChanged} />;
}

// ---------------------------------------------------------------------------------------------------------------
// Classification review items (intake)

function ReasonList({ reason, shell, onChanged }: { reason: string; shell: ShellActions; onChanged: () => void }) {
  const list = usePaged<ReviewItem>('/v1/review-items', { reasonCode: reason, status: 'open', limit: 20 });
  const [closed, setClosed] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const open = list.items.filter((i) => !closed[i.id]);
  const close = (ids: string[], text: string) => {
    setClosed((c) => ({ ...c, ...Object.fromEntries(ids.map((id) => [id, text])) }));
    setSelected((s) => s.filter((x) => !ids.includes(x)));
    onChanged();
  };
  const [bulkNote, setBulkNote] = useState<string | null>(null);
  const bulk = useAction(
    (key) =>
      call<BulkResult>('POST', '/v1/review-items/bulk-resolve', {
        body: buildBulk(selected, 'confirm'),
        idempotencyKey: key,
      }),
    (r) => {
      const resolved = r.data.resolved ?? [];
      const failed = r.data.failed ?? [];
      close(resolved, 'Confirmed');
      setBulkNote(`${count(resolved.length)} confirmed${failed.length ? `, ${count(failed.length)} already closed or failed` : ''}.`);
    },
  );
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => (on ? (s.includes(id) || s.length >= BULK_MAX ? s : [...s, id]) : s.filter((x) => x !== id)));

  return (
    <>
      {list.error !== undefined && <ErrorNote error={list.error} onRetry={() => void list.reload()} />}
      {list.loading && list.items.length === 0 && <Loading label="Loading review items" />}
      {!list.loading && list.items.length === 0 && list.error === undefined && (
        <p className="small muted">No open items in this group.</p>
      )}
      {open.length > 1 && (
        <div className="row">
          <div className="check">
            <input
              id={`all-${reason}`}
              type="checkbox"
              checked={selected.length > 0 && selected.length === Math.min(open.length, BULK_MAX)}
              onChange={(e) => setSelected(e.target.checked ? open.slice(0, BULK_MAX).map((i) => i.id) : [])}
            />
            <label htmlFor={`all-${reason}`}>Select all shown</label>
          </div>
          <ActionButton small onClick={() => void bulk.run()} pending={bulk.pending} disabled={selected.length === 0}>
            Confirm current values ({count(selected.length)})
          </ActionButton>
          {bulkNote && <Done>{bulkNote}</Done>}
        </div>
      )}
      {bulk.error !== undefined && <ErrorNote error={bulk.error} onRetry={() => void bulk.run()} />}
      {list.items.map((item) =>
        closed[item.id] ? (
          <div key={item.id} className="qitem2">
            <Done>
              {item.uploadCode ?? 'Row'} {item.rowNo != null ? `row ${item.rowNo}` : item.externalRef}: {closed[item.id]}
            </Done>
          </div>
        ) : (
          <ReviewItemRow
            key={item.id}
            item={item}
            reason={reason}
            shell={shell}
            selected={selected.includes(item.id)}
            onSelect={(on) => toggle(item.id, on)}
            onClosed={(text) => close([item.id], text)}
          />
        ),
      )}
      {list.hasMore && (
        <ActionButton small onClick={() => void list.more()} pending={list.loading}>
          Load more
        </ActionButton>
      )}
    </>
  );
}

function useResolveItem(
  item: ReviewItem,
  action: 'set' | 'confirm' | 'discard' | 'skip',
  draft: ClassDraft,
  onDone: () => void,
) {
  return useAction(
    (key) =>
      call<ReviewItem>('POST', `/v1/review-items/${encodeURIComponent(item.id)}/resolve`, {
        body: buildResolve(action, { current: item.current, draft }),
        idempotencyKey: key,
        ifMatch: item.version,
      }),
    onDone,
  );
}

function useDismissCandidate(id: string, decision: 'different' | 'skipped', onDone: () => void) {
  return useAction(
    (key) =>
      call('POST', `/v1/merge-candidates/${encodeURIComponent(id)}/dismiss`, { body: { decision }, idempotencyKey: key }),
    onDone,
  );
}

function useResolveGap(id: string, action: 'accept_price' | 'dismiss', onDone: () => void) {
  return useAction(
    (key) => call('POST', `/v1/second-sources/${encodeURIComponent(id)}/resolve`, { body: { action }, idempotencyKey: key }),
    onDone,
  );
}

const FIELD_LABEL: Record<ClassField, string> = {
  recordScope: 'Record scope',
  side: 'Side',
  dealType: 'Deal type',
  market: 'Market',
  segment: 'Segment',
  propertyType: 'Property type',
};

function ReviewItemRow({
  item,
  reason,
  shell,
  selected,
  onSelect,
  onClosed,
}: {
  item: ReviewItem;
  reason: string;
  shell: ShellActions;
  selected: boolean;
  onSelect: (on: boolean) => void;
  onClosed: (text: string) => void;
}) {
  const { vocab } = useVocabulary();
  const [draft, setDraft] = useState<ClassDraft>(() => draftFrom(item));
  const fields = fieldsFor(reason);
  const scoped = draftForReason(reason, draft);
  const missing = draftMissing(reason, draft);
  const set = (f: ClassField) => (v: string | null) =>
    setDraft((d) => {
      const next = { ...d, [f]: v };
      if (f === 'segment') next.propertyType = null;
      if (f === 'recordScope') next.dealType = null;
      return next;
    });
  const apply = useResolveItem(item, 'set', scoped, () => onClosed('Fixed'));
  const confirm = useResolveItem(item, 'confirm', scoped, () => onClosed('Confirmed as is'));
  const discard = useResolveItem(item, 'discard', scoped, () => onClosed('Marked as not a record'));
  const skip = useResolveItem(item, 'skip', scoped, () => onClosed('Skipped for now'));
  const error = [apply, confirm, discard, skip].find((a) => a.error !== undefined)?.error;
  const busy = apply.pending || confirm.pending || discard.pending || skip.pending;
  const dealType = draft.dealType ?? null;
  const ctx = item.context ?? {};
  const cbId = `sel-${item.id}`;

  const control = (f: ClassField) => {
    switch (f) {
      case 'recordScope':
        return <Select key={f} label={FIELD_LABEL[f]} value={draft.recordScope} options={recordScopeOptions(vocab)} onChange={set(f)} />;
      case 'side':
        return <Select key={f} label={FIELD_LABEL[f]} value={draft.side} options={SIDES} onChange={set(f)} />;
      case 'dealType':
        return (
          <Select
            key={f}
            label={FIELD_LABEL[f]}
            value={draft.dealType}
            options={dealTypeOptions(vocab, draft.recordScope ?? item.current?.recordScope)}
            onChange={set(f)}
          />
        );
      case 'market':
        return dealType === 'Sale' ? (
          <VocabSelect key={f} field="market" label={FIELD_LABEL[f]} value={draft.market} onChange={set(f)} />
        ) : null;
      case 'segment':
        return <VocabSelect key={f} field="segment" label={FIELD_LABEL[f]} value={draft.segment} onChange={set(f)} />;
      case 'propertyType':
        return (
          <VocabSelect
            key={f}
            field="property_type"
            label={FIELD_LABEL[f]}
            value={draft.propertyType}
            segment={draft.segment ?? null}
            onChange={set(f)}
          />
        );
    }
  };

  return (
    <article
      aria-label={`Review item ${item.externalRef}`}
      style={{ borderBottom: '1px dashed var(--line)', padding: '10px 0' }}
    >
      <div className="row">
        <div className="check">
          <input id={cbId} type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} />
          <label htmlFor={cbId} className="sr-only">
            Select {item.externalRef}
          </label>
        </div>
        <b className="mono">{item.uploadCode ? <RecordLink code={item.uploadCode} shell={shell} /> : 'Row'}</b>
        {item.rowNo != null && <span className="small muted">row {item.rowNo}</span>}
        <span className="small faint mono">{item.externalRef}</span>
        <span className="grow" />
        <span className="small faint">{relative(item.createdAt)}</span>
      </div>
      {item.reviewReasonText && <p className="small">“{item.reviewReasonText}”</p>}
      <KV
        rows={[
          ['Now', classificationText(item.current)],
          ...(item.suggested ? ([['Suggested', classificationText(item.suggested)]] as [string, string][]) : []),
          ['Where', [ctx.locality, ctx.city].filter(Boolean).join(', ')],
          ['Price / area', [ctx.priceText, ctx.areaText].filter(Boolean).join(' · ')],
          ...(ctx.sideEvidence ? ([['Side evidence', ctx.sideEvidence]] as [string, string][]) : []),
        ]}
      />
      {ctx.redactedText && (
        <details>
          <summary className="small">Original text (contacts hidden)</summary>
          <p className="small muted" style={{ whiteSpace: 'pre-wrap' }}>
            {ctx.redactedText.slice(0, 2000)}
          </p>
        </details>
      )}
      <div className="form-grid">{fields.map(control)}</div>
      <div className="row">
        <ActionButton
          primary
          small
          onClick={() => void apply.run()}
          pending={apply.pending}
          disabled={busy || missing.length > 0}
        >
          Apply
        </ActionButton>
        <ActionButton small onClick={() => void confirm.run()} pending={confirm.pending} disabled={busy}>
          Confirm as is
        </ActionButton>
        <ActionButton small onClick={() => void skip.run()} pending={skip.pending} disabled={busy}>
          Skip
        </ActionButton>
        <span className="grow" />
        <ActionButton small danger onClick={() => void discard.run()} pending={discard.pending} disabled={busy}>
          Not a real record
        </ActionButton>
      </div>
      {missing.length > 0 && (
        <p className="small faint">Choose {missing.map((f) => FIELD_LABEL[f].toLowerCase()).join(', ')} to apply.</p>
      )}
      {error !== undefined && <ErrorNote error={error} />}
    </article>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Uncertain merges (records)

const AGGREGATE_Q: Record<string, string> = {
  property: 'Supply · same property?',
  offer: 'Supply · same offer?',
  demand: 'Demand · same client?',
  person: 'Contact · same person?',
};

function MergeList({ shell, onChanged }: { shell: ShellActions; onChanged: () => void }) {
  const list = usePaged<MergeCandidate>('/v1/merge-candidates', { status: 'open', limit: 20 });
  const [closed, setClosed] = useState<Record<string, string>>({});
  return (
    <>
      {list.error !== undefined && <ErrorNote error={list.error} onRetry={() => void list.reload()} />}
      {list.loading && list.items.length === 0 && <Loading label="Loading uncertain merges" />}
      {list.items.map((c) =>
        closed[c.id] ? (
          <div key={c.id} className="qitem2">
            <Done>
              {c.leftCode ?? 'Record'}: {closed[c.id]}
            </Done>
          </div>
        ) : (
          <MergeRow
            key={c.id}
            c={c}
            shell={shell}
            onClosed={(t) => {
              setClosed((m) => ({ ...m, [c.id]: t }));
              onChanged();
            }}
          />
        ),
      )}
      {list.hasMore && (
        <ActionButton small onClick={() => void list.more()} pending={list.loading}>
          Load more
        </ActionButton>
      )}
    </>
  );
}

function MergeRow({ c, shell, onClosed }: { c: MergeCandidate; shell: ShellActions; onClosed: (t: string) => void }) {
  const body = buildMerge(c);
  const merge = useAction(
    (key) => call('POST', '/v1/merges', { body, idempotencyKey: key }),
    () => onClosed('Merged. A Manager can undo it.'),
  );
  const different = useDismissCandidate(c.id, 'different', () =>
    onClosed('Marked different. This pair will not be proposed again.'),
  );
  const skip = useDismissCandidate(c.id, 'skipped', () => onClosed('Skipped'));
  const busy = merge.pending || different.pending || skip.pending;
  const error = [merge, different, skip].find((a) => a.error !== undefined)?.error;
  const evidence = evidenceRows(c.evidence);
  return (
    <article aria-label={`Uncertain merge ${c.leftCode ?? c.id}`} style={{ borderBottom: '1px dashed var(--line)', padding: '10px 0' }}>
      <div className="row">
        <b>{AGGREGATE_Q[c.aggregateType] ?? 'Same record?'}</b>
        <Chip>{mergeReasonLabel(c.reason)}</Chip>
        <Chip tone={c.score >= 0.8 ? 'good' : 'warn'}>score {scorePct(c.score)}</Chip>
      </div>
      <table className="small">
        <thead>
          <tr>
            <th scope="col">Existing</th>
            <th scope="col">Incoming</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <RecordLink code={c.leftCode} shell={shell} />
            </td>
            <td>
              {c.rightCode ? (
                <RecordLink code={c.rightCode} shell={shell} />
              ) : (
                <span className="mono">{c.rightExternalRef ?? '—'}</span>
              )}
            </td>
          </tr>
        </tbody>
      </table>
      {evidence.length > 0 && <KV rows={evidence} />}
      <p className="small muted">
        A phone number alone never merges records.{' '}
        {!body ? 'The incoming record is not loaded yet, so it cannot be merged now.' : ''}
      </p>
      <div className="row">
        <ActionButton primary small onClick={() => void merge.run()} pending={merge.pending} disabled={busy || !body}>
          Merge
        </ActionButton>
        <ActionButton small onClick={() => void different.run()} pending={different.pending} disabled={busy}>
          Different
        </ActionButton>
        <ActionButton small onClick={() => void skip.run()} pending={skip.pending} disabled={busy}>
          Skip
        </ActionButton>
        {c.createdAt && <span className="small faint">found {date(c.createdAt)}</span>}
      </div>
      {error !== undefined && <ErrorNote error={error} />}
    </article>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Price gaps (records)

function PriceGapList({ onChanged }: { onChanged: () => void }) {
  const list = usePaged<SecondSource>('/v1/second-sources', { status: 'open', priceGap: true, limit: 20 });
  const [closed, setClosed] = useState<Record<string, string>>({});
  return (
    <>
      {list.error !== undefined && <ErrorNote error={list.error} onRetry={() => void list.reload()} />}
      {list.loading && list.items.length === 0 && <Loading label="Loading price gaps" />}
      {list.items.length > 0 && (
        <table className="small">
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Their price</th>
              <th scope="col">Gap</th>
              <th scope="col">Seen</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {list.items.map((s) => (
              <PriceGapRow
                key={s.id}
                s={s}
                closed={closed[s.id]}
                onClosed={(t) => {
                  setClosed((m) => ({ ...m, [s.id]: t }));
                  onChanged();
                }}
              />
            ))}
          </tbody>
        </table>
      )}
      {list.hasMore && (
        <ActionButton small onClick={() => void list.more()} pending={list.loading}>
          Load more
        </ActionButton>
      )}
    </>
  );
}

function PriceGapRow({ s, closed, onClosed }: { s: SecondSource; closed: string | undefined; onClosed: (t: string) => void }) {
  const accept = useResolveGap(s.id, 'accept_price', () => onClosed('Price accepted on the offer'));
  const keep = useResolveGap(s.id, 'dismiss', () => onClosed('Kept our price'));
  const error = accept.error ?? keep.error;
  return (
    <tr>
      <td>
        {s.sourceType ?? '—'}
        {s.sourceName ? ` · ${s.sourceName}` : ''}
      </td>
      <td className="num">{sourcePriceText(s)}</td>
      <td className="num">{gapText(s.priceGapPct)}</td>
      <td>{date(s.seenOn)}</td>
      <td>
        {closed ? (
          <Done>{closed}</Done>
        ) : (
          <div className="row">
            <ActionButton
              small
              primary
              onClick={() => void accept.run()}
              pending={accept.pending}
              disabled={keep.pending || !s.offerId}
            >
              Accept price
            </ActionButton>
            <ActionButton small onClick={() => void keep.run()} pending={keep.pending} disabled={accept.pending}>
              Keep ours
            </ActionButton>
            {error !== undefined && <ErrorNote error={error} />}
          </div>
        )}
      </td>
    </tr>
  );
}
