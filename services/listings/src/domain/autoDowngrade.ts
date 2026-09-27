// Auto-downgrade (NFR-9, PRD §4.6, US-33 AC4, LLD §4.3): when the ceiling drops below the level, the level follows
// in the same transaction. Never auto-raise (R-CHAT-1); merge undo is the only restore (capped by the ceiling).
import type { ReasonCode } from './ceiling.js';
import { clampToCeiling, rank } from './levels.js';
import type { ChangeReason, Level, SubjectType } from './types.js';

/** `publication.changed.v1` reason for an automatic change, from the ceiling reasons (LLD §4.3 table). */
export function autoChangeReason(reasons: readonly ReasonCode[]): ChangeReason {
  if (reasons.includes('voided')) return 'voided';
  if (reasons.includes('merged')) return 'merged';
  if (reasons.includes('commercial_closed')) return 'closed';
  if (reasons.includes('commercial_inactive') || reasons.includes('retired_unwilling')) return 'retired';
  if (reasons.includes('life_expired') || reasons.includes('life_paused')) return 'expired';
  return 'ceiling_dropped';
}

export interface Downgrade {
  level: Level;
  reason: ChangeReason;
}

/** The forced new level, or null when the level is still within the ceiling. */
export function decideDowngrade(
  subjectType: SubjectType,
  level: Level,
  ceiling: Level,
  reasons: readonly ReasonCode[],
): Downgrade | null {
  if (rank(level) <= rank(ceiling)) return null;
  return { level: clampToCeiling(subjectType, level, ceiling), reason: autoChangeReason(reasons) };
}

/** Merge undo restores the pre-merge level, capped by today's ceiling. */
export function restoredLevel(subjectType: SubjectType, prior: Level, ceiling: Level): Level {
  return clampToCeiling(subjectType, prior, ceiling);
}
