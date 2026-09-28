// Pure rules behind the C-10 Matches card (PRD §4.5, §5.4; US-21, US-28; crm-engine LLD): score band, flag and factor
// chips, reject reasons, who may act, which matches can go into a bundle, and the bundle request.
import type { components, operations } from '@11e/contracts/crm-engine';
import type { Body } from '../../lib/contract';

type E = components['schemas'];
export type Match = E['Match'];
export type Factor = E['Factor'];
export type MatchFlag = Match['flags'][number];
export type Tone = 'plain' | 'good' | 'warn' | 'bad';

/**
 * Score band for the prototype `.score` badge: `hi` at 80 and above (a strong fit on most weighted factors, the
 * prototype's threshold), `mid` below. The number is always shown, so the band is never the only signal.
 */
export const HI_SCORE = 80;
export const scoreBand = (score: number | null | undefined): 'hi' | 'mid' =>
  typeof score === 'number' && score >= HI_SCORE ? 'hi' : 'mid';

export const FLAG_CHIP: Record<MatchFlag, { text: string; tone: Tone }> = {
  reconfirm: { text: 'Stale: reconfirm', tone: 'warn' },
  price_above_budget: { text: 'Price above budget', tone: 'bad' },
  area_basis_unknown: { text: 'Area basis unknown', tone: 'warn' },
  market_unknown: { text: 'Market unknown', tone: 'warn' },
};

export const flagChip = (f: string): { text: string; tone: Tone } =>
  FLAG_CHIP[f as MatchFlag] ?? { text: f.replace(/_/g, ' '), tone: 'warn' };

export const FACTOR_LABEL: Record<Factor['factor'], string> = {
  micromarket: 'Location',
  price: 'Price',
  area: 'Area',
  bhk: 'BHK',
  timing: 'Timing',
  furnishing: 'Furnishing',
};

/** Factor chip: ✔ good fit (value ≥ 0.7), ~ partial, n/a when the factor does not apply to this pair. */
export function factorChip(f: Pick<Factor, 'factor' | 'value' | 'points' | 'applicable'>): { text: string; tone: Tone } {
  const label = FACTOR_LABEL[f.factor] ?? String(f.factor);
  if (f.applicable === false) return { text: `${label} n/a`, tone: 'plain' };
  const good = f.value >= 0.7;
  return { text: `${label} ${good ? '✔' : '~'} ${Math.round(f.points)}`, tone: good ? 'good' : 'warn' };
}

export const REJECT_REASONS: { value: E['RejectRequest']['reasonCode']; label: string }[] = [
  { value: 'too_expensive', label: 'Too expensive' },
  { value: 'wrong_location', label: 'Wrong location' },
  { value: 'too_small', label: 'Too small' },
  { value: 'too_large', label: 'Too large' },
  { value: 'timing', label: 'Timing does not fit' },
  { value: 'wrong_type', label: 'Wrong property type' },
  { value: 'client_not_interested', label: 'Client not interested' },
  { value: 'already_seen', label: 'Already seen' },
  { value: 'owner_unwilling', label: 'Owner unwilling' },
  { value: 'other', label: 'Other' },
];

/** x-roles: confirm / reject / re-run = Admin, Manager, Demand agent; bundles also Supply agent (suggest only). */
const DECIDE = ['Admin', 'Manager', 'Demand agent'];
const BUNDLE = [...DECIDE, 'Supply agent'];
export const canDecide = (role: string | null | undefined): boolean => !!role && DECIDE.includes(role);
export const canBundle = (role: string | null | undefined): boolean => !!role && BUNDLE.includes(role);

/** Only live single-offer matches can be combined into a manual bundle. */
export const bundleable = (m: Pick<Match, 'isBundle' | 'status' | 'offerIds'>): boolean =>
  !m.isBundle && m.offerIds.length === 1 && (m.status === 'Suggested' || m.status === 'Confirmed');

export const canConfirm = (m: Pick<Match, 'status'>): boolean => m.status === 'Suggested';
export const canReject = (m: Pick<Match, 'status'>): boolean => m.status === 'Suggested' || m.status === 'Confirmed';

/** POST /v1/bundles body: 2–3 distinct offers of one demand; Supply agents suggest only (confirm=true is 403). */
export function buildBundle(
  demandId: string | null | undefined,
  offerIds: readonly string[],
  confirm: boolean,
  role: string | null | undefined,
): { body: Body<operations['createBundle']> } | { errors: string[] } {
  const ids = [...new Set(offerIds)];
  const errors: string[] = [];
  if (!demandId) errors.push('Bundles are built for one demand.');
  if (ids.length < 2) errors.push('Select 2 or 3 offers for a bundle.');
  if (ids.length > 3) errors.push('A bundle holds at most 3 offers.');
  if (!canBundle(role)) errors.push('Your role cannot build bundles.');
  if (errors.length) return { errors };
  return { body: { demandId: demandId as string, offerIds: ids, confirm: confirm && canDecide(role) } };
}

/** Title of a match row: its offers (bundles joined with "+"), or the demand when listed for an offer. */
export function matchTitle(m: Pick<Match, 'offerCodes' | 'offerIds' | 'code'>, side: 'demand' | 'offer', demandCode?: string | null) {
  if (side === 'offer') return demandCode ?? m.code;
  const codes = m.offerCodes?.filter(Boolean) ?? [];
  return codes.length ? codes.join(' + ') : `${m.offerIds.length} offer${m.offerIds.length === 1 ? '' : 's'}`;
}

export const STATUS_TONE: Record<Match['status'], Tone> = {
  Suggested: 'plain',
  Confirmed: 'good',
  Rejected: 'bad',
  Closed: 'plain',
};
