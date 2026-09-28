// Merge candidates (REC-06, US-09): never propose a pair twice (a "different" decision is remembered), pending
// possible_repeat targets (Z-4), and merge_candidate.raised.v1 for the review queue.
import type { CandidateReason, MergeCandidateRow } from './model.js';
import type { Tx } from './ports.js';
import type { App } from './context.js';
import { agg } from './emit.js';

export type CandidateKind = 'uncertain_merge' | 'possible_repeat' | 'price_gap';

export interface NewCandidate {
  aggregateType: MergeCandidateRow['aggregate_type'];
  leftId: string;
  rightId?: string | null | undefined;
  /** possible_repeat target not ingested yet. */
  rightExternalRef?: string | null | undefined;
  reason: CandidateReason;
  score: number;
  evidence: Record<string, unknown>;
  uploadId?: string | null | undefined;
}

const kindOf = (reason: CandidateReason): CandidateKind => (reason === 'possible_repeat' ? 'possible_repeat' : 'uncertain_merge');

/** Inserts the candidate unless the pair was already proposed; returns its id when new. */
export async function raiseCandidate(app: App, tx: Tx, c: NewCandidate): Promise<string | null> {
  const right = c.rightId ?? (c.rightExternalRef ? `ref:${c.rightExternalRef}` : null);
  if (!right || right === c.leftId) return null;
  const [low, high] = [c.leftId, right].sort() as [string, string];
  const id = app.ids.next();
  const inserted = await tx.store.insertIgnore('merge_candidates', {
    id,
    aggregate_type: c.aggregateType,
    left_id: c.leftId,
    right_id: c.rightId ?? null,
    right_external_ref: c.rightId ? null : (c.rightExternalRef ?? null),
    pair_low: low,
    pair_high: high,
    reason: c.reason,
    score: Math.min(1, Math.max(0, Math.round(c.score * 1000) / 1000)),
    evidence: c.evidence,
    status: c.rightId ? 'open' : 'pending_target',
    upload_id: c.uploadId ?? null,
    resolved_by: null,
    resolved_at: null,
    note: null,
  });
  if (!inserted) return null;
  if (c.rightId) await emitRaised(tx, id, kindOf(c.reason), c.aggregateType);
  return id;
}

export async function emitRaised(tx: Tx, candidateId: string, kind: CandidateKind, aggregateType?: string) {
  await tx.events.emit('merge_candidate.raised.v1', agg('merge_candidate', candidateId, 1), {
    candidateId,
    kind,
    ...(aggregateType ? { aggregateType } : {}),
  });
}

/**
 * A pending possible_repeat target arrived (ingestion) or the nightly job found it: the candidate opens and is
 * re-keyed to the real pair (the ref placeholder is replaced).
 */
export async function openPendingFor(tx: Tx, externalRef: string, subject: { type: string; id: string }): Promise<string[]> {
  const pending = await tx.store.find('merge_candidates', { right_external_ref: externalRef, status: 'pending_target' }, { limit: 100 });
  const opened: string[] = [];
  for (const c of pending) {
    if (c.aggregate_type !== subject.type || c.left_id === subject.id) continue;
    const [low, high] = [c.left_id, subject.id].sort() as [string, string];
    const clash = await tx.store.find('merge_candidates', { aggregate_type: c.aggregate_type, pair_low: low, pair_high: high }, { limit: 1 });
    if (clash.length) {
      await tx.store.update('merge_candidates', c.id, { status: 'skipped', resolved_at: tx.now });
      continue;
    }
    await tx.store.update('merge_candidates', c.id, { right_id: subject.id, pair_low: low, pair_high: high, status: 'open' });
    await emitRaised(tx, c.id, 'possible_repeat', c.aggregate_type);
    opened.push(c.id);
  }
  return opened;
}
