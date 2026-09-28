// Publication levels (LLD §4.2, §4.8): order, clamping, allowed levels and the change-feed transition type.
import type { Level, SubjectType, VisibleLevel } from './types.js';

export const rank = (level: Level): number => (level === 'Public' ? 2 : level === 'Anonymous' ? 1 : 0);

export const minLevel = (a: Level, b: Level): Level => (rank(a) <= rank(b) ? a : b);

export const isVisible = (level: Level): level is VisibleLevel => level !== 'Private';

/** Levels a subject type can take at all (A-L3: projects have no Anonymous; demand posts have no Public). */
export function levelsFor(subjectType: SubjectType): readonly Level[] {
  switch (subjectType) {
    case 'project':
      return ['Private', 'Public'];
    case 'demand_post':
      return ['Private', 'Anonymous'];
    default:
      return ['Private', 'Anonymous', 'Public'];
  }
}

/** Levels a user may choose now: those of the subject type at or below the ceiling. */
export function allowedLevels(subjectType: SubjectType, ceiling: Level): Level[] {
  return levelsFor(subjectType).filter((l) => rank(l) <= rank(ceiling));
}

/**
 * The highest level of the subject type that is ≤ the ceiling. Projects have no Anonymous level, so an Anonymous
 * ceiling on a project means Private.
 */
export function clampToCeiling(subjectType: SubjectType, level: Level, ceiling: Level): Level {
  const candidates = levelsFor(subjectType).filter((l) => rank(l) <= rank(minLevel(level, ceiling)));
  return candidates.at(-1) ?? 'Private';
}

export type ChangeType = 'published' | 'updated' | 'upgraded' | 'downgraded' | 'withdrawn';

/**
 * Change-feed type of a visible transition (LLD §4.8). `before` is the level currently served publicly (Private when
 * nothing is served), `after` the new one. Null when nothing visible changed.
 */
export function changeType(before: Level, after: Level, payloadChanged: boolean): ChangeType | null {
  if (!isVisible(before) && !isVisible(after)) return null;
  if (!isVisible(before)) return 'published';
  if (!isVisible(after)) return 'withdrawn';
  if (rank(after) > rank(before)) return 'upgraded';
  if (rank(after) < rank(before)) return 'downgraded';
  return payloadChanged ? 'updated' : null;
}
