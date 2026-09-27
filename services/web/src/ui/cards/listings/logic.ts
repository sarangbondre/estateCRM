// Pure rules behind the Publication card (C-12, PRD §5.4, BRD §4.6): which levels can be chosen under the ceiling and
// why, who may set a level, privacy-scan highlighting by character offsets, and the RERA check (questionnaire A7:
// no MahaRERA number yet → pilot publishing shows "MahaRERA registration pending").
import type { components } from '@11e/contracts/listings';

type S = components['schemas'];
export type PublicationLevel = S['PublicationLevel'];
export type OfferPublicationState = S['OfferPublicationState'];
export type PrivacyScanResult = S['PrivacyScanResult'];
export type PrivacyScanFinding = S['PrivacyScanFinding'];
export type PublicationSettings = S['PublicationSettings'];
export type CeilingReason = S['CeilingReason'];

export const LEVELS: readonly PublicationLevel[] = ['Private', 'Anonymous', 'Public'];

/** x-roles of setOfferPublication / scanOfferText (contracts/openapi/listings.yaml). */
export const PUBLICATION_SETTERS: readonly string[] = ['Admin', 'Manager', 'Supply agent'];

export const canSetPublication = (role: string | null | undefined): boolean =>
  !!role && PUBLICATION_SETTERS.includes(role);

/** Rank of a level; unknown values rank as Private (never widen visibility by accident). */
export function levelRank(level: string | null | undefined): number {
  const i = LEVELS.indexOf(level as PublicationLevel);
  return i < 0 ? 0 : i;
}

export interface LevelOption {
  level: PublicationLevel;
  enabled: boolean;
  current: boolean;
  /** Why the level can't be chosen (above the ceiling, or not offered for this subject). */
  reason?: string;
}

type LevelInput = Pick<OfferPublicationState, 'level' | 'ceiling' | 'ceilingReasons' | 'allowedLevels'>;

/**
 * Levels offered on C-12. A level is enabled when it is at or below the ceiling and in `allowedLevels` (when the
 * service sends a non-empty list). Levels above the ceiling carry the ceiling reasons as their explanation.
 */
export function levelOptions(state: LevelInput): LevelOption[] {
  const ceiling = levelRank(state.ceiling);
  const allowed = Array.isArray(state.allowedLevels) && state.allowedLevels.length ? state.allowedLevels : null;
  const why = ceilingWhy(state);
  return LEVELS.map((level, rank) => {
    const current = level === state.level;
    if (rank > ceiling) return { level, enabled: false, current, reason: `Above the ceiling (${state.ceiling}): ${why}` };
    if (allowed && !allowed.includes(level)) return { level, enabled: false, current, reason: 'Not offered for this item.' };
    return { level, enabled: true, current };
  });
}

/** Plain-English explanation of the ceiling. */
export function ceilingWhy(state: Pick<OfferPublicationState, 'ceiling' | 'ceilingReasons'>): string {
  const reasons = Array.isArray(state.ceilingReasons) ? state.ceilingReasons : [];
  if (!reasons.length) return levelRank(state.ceiling) === 2 ? 'All publication rules pass.' : 'No reason given.';
  return reasons.map((r) => r.message || r.code).join(' ');
}

/** Raising above Private runs the blocking privacy scan and the RERA check (LLD listings §4.2). */
export const needsChecks = (from: string | null | undefined, to: string): boolean =>
  levelRank(to) > 0 && levelRank(to) >= levelRank(from);

export interface Segment {
  text: string;
  flagged: boolean;
  kinds: string[];
  severity?: 'block' | 'warn';
}

/**
 * Splits `text` into plain and flagged segments from description findings (character offsets; the service never
 * returns the matched text). Offsets are clamped to the text; overlapping findings merge, `block` wins over `warn`.
 */
export function highlightSpans(text: string, findings: readonly PrivacyScanFinding[] | null | undefined): Segment[] {
  const spans = (findings ?? [])
    .filter((f) => f.field === 'description' && typeof f.start === 'number' && typeof f.end === 'number')
    .map((f) => ({
      start: Math.max(0, Math.min(text.length, f.start as number)),
      end: Math.max(0, Math.min(text.length, f.end as number)),
      kind: f.kind,
      severity: f.severity,
    }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const merged: { start: number; end: number; kinds: string[]; severity: 'block' | 'warn' }[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start < last.end) {
      last.end = Math.max(last.end, s.end);
      if (!last.kinds.includes(s.kind)) last.kinds.push(s.kind);
      if (s.severity === 'block') last.severity = 'block';
    } else {
      merged.push({ start: s.start, end: s.end, kinds: [s.kind], severity: s.severity === 'block' ? 'block' : 'warn' });
    }
  }

  const out: Segment[] = [];
  let at = 0;
  for (const m of merged) {
    if (m.start > at) out.push({ text: text.slice(at, m.start), flagged: false, kinds: [] });
    out.push({ text: text.slice(m.start, m.end), flagged: true, kinds: m.kinds, severity: m.severity });
    at = m.end;
  }
  if (at < text.length || !out.length) out.push({ text: text.slice(at), flagged: false, kinds: [] });
  return out;
}

const KIND_LABEL: Record<string, string> = {
  phone: 'phone number',
  email: 'email address',
  url: 'web address',
  social_handle: 'social media handle',
  building_name: 'building name',
  society_name: 'society name',
  wing_unit: 'wing or unit number',
  exact_floor: 'exact floor',
  street_address: 'street address',
  photo_text: 'text in a photo',
  text_detected: 'text in a photo',
  other_text: 'other text',
};
export const findingLabel = (kind: string): string => KIND_LABEL[kind] ?? kind.replace(/_/g, ' ');

export interface ScanSummary {
  tone: 'good' | 'warn' | 'bad';
  text: string;
}

export function scanSummary(scan: PrivacyScanResult | null | undefined): ScanSummary {
  if (!scan) return { tone: 'warn', text: 'Not scanned yet. Run the privacy scan before publishing.' };
  const kinds = [...new Set((scan.findings ?? []).map((f) => findingLabel(f.kind)))];
  if (scan.result === 'blocked')
    return { tone: 'bad', text: `Blocked: ${kinds.join(', ') || 'private details'} found. Remove them to publish.` };
  if (scan.result === 'warning')
    return { tone: 'warn', text: `Warning only: ${kinds.join(', ') || 'check the text'}. Publishing is allowed.` };
  return { tone: 'good', text: 'No phone numbers, building names or unit numbers in the text.' };
}

export interface ReraStatus {
  tone: 'good' | 'warn' | 'bad';
  text: string;
  /** Text for the MahaRERA line of the website preview. */
  preview: string;
}

/**
 * RERA check (BRD §4.6). Questionnaire A7: until the MahaRERA agent number exists, the pilot may publish and every item
 * shows "MahaRERA registration pending"; production blocks. A project RERA number is required for Sale, Primary.
 */
export function reraStatus(
  settings: Pick<PublicationSettings, 'mahareraAgentNumber'> | null | undefined,
  rera: OfferPublicationState['rera'] | null | undefined,
  pilot: boolean,
): ReraStatus {
  const agent = settings?.mahareraAgentNumber?.trim() || null;
  // Settings not readable (null/undefined) → fall back to the flag on the publication state.
  const agentSet = !!agent || (settings == null && !!rera?.agentNumberSet);
  const project = rera?.projectReraRequired ? rera.projectReraNumber?.trim() || null : null;
  if (rera?.projectReraRequired && !project)
    return {
      tone: 'bad',
      text: 'Project RERA number is missing. Sale, Primary items need it before publishing.',
      preview: agent ? `MahaRERA agent reg. ${agent}` : 'MahaRERA registration pending',
    };
  if (!agentSet)
    return pilot
      ? {
          tone: 'warn',
          text: 'MahaRERA registration pending. Pilot publishing is allowed; the listing shows "MahaRERA registration pending".',
          preview: 'MahaRERA registration pending',
        }
      : {
          tone: 'bad',
          text: 'MahaRERA agent number is not set (Settings → Website & RERA). Publishing is blocked.',
          preview: 'MahaRERA registration pending',
        };
  const tail = project ? ` · Project RERA ${project}` : '';
  return {
    tone: 'good',
    text: `MahaRERA number present${agent ? ` (${agent})` : ''}${project ? `, project RERA ${project}` : ''}.`,
    preview: `MahaRERA agent reg. ${agent ?? 'on file'}${tail}`,
  };
}

/** Request body for PUT /v1/offers/{id}/publication: the description only when the person edited it. */
export function publicationBody(
  level: PublicationLevel,
  original: string | null | undefined,
  edited: string,
): { level: PublicationLevel; publicDescription?: string | null } {
  const before = original ?? '';
  if (edited === before) return { level };
  return { level, publicDescription: edited.trim() === '' ? null : edited };
}
