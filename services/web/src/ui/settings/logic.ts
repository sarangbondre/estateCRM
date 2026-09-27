// Settings page logic (WEB-08; PRD §2.3 who may change what, §5.5 Settings page, US-34/US-35/US-37): tab visibility
// per role, JSON Merge Patch building, contract validation for numeric settings, audit filter → query mapping. Pure.
import type { components as Web, operations as WebOps } from '@11e/contracts/web';
import type { Body } from '../lib/contract';
import type { components as Journeys } from '@11e/contracts/journeys';
import type { components as Engine } from '@11e/contracts/crm-engine';
import type { components as Records } from '@11e/contracts/records';
import type { components as Listings } from '@11e/contracts/listings';

export type RoleCode = Web['schemas']['RoleCode'];
export type User = Web['schemas']['User'];
export type Role = Web['schemas']['Role'];
export type AuditEntry = Web['schemas']['AuditEntry'];
export type Capacity = Journeys['schemas']['Capacity'];
export type LifeCurveThresholds = Journeys['schemas']['LifeCurveThresholds'];
export type QueueWeights = Journeys['schemas']['QueueWeights'];
export type MatchWeights = Engine['schemas']['Weights'];
export type Micromarket = Records['schemas']['Micromarket'];
export type MicromarketLevel = Micromarket['level'];
export type LaunchArea = Records['schemas']['LaunchArea'];
export type VocabularyRelease = Records['schemas']['VocabularyRelease'];
export type VocabularyVersion = Records['schemas']['VocabularyVersion'];
export type PublicationSettings = Listings['schemas']['PublicationSettings'];
export type ApiKey = Listings['schemas']['ApiKey'];
export type ApiKeyWithSecret = Listings['schemas']['ApiKeyWithSecret'];

export const ROLE_CODES: readonly RoleCode[] = ['Admin', 'Manager', 'Demand agent', 'Supply agent', 'Data operator'];

// ------------------------------------------------------------------ tabs and role gates

export type TabSlug =
  | 'users'
  | 'capacities'
  | 'life-curve'
  | 'queue-weights'
  | 'match-weights'
  | 'micromarkets'
  | 'vocabulary'
  | 'publication'
  | 'api-keys'
  | 'audit';

export interface TabDef {
  slug: TabSlug;
  label: string;
  /** Roles that see the tab (read). */
  view: readonly RoleCode[];
  /** Roles that may change what the tab shows (the operations' x-roles). */
  edit: readonly RoleCode[];
}

const AM: readonly RoleCode[] = ['Admin', 'Manager'];
const A: readonly RoleCode[] = ['Admin'];

/** PRD §2.3: settings, users, API keys and the audit log are Admin; capacities are Admin and Manager. */
export const SETTINGS_TABS: readonly TabDef[] = [
  { slug: 'users', label: 'Users & roles', view: AM, edit: A },
  { slug: 'capacities', label: 'Capacities', view: AM, edit: AM },
  { slug: 'life-curve', label: 'Life curve', view: AM, edit: A },
  { slug: 'queue-weights', label: 'Queue weights', view: AM, edit: A },
  { slug: 'match-weights', label: 'Match weights', view: AM, edit: A },
  { slug: 'micromarkets', label: 'Micromarkets', view: AM, edit: A },
  { slug: 'vocabulary', label: 'Vocabulary', view: AM, edit: [] },
  { slug: 'publication', label: 'MahaRERA & publication', view: A, edit: A },
  { slug: 'api-keys', label: 'API keys', view: A, edit: A },
  { slug: 'audit', label: 'Audit log', view: A, edit: [] },
];

export const canOpenSettings = (role: string): boolean => AM.includes(role as RoleCode);

export const visibleTabs = (role: string): TabDef[] => SETTINGS_TABS.filter((t) => t.view.includes(role as RoleCode));

export const canEdit = (slug: TabSlug, role: string): boolean =>
  SETTINGS_TABS.find((t) => t.slug === slug)?.edit.includes(role as RoleCode) ?? false;

/** The tab to show for a `?tab=` value: the requested one when the role sees it, else the first visible one. */
export function resolveTab(param: string | null | undefined, role: string): TabSlug | null {
  const tabs = visibleTabs(role);
  return tabs.find((t) => t.slug === param)?.slug ?? tabs[0]?.slug ?? null;
}

// ------------------------------------------------------------------ JSON Merge Patch

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** RFC 7396 patch with only the fields of `draft` that differ from `original`. */
export function mergePatch<T extends object>(original: Partial<T>, draft: Partial<T>): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(draft) as (keyof T)[]) {
    if (!same(original[k], draft[k])) out[k] = draft[k];
  }
  return out;
}

export type UserPatch = Body<WebOps['updateUser']>;

export interface UserDraft {
  displayName: string;
  role: RoleCode;
  isDataOperator: boolean;
}

export const userDraft = (u: User): UserDraft => ({
  displayName: u.displayName,
  role: u.role,
  isDataOperator: u.isDataOperator ?? false,
});

/** Merge patch for the user editor: only changed fields; null when nothing changed. */
export function buildUserPatch(u: User, draft: UserDraft): UserPatch | null {
  const patch = mergePatch<UserDraft>(userDraft(u), { ...draft, displayName: draft.displayName.trim() });
  return Object.keys(patch).length ? (patch as UserPatch) : null;
}

export function validateUserDraft(d: UserDraft): string | null {
  const name = d.displayName.trim();
  if (!name) return 'Display name is required.';
  if (name.length > 80) return 'Display name is at most 80 characters.';
  return null;
}

// ------------------------------------------------------------------ invitations

export interface InviteDraft {
  email: string;
  displayName: string;
  role: RoleCode | null;
  isDataOperator: boolean;
}

export const EMPTY_INVITE: InviteDraft = { email: '', displayName: '', role: null, isDataOperator: false };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateInvite(d: InviteDraft): string[] {
  const errors: string[] = [];
  const email = d.email.trim();
  if (!EMAIL.test(email) || email.length > 254) errors.push('Enter the Google account e-mail address.');
  if (d.displayName.trim().length > 80) errors.push('Display name is at most 80 characters.');
  if (!d.role) errors.push('Choose a role.');
  return errors;
}

export function buildInvite(d: InviteDraft): {
  email: string;
  role: RoleCode;
  displayName?: string;
  isDataOperator: boolean;
} {
  const name = d.displayName.trim();
  return {
    email: d.email.trim().toLowerCase(),
    role: d.role ?? 'Demand agent',
    ...(name ? { displayName: name } : {}),
    isDataOperator: d.isDataOperator,
  };
}

// ------------------------------------------------------------------ numeric settings (contract min/max)

export interface NumberRule {
  label: string;
  min: number;
  max?: number;
  integer?: boolean;
  /** Contract default, used when the stored value is absent. */
  default?: number;
  hint?: string;
}

export interface NumField extends NumberRule {
  /** Dotted path in the settings object, e.g. `factors.price`. */
  path: string;
}

/** Validates one input value against a contract rule; returns a message or null. */
export function checkNumber(raw: string, rule: NumberRule): string | null {
  const s = raw.trim();
  if (s === '') return `${rule.label} is required.`;
  const n = Number(s);
  if (!Number.isFinite(n)) return `${rule.label} must be a number.`;
  if (rule.integer && !Number.isInteger(n)) return `${rule.label} must be a whole number.`;
  if (n < rule.min) return `${rule.label} must be at least ${rule.min}.`;
  if (rule.max !== undefined && n > rule.max) return `${rule.label} must be at most ${rule.max}.`;
  return null;
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur = obj;
  keys.slice(0, -1).forEach((k) => {
    const next = cur[k];
    if (next === null || typeof next !== 'object') cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  });
  cur[keys[keys.length - 1]!] = value;
}

export type Draft = Record<string, string>;

/** Form values (strings) for the numeric fields; absent values fall back to the contract default. */
export function toDraft(obj: unknown, fields: readonly NumField[]): Draft {
  const d: Draft = {};
  for (const f of fields) {
    const v = getPath(obj, f.path);
    d[f.path] = typeof v === 'number' ? String(v) : f.default !== undefined ? String(f.default) : '';
  }
  return d;
}

export function validateDraft(draft: Draft, fields: readonly NumField[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const e = checkNumber(draft[f.path] ?? '', f);
    if (e) errors[f.path] = e;
  }
  return errors;
}

/** A copy of `obj` with the draft numbers written in and read-only audit fields dropped (the PUT body). */
export function applyDraft<T extends object>(obj: T, draft: Draft, fields: readonly NumField[]): T {
  const copy = JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
  delete copy.updatedBy;
  delete copy.updatedAt;
  for (const f of fields) setPath(copy, f.path, Number((draft[f.path] ?? '').trim()));
  return copy as T;
}

export const isDirty = (obj: unknown, draft: Draft, fields: readonly NumField[]): boolean =>
  fields.some((f) => {
    const v = getPath(obj, f.path);
    return typeof v !== 'number' || Number(draft[f.path]) !== v;
  });

// Life-curve thresholds (journeys LifeCurveThresholds; BRD §4.5, D-12)
export const OFFER_CATEGORIES = [
  'lease_residential',
  'lease_commercial',
  'sale_secondary',
  'sale_primary',
  'industrial',
  'land_jv',
] as const;
export const DEMAND_CATEGORIES = [
  'lease_residential',
  'lease_commercial',
  'sale_secondary_any',
  'sale_primary',
  'industrial',
  'land_jv',
] as const;

export const CATEGORY_LABEL: Record<string, string> = {
  lease_residential: 'Lease · Residential',
  lease_commercial: 'Lease · Commercial',
  sale_secondary: 'Sale · Secondary (and Pagdi)',
  sale_secondary_any: 'Sale · Secondary / Any (and Pagdi)',
  sale_primary: 'Sale · Primary',
  industrial: 'Industrial',
  land_jv: 'Land and JV',
};

export const STAGES = [
  ['freshMaxDays', 'Fresh ≤ days'],
  ['ageingMaxDays', 'Ageing ≤ days'],
  ['staleMaxDays', 'Stale ≤ days'],
] as const;

const thresholdFields = (side: 'offer' | 'demand', cats: readonly string[]): NumField[] =>
  cats.flatMap((c) =>
    STAGES.map(([k, l]) => ({ path: `${side}.${c}.${k}`, label: `${CATEGORY_LABEL[c]} (${side}) ${l}`, min: 1, integer: true })),
  );

export const LIFE_CURVE_FIELDS: readonly NumField[] = [
  ...thresholdFields('offer', OFFER_CATEGORIES),
  ...thresholdFields('demand', DEMAND_CATEGORIES),
  { path: 'upcomingLeadDays', label: 'Upcoming lead days', min: 0, max: 365, integer: true, default: 60 },
  { path: 'dormantRevisitDays', label: 'Dormant revisit days', min: 1, max: 365, integer: true, default: 60 },
];

/** Contract rule: fresh < ageing < stale per category. */
export function thresholdOrderErrors(draft: Draft): Record<string, string> {
  const errors: Record<string, string> = {};
  const check = (side: string, cats: readonly string[]) => {
    for (const c of cats) {
      const [f, a, s] = STAGES.map(([k]) => Number(draft[`${side}.${c}.${k}`]));
      if (!(f! < a!)) errors[`${side}.${c}.ageingMaxDays`] = `${CATEGORY_LABEL[c]} (${side}): Ageing must be after Fresh.`;
      if (!(a! < s!)) errors[`${side}.${c}.staleMaxDays`] = `${CATEGORY_LABEL[c]} (${side}): Stale must be after Ageing.`;
    }
  };
  check('offer', OFFER_CATEGORIES);
  check('demand', DEMAND_CATEGORIES);
  return errors;
}

export function validateLifeCurve(draft: Draft): Record<string, string> {
  return { ...thresholdOrderErrors(draft), ...validateDraft(draft, LIFE_CURVE_FIELDS) };
}

// Queue weights (journeys QueueWeights; PRD §4.2)
const W01 = { min: 0, max: 1 };
export const QUEUE_WEIGHT_FIELDS: readonly NumField[] = [
  { path: 'freshness', label: 'Freshness', ...W01, default: 0.25 },
  { path: 'demandGap', label: 'Demand gap', ...W01, default: 0.35 },
  { path: 'sourceQuality', label: 'Source quality', ...W01, default: 0.2 },
  { path: 'priceBand', label: 'Price band', ...W01, default: 0.2 },
  { path: 'stalePublicBoost', label: 'Stale public boost', min: 0, max: 50, default: 15 },
  { path: 'ageingReconfirmBoost', label: 'Ageing reconfirm boost', min: 0, max: 50, default: 5 },
  { path: 'freshnessHorizonDays', label: 'Freshness horizon (days)', min: 1, max: 365, integer: true, default: 60 },
  { path: 'demandGapCap', label: 'Demand gap cap', min: 1, max: 1000, integer: true, default: 20 },
  { path: 'mustCallDueHours', label: 'Must call due (hours)', min: 1, max: 168, integer: true, default: 24 },
  { path: 'maxAttempts', label: 'Max call attempts', min: 1, max: 10, integer: true, default: 3 },
];
const QUEUE_WEIGHTS = ['freshness', 'demandGap', 'sourceQuality', 'priceBand'];

/** At least one weight must be above 0 (weights are normalised by their sum). */
function sumPositive(draft: Draft, paths: readonly string[], label: string): Record<string, string> {
  const sum = paths.reduce((s, p) => s + (Number(draft[p]) || 0), 0);
  return sum > 0 ? {} : { [paths[0]!]: `${label}: at least one weight must be above 0.` };
}

export function validateQueueWeights(draft: Draft): Record<string, string> {
  return { ...sumPositive(draft, QUEUE_WEIGHTS, 'Ranking weights'), ...validateDraft(draft, QUEUE_WEIGHT_FIELDS) };
}

// Match weights (crm-engine Weights; PRD §4.5)
const FACTORS: [string, string, number][] = [
  ['micromarket', 'Micromarket', 0.25],
  ['price', 'Price', 0.25],
  ['area', 'Area', 0.2],
  ['bhk', 'BHK', 0.1],
  ['timing', 'Timing', 0.1],
  ['furnishing', 'Furnishing', 0.1],
];
export const MATCH_FACTOR_FIELDS: readonly NumField[] = FACTORS.map(([k, label, d]) => ({
  path: `factors.${k}`,
  label,
  ...W01,
  default: d,
}));
export const MATCH_TUNING_FIELDS: readonly NumField[] = [
  { path: 'tuning.minScore', label: 'Minimum score', min: 0, max: 100, integer: true, default: 40 },
  { path: 'tuning.topNPerDemand', label: 'Top N per demand', min: 1, max: 50, integer: true, default: 20 },
  { path: 'tuning.areaTolerancePct', label: 'Area tolerance %', min: 0, max: 100, default: 15 },
  { path: 'tuning.areaToleranceUnknownBasisPct', label: 'Area tolerance, unknown basis %', min: 0, max: 100, default: 25 },
  { path: 'tuning.priceOverBudgetZeroPct', label: 'Price score 0 at % over budget', min: 1, max: 100, default: 20 },
  { path: 'tuning.timingSoonDays', label: 'Timing "soon" (days)', min: 0, max: 365, integer: true, default: 30 },
  { path: 'tuning.bundleMaxOffers', label: 'Offers per bundle', min: 2, max: 3, integer: true, default: 3 },
  { path: 'tuning.bundleCandidateCap', label: 'Bundle candidate cap', min: 5, max: 60, integer: true, default: 30 },
  { path: 'tuning.bundlesPerDemand', label: 'Bundles per demand', min: 0, max: 10, integer: true, default: 3 },
  { path: 'tuning.rejectedResuggestMinGain', label: 'Re-suggest after reject: min gain', min: 0, max: 100, integer: true, default: 10 },
  { path: 'tuning.proximity.sameLocality', label: 'Proximity: same locality', ...W01, default: 1 },
  { path: 'tuning.proximity.sameMicromarket', label: 'Proximity: same micromarket', ...W01, default: 0.85 },
  { path: 'tuning.proximity.coarserLevel', label: 'Proximity: coarser level', ...W01, default: 0.6 },
];
export const MATCH_WEIGHT_FIELDS: readonly NumField[] = [...MATCH_FACTOR_FIELDS, ...MATCH_TUNING_FIELDS];

export function validateMatchWeights(draft: Draft): Record<string, string> {
  return {
    ...sumPositive(draft, MATCH_FACTOR_FIELDS.map((f) => f.path), 'Factor weights'),
    ...validateDraft(draft, MATCH_WEIGHT_FIELDS),
  };
}

/** Share of each weight in the normalised sum, for the "effective weight" column. */
export function shares(draft: Draft, paths: readonly string[]): Record<string, number> {
  const vals = paths.map((p) => Math.max(0, Number(draft[p]) || 0));
  const sum = vals.reduce((a, b) => a + b, 0);
  return Object.fromEntries(paths.map((p, i) => [p, sum > 0 ? vals[i]! / sum : 0]));
}

// ------------------------------------------------------------------ capacities (journeys; D-10, questionnaire C6)

export const DEFAULT_CAPACITY = 40;
export const CAPACITY_RULE: NumberRule = { label: 'Calls per day', min: 0, max: 200, integer: true };

export type Team = Capacity['team'];
export const defaultTeam = (role: string): Team => (role === 'Supply agent' ? 'supply' : 'demand');

export interface CapacityRow {
  userId: string;
  name: string;
  role: string | null;
  team: Team;
  dailyCalls: number;
  /** Row version for If-Match; null = no stored capacity yet (default applies). */
  version: number | null;
}

const CALLING_ROLES = new Set<string>(['Admin', 'Manager', 'Demand agent', 'Supply agent']);

/** One row per non-deactivated calling user, joined with the stored capacity (default 40 when none). */
export function capacityRows(users: readonly User[], capacities: readonly Capacity[]): CapacityRow[] {
  const byUser = new Map(capacities.map((c) => [c.userId, c]));
  const rows: CapacityRow[] = [];
  const seen = new Set<string>();
  for (const u of users) {
    if (u.status === 'deactivated' || !CALLING_ROLES.has(u.role)) continue;
    const c = byUser.get(u.userId);
    seen.add(u.userId);
    rows.push({
      userId: u.userId,
      name: u.displayName,
      role: u.role,
      team: c?.team ?? defaultTeam(u.role),
      dailyCalls: c?.dailyCalls ?? DEFAULT_CAPACITY,
      version: c?.version ?? null,
    });
  }
  for (const c of capacities) {
    if (seen.has(c.userId)) continue;
    rows.push({ userId: c.userId, name: shortId(c.userId), role: null, team: c.team, dailyCalls: c.dailyCalls, version: c.version });
  }
  return rows;
}

// ------------------------------------------------------------------ audit log (web listAuditLog; US-35)

export const AUDIT_PRODUCERS = ['web', 'intake', 'records', 'journeys', 'crm-engine', 'listings', 'insight'] as const;

export interface AuditFilters {
  actorUserId: string;
  action: string;
  actionMode: 'exact' | 'prefix';
  subjectType: string;
  subjectId: string;
  producer: string;
  /** YYYY-MM-DD (India time). */
  from: string;
  to: string;
}

export const EMPTY_AUDIT_FILTERS: AuditFilters = {
  actorUserId: '',
  action: '',
  actionMode: 'exact',
  subjectType: '',
  subjectId: '',
  producer: '',
  from: '',
  to: '',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "export", "export.", "export*" or "export.*" in prefix mode → "export.*"; a trailing "*" always means prefix. */
export function normalizeAction(action: string, mode: AuditFilters['actionMode']): string {
  const a = action.trim();
  if (!a) return '';
  if (mode === 'prefix' || a.endsWith('*')) {
    const stem = a.replace(/\.?\*+$/, '').replace(/\.+$/, '');
    return stem ? `${stem}.*` : '';
  }
  return a;
}

/** Filters → listAuditLog query. Dates are whole days in India time (IST, +05:30). */
export function auditQuery(f: AuditFilters): { query: Record<string, string>; errors: string[] } {
  const query: Record<string, string> = {};
  const errors: string[] = [];
  const action = normalizeAction(f.action, f.actionMode);
  if (action.length > 60) errors.push('Action is at most 60 characters.');
  else if (action) query.action = action;
  if (f.actorUserId) query.actorUserId = f.actorUserId;
  const st = f.subjectType.trim();
  if (st.length > 40) errors.push('Subject type is at most 40 characters.');
  else if (st) query.subjectType = st;
  const sid = f.subjectId.trim();
  if (sid && !UUID.test(sid)) errors.push('Subject id must be a UUID.');
  else if (sid) query.subjectId = sid.toLowerCase();
  if (f.producer) {
    if ((AUDIT_PRODUCERS as readonly string[]).includes(f.producer)) query.producer = f.producer;
    else errors.push('Unknown producer.');
  }
  if (f.from && !DAY_RE.test(f.from)) errors.push('From must be a date.');
  else if (f.from) query.from = `${f.from}T00:00:00+05:30`;
  if (f.to && !DAY_RE.test(f.to)) errors.push('To must be a date.');
  else if (f.to) query.to = `${f.to}T23:59:59.999+05:30`;
  if (f.from && f.to && DAY_RE.test(f.from) && DAY_RE.test(f.to) && f.from > f.to) errors.push('From must be on or before To.');
  return { query, errors };
}

/** Producer-supplied details (PII-free) as short "key: value" pairs. */
export function formatDetails(details: Record<string, unknown> | undefined, max = 200): string {
  if (!details || typeof details !== 'object') return '';
  const s = Object.entries(details)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' · ');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ------------------------------------------------------------------ micromarkets and launch area (records; US-34, R-13)

export const MICROMARKET_LEVELS: readonly MicromarketLevel[] = ['zone', 'micromarket', 'locality', 'sub_locality'];
export const LEVEL_LABEL: Record<string, string> = {
  zone: 'Zone',
  micromarket: 'Micromarket',
  locality: 'Locality',
  sub_locality: 'Sub-locality',
};

export function parentLevel(level: MicromarketLevel): MicromarketLevel | null {
  const i = MICROMARKET_LEVELS.indexOf(level);
  return i > 0 ? MICROMARKET_LEVELS[i - 1]! : null;
}

/** Comma- or newline-separated aliases → trimmed, de-duplicated (case-insensitive) list. */
export function parseAliases(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of text.split(/[,\n]/).map((s) => s.trim())) {
    if (!a || seen.has(a.toLowerCase())) continue;
    seen.add(a.toLowerCase());
    out.push(a);
  }
  return out;
}

export interface MicromarketDraft {
  level: MicromarketLevel;
  name: string;
  city: string;
  parentId: string | null;
  aliases: string;
  adjacentIds: string[];
}

export function validateMicromarket(d: MicromarketDraft, creating: boolean): string[] {
  const errors: string[] = [];
  const name = d.name.trim();
  if (!name) errors.push('Name is required.');
  if (name.length > 120) errors.push('Name is at most 120 characters.');
  if (creating && !d.city.trim()) errors.push('City is required.');
  if (creating && parentLevel(d.level) && !d.parentId) errors.push(`Choose the parent ${LEVEL_LABEL[parentLevel(d.level)!]}.`);
  if (parseAliases(d.aliases).length > 50) errors.push('At most 50 aliases.');
  if (d.adjacentIds.length > 30) errors.push('At most 30 adjacent micromarkets.');
  return errors;
}

export function buildMicromarketInput(d: MicromarketDraft) {
  const aliases = parseAliases(d.aliases);
  return {
    level: d.level,
    name: d.name.trim(),
    city: d.city.trim(),
    ...(d.parentId ? { parentId: d.parentId } : {}),
    ...(aliases.length ? { aliases } : {}),
    ...(d.adjacentIds.length ? { adjacentIds: d.adjacentIds } : {}),
  };
}

export const micromarketDraft = (m: Micromarket): MicromarketDraft => ({
  level: m.level,
  name: m.name,
  city: m.city,
  parentId: m.parentId ?? null,
  aliases: (m.aliases ?? []).join(', '),
  adjacentIds: [...(m.adjacentIds ?? [])],
});

/** Merge patch for a node: only name / aliases / parent / adjacency that changed; null when nothing changed. */
export function buildMicromarketPatch(m: Micromarket, d: MicromarketDraft) {
  const original = { name: m.name, aliases: m.aliases ?? [], parentId: m.parentId ?? null, adjacentIds: [...(m.adjacentIds ?? [])].sort() };
  const draft = { name: d.name.trim(), aliases: parseAliases(d.aliases), parentId: d.parentId, adjacentIds: [...d.adjacentIds].sort() };
  const patch = mergePatch(original, draft);
  return Object.keys(patch).length ? patch : null;
}

// ------------------------------------------------------------------ publication and API keys (listings; A7)

export const RERA_PATTERN = /^[A-Z][0-9]{11}$/;

export function validateRera(v: string): string | null {
  const s = v.trim().toUpperCase();
  if (!s) return 'Enter the MahaRERA agent registration number.';
  return RERA_PATTERN.test(s) ? null : 'A MahaRERA agent number is a letter and 11 digits, e.g. A51900012345.';
}

/** Pilot rule (questionnaire A7): until the number is set, listings show "MahaRERA registration pending". */
export const reraPending = (s: { mahareraAgentNumber?: string | null } | undefined): boolean =>
  !s?.mahareraAgentNumber || !RERA_PATTERN.test(s.mahareraAgentNumber);

export interface ApiKeyDraft {
  name: string;
  origins: string;
  rateLimitRps: string;
  burst: string;
}

export const EMPTY_API_KEY: ApiKeyDraft = { name: '', origins: '', rateLimitRps: '50', burst: '100' };

const isUri = (s: string): boolean => {
  try {
    return Boolean(new URL(s).protocol);
  } catch {
    return false;
  }
};

export const parseOrigins = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

export function validateApiKey(d: ApiKeyDraft): string[] {
  const errors: string[] = [];
  const name = d.name.trim();
  if (name.length < 2 || name.length > 80) errors.push('Site name is 2 to 80 characters.');
  const origins = parseOrigins(d.origins);
  if (origins.length > 10) errors.push('At most 10 allowed origins.');
  const bad = origins.filter((o) => !isUri(o));
  if (bad.length) errors.push(`Not a URL: ${bad.slice(0, 3).join(', ')}.`);
  const rps = checkNumber(d.rateLimitRps, { label: 'Requests per second', min: 1, max: 50, integer: true });
  if (rps) errors.push(rps);
  const burst = checkNumber(d.burst, { label: 'Burst', min: 1, max: 100, integer: true });
  if (burst) errors.push(burst);
  return errors;
}

export function buildApiKey(d: ApiKeyDraft) {
  const origins = parseOrigins(d.origins);
  return {
    name: d.name.trim(),
    ...(origins.length ? { allowedOrigins: origins } : {}),
    rateLimitRps: Number(d.rateLimitRps),
    burst: Number(d.burst),
  };
}

export const GRACE_RULE: NumberRule = { label: 'Grace period (hours)', min: 0, max: 720, integer: true, default: 168 };

// ------------------------------------------------------------------ errors and labels

/** Friendly text for the problem codes these settings return (RFC 7807 `code`). */
export const SETTINGS_ERRORS: Record<string, string> = {
  'last-admin': 'This is the last active Admin. Make someone else Admin first.',
  'cannot-change-own-role': 'You cannot change your own role. Ask another Admin.',
  'version-mismatch': 'Someone changed this meanwhile. Reload to see the latest values, then try again.',
  'email-already-invited': 'This e-mail already has a pending invitation.',
  'user-exists': 'This e-mail already belongs to a user.',
  'invitation-already-accepted': 'The invitation was already accepted. Deactivate the user instead.',
  'micromarket-alias-taken': 'That name or alias already belongs to another node.',
  'idempotency-key-reused': 'This request was already sent with different values. Try again.',
};

export const shortId = (id: string | null | undefined): string => (id ? `${id.slice(0, 8)}…` : '—');

export const STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'plain'> = {
  active: 'good',
  invited: 'warn',
  deactivated: 'plain',
  rotating: 'warn',
  revoked: 'bad',
};
