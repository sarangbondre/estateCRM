// Proposal feedback for M6 weight tuning (LLD §5.2, §3.3 feedback): one row per matchId verdict, with the score,
// factors and weights version the match had. A "rejected" client verdict does not reject the match.
import { SYSTEM_ACTOR } from '../domain/types.js';
import type { Store } from './ports.js';

const ACTION = {
  liked: 'client_liked',
  rejected: 'client_rejected',
  visit_requested: 'client_visit_requested',
} as const;

export async function onProposalFeedback(
  store: Store,
  tenantId: string,
  e: {
    proposalId: string;
    demandId: string;
    feedback: { matchId: string; verdict: keyof typeof ACTION | 'maybe' }[];
  },
  at: Date,
): Promise<number> {
  const verdicts = e.feedback.slice(0, 100);
  const matches = new Map(
    (
      await store.matches.getMany(
        tenantId,
        verdicts.map((f) => f.matchId),
      )
    ).map((m) => [m.id, m]),
  );
  let written = 0;
  for (const f of verdicts) {
    if (f.verdict === 'maybe') continue; // CR-012: "maybe" is neutral, so nothing to learn for the weights
    const m = matches.get(f.matchId);
    if (!m) continue; // unknown or purged match: nothing to learn from
    await store.feedback.insert(tenantId, {
      matchId: m.id,
      demandId: m.demandId,
      action: ACTION[f.verdict],
      source: 'proposal',
      reasonCode: null,
      score: m.score,
      factors: m.factors,
      weightsVersion: m.weightsVersion,
      byUser: SYSTEM_ACTOR,
      at,
    });
    written++;
  }
  return written;
}
