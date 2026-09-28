// Settings page logic (WEB-08): tab visibility per role (PRD §2.3), merge-patch building, audit filter → query
// mapping, contract validation of numeric settings, capacities join, micromarket patch and key/RERA validation.
import { describe, expect, it } from 'vitest';
import {
  CAPACITY_RULE,
  EMPTY_AUDIT_FILTERS,
  LIFE_CURVE_FIELDS,
  MATCH_WEIGHT_FIELDS,
  QUEUE_WEIGHT_FIELDS,
  applyDraft,
  auditQuery,
  buildApiKey,
  buildInvite,
  buildMicromarketPatch,
  buildUserPatch,
  canEdit,
  canOpenSettings,
  capacityRows,
  checkNumber,
  formatDetails,
  isDirty,
  mergePatch,
  micromarketDraft,
  normalizeAction,
  parentLevel,
  parseAliases,
  reraPending,
  resolveTab,
  shares,
  toDraft,
  validateApiKey,
  validateInvite,
  validateLifeCurve,
  validateMatchWeights,
  validateQueueWeights,
  validateRera,
  visibleTabs,
} from '@/ui/settings/logic';
import type { Capacity, Micromarket, User } from '@/ui/settings/logic';

const user = (p: Partial<User> = {}): User => ({
  userId: '00000000-0000-4000-8000-000000000001',
  displayName: 'Priyanka',
  role: 'Demand agent',
  status: 'active',
  isDataOperator: false,
  version: 3,
  ...p,
});

describe('tab visibility per role (PRD §2.3)', () => {
  it('Admin sees all ten tabs and edits all but vocabulary and audit', () => {
    const tabs = visibleTabs('Admin').map((t) => t.slug);
    expect(tabs).toEqual([
      'users',
      'capacities',
      'life-curve',
      'queue-weights',
      'match-weights',
      'micromarkets',
      'vocabulary',
      'publication',
      'api-keys',
      'audit',
    ]);
    expect(canEdit('users', 'Admin')).toBe(true);
    expect(canEdit('vocabulary', 'Admin')).toBe(false);
  });

  it('Manager reads the directory and reference data, edits only capacities, never keys/RERA/audit', () => {
    const tabs = visibleTabs('Manager').map((t) => t.slug);
    expect(tabs).toContain('users');
    expect(tabs).toContain('capacities');
    expect(tabs).not.toContain('api-keys');
    expect(tabs).not.toContain('audit');
    expect(tabs).not.toContain('publication');
    expect(canEdit('capacities', 'Manager')).toBe(true);
    expect(canEdit('users', 'Manager')).toBe(false);
    expect(canEdit('life-curve', 'Manager')).toBe(false);
    expect(canEdit('match-weights', 'Manager')).toBe(false);
  });

  it('agents and Data operators cannot open Settings', () => {
    for (const r of ['Demand agent', 'Supply agent', 'Data operator']) {
      expect(canOpenSettings(r)).toBe(false);
      expect(visibleTabs(r)).toEqual([]);
      expect(resolveTab('users', r)).toBeNull();
    }
    expect(canOpenSettings('Admin')).toBe(true);
    expect(canOpenSettings('Manager')).toBe(true);
  });

  it('?tab= deep link falls back to the first visible tab when unknown or not allowed', () => {
    expect(resolveTab('audit', 'Admin')).toBe('audit');
    expect(resolveTab('audit', 'Manager')).toBe('users');
    expect(resolveTab('nonsense', 'Admin')).toBe('users');
    expect(resolveTab(undefined, 'Manager')).toBe('users');
  });
});

describe('merge patch building (RFC 7396, only changed fields)', () => {
  it('keeps only changed fields', () => {
    expect(mergePatch({ a: 1, b: 'x', c: [1, 2] }, { a: 1, b: 'y', c: [1, 2] })).toEqual({ b: 'y' });
    expect(mergePatch({ a: [1] }, { a: [1, 2] })).toEqual({ a: [1, 2] });
    expect(mergePatch({ p: null }, { p: null })).toEqual({});
  });

  it('user patch: role only, trimmed name ignored when unchanged, null when nothing changed', () => {
    const u = user();
    expect(buildUserPatch(u, { displayName: ' Priyanka ', role: 'Manager', isDataOperator: false })).toEqual({ role: 'Manager' });
    expect(buildUserPatch(u, { displayName: 'Priyanka', role: 'Demand agent', isDataOperator: true })).toEqual({ isDataOperator: true });
    expect(buildUserPatch(u, { displayName: 'Priyanka S', role: 'Demand agent', isDataOperator: false })).toEqual({ displayName: 'Priyanka S' });
    expect(buildUserPatch(u, { displayName: 'Priyanka', role: 'Demand agent', isDataOperator: false })).toBeNull();
  });

  it('micromarket patch: aliases parsed, adjacency order ignored', () => {
    const m: Micromarket = {
      id: 'm1',
      level: 'micromarket',
      name: 'Andheri East',
      city: 'Mumbai',
      inLaunchArea: true,
      aliases: ['Andheri E'],
      adjacentIds: ['b', 'a'],
      parentId: 'z1',
      version: 2,
    };
    const d = micromarketDraft(m);
    expect(buildMicromarketPatch(m, { ...d, adjacentIds: ['a', 'b'] })).toBeNull();
    expect(buildMicromarketPatch(m, { ...d, aliases: 'Andheri E, Andheri (E), andheri e' })).toEqual({ aliases: ['Andheri E', 'Andheri (E)'] });
    expect(buildMicromarketPatch(m, { ...d, name: ' Andheri (East) ' })).toEqual({ name: 'Andheri (East)' });
  });
});

describe('audit filters → listAuditLog query', () => {
  it('maps an action prefix to "stem.*"', () => {
    expect(normalizeAction('export', 'prefix')).toBe('export.*');
    expect(normalizeAction('export.', 'prefix')).toBe('export.*');
    expect(normalizeAction('export.*', 'prefix')).toBe('export.*');
    expect(normalizeAction('export*', 'exact')).toBe('export.*');
    expect(normalizeAction(' contact.viewed ', 'exact')).toBe('contact.viewed');
    expect(normalizeAction('*', 'prefix')).toBe('');
  });

  it('builds the query from set filters only; dates are whole IST days', () => {
    const r = auditQuery({
      ...EMPTY_AUDIT_FILTERS,
      action: 'merge',
      actionMode: 'prefix',
      producer: 'records',
      subjectType: 'offer',
      from: '2026-09-01',
      to: '2026-09-28',
    });
    expect(r.errors).toEqual([]);
    expect(r.query).toEqual({
      action: 'merge.*',
      producer: 'records',
      subjectType: 'offer',
      from: '2026-09-01T00:00:00+05:30',
      to: '2026-09-28T23:59:59.999+05:30',
    });
    expect(auditQuery(EMPTY_AUDIT_FILTERS)).toEqual({ query: {}, errors: [] });
  });

  it('rejects a non-UUID subject id, reversed dates and unknown producers', () => {
    const r = auditQuery({ ...EMPTY_AUDIT_FILTERS, subjectId: 'OFF-1', from: '2026-09-28', to: '2026-09-01', producer: 'x' });
    expect(r.errors).toHaveLength(3);
    expect(r.query.subjectId).toBeUndefined();
  });

  it('formats PII-free details briefly', () => {
    expect(formatDetails({ rows: 12, format: 'xlsx' })).toBe('rows: 12 · format: xlsx');
    expect(formatDetails(undefined)).toBe('');
    expect(formatDetails({ a: 'x'.repeat(300) }, 20)).toHaveLength(20);
  });
});

describe('numeric settings validation (contract min/max)', () => {
  it('checkNumber: required, numeric, integer, range', () => {
    expect(checkNumber('', CAPACITY_RULE)).toMatch(/required/);
    expect(checkNumber('abc', CAPACITY_RULE)).toMatch(/number/);
    expect(checkNumber('40.5', CAPACITY_RULE)).toMatch(/whole/);
    expect(checkNumber('-1', CAPACITY_RULE)).toMatch(/at least 0/);
    expect(checkNumber('201', CAPACITY_RULE)).toMatch(/at most 200/);
    expect(checkNumber('40', CAPACITY_RULE)).toBeNull();
  });

  // Optional fields absent, as a mock or an older row may return them.
  const qw = { version: 4, freshness: 0.25, demandGap: 0.35, sourceQuality: 0.2, priceBand: 0.2, updatedAt: '2026-09-01T00:00:00Z' };

  it('queue weights: defaults fill absent optional fields; all-zero weights and out-of-range values are rejected', () => {
    const d = toDraft(qw, QUEUE_WEIGHT_FIELDS);
    expect(d.maxAttempts).toBe('3');
    expect(validateQueueWeights(d)).toEqual({});
    expect(Object.keys(validateQueueWeights({ ...d, freshness: '1.5' }))).toEqual(['freshness']);
    const zero = { ...d, freshness: '0', demandGap: '0', sourceQuality: '0', priceBand: '0' };
    expect(validateQueueWeights(zero).freshness).toMatch(/at least one weight/);
    expect(validateQueueWeights({ ...d, maxAttempts: '11' }).maxAttempts).toMatch(/at most 10/);
  });

  it('applyDraft writes numbers into the PUT body and drops audit fields; isDirty tracks edits', () => {
    const d = { ...toDraft(qw, QUEUE_WEIGHT_FIELDS), demandGap: '0.5' };
    const body = applyDraft(qw, d, QUEUE_WEIGHT_FIELDS);
    expect(body.demandGap).toBe(0.5);
    expect(body.version).toBe(4);
    expect('updatedAt' in body).toBe(false);
    expect(isDirty(qw, toDraft({ ...qw, maxAttempts: 3, freshnessHorizonDays: 60, demandGapCap: 20, mustCallDueHours: 24, stalePublicBoost: 15, ageingReconfirmBoost: 5 }, QUEUE_WEIGHT_FIELDS), QUEUE_WEIGHT_FIELDS)).toBe(true);
    const full = applyDraft(qw, toDraft(qw, QUEUE_WEIGHT_FIELDS), QUEUE_WEIGHT_FIELDS);
    expect(isDirty(full, toDraft(full, QUEUE_WEIGHT_FIELDS), QUEUE_WEIGHT_FIELDS)).toBe(false);
  });

  it('match weights: nested paths, bundle offers 2..3', () => {
    const w = {
      version: 1,
      factors: { micromarket: 0.25, price: 0.25, area: 0.2, bhk: 0.1, timing: 0.1, furnishing: 0.1 },
      tuning: {},
    };
    const d = toDraft(w, MATCH_WEIGHT_FIELDS);
    expect(d['tuning.bundleMaxOffers']).toBe('3');
    expect(validateMatchWeights(d)).toEqual({});
    expect(validateMatchWeights({ ...d, 'tuning.bundleMaxOffers': '4' })['tuning.bundleMaxOffers']).toMatch(/at most 3/);
    const body = applyDraft(w, { ...d, 'tuning.proximity.sameMicromarket': '0.9' }, MATCH_WEIGHT_FIELDS);
    expect((body.tuning as { proximity: { sameMicromarket: number } }).proximity.sameMicromarket).toBe(0.9);
    expect(shares({ a: '1', b: '3' }, ['a', 'b'])).toEqual({ a: 0.25, b: 0.75 });
  });

  it('life curve: fresh < ageing < stale per category', () => {
    const t = (f: number, a: number, s: number) => ({ freshMaxDays: f, ageingMaxDays: a, staleMaxDays: s });
    const lc = {
      version: 1,
      offer: {
        lease_residential: t(15, 30, 45),
        lease_commercial: t(30, 60, 90),
        sale_secondary: t(30, 60, 90),
        sale_primary: t(60, 120, 180),
        industrial: t(45, 90, 120),
        land_jv: t(60, 120, 180),
      },
      demand: {
        lease_residential: t(15, 30, 45),
        lease_commercial: t(30, 60, 90),
        sale_secondary_any: t(30, 60, 90),
        sale_primary: t(60, 120, 180),
        industrial: t(45, 90, 120),
        land_jv: t(60, 120, 180),
      },
    };
    const d = toDraft(lc, LIFE_CURVE_FIELDS);
    expect(d.dormantRevisitDays).toBe('60');
    expect(validateLifeCurve(d)).toEqual({});
    const bad = validateLifeCurve({ ...d, 'offer.industrial.ageingMaxDays': '130' });
    expect(Object.keys(bad)).toEqual(['offer.industrial.staleMaxDays']);
    expect(validateLifeCurve({ ...d, 'demand.land_jv.freshMaxDays': '0' })['demand.land_jv.freshMaxDays']).toMatch(/at least 1/);
  });
});

describe('capacities (default 40, questionnaire C6)', () => {
  it('joins users with stored capacities; default for users without a row; skips deactivated and Data operators', () => {
    const users = [
      user({ userId: 'u1', displayName: 'Vinit', role: 'Supply agent' }),
      user({ userId: 'u2', displayName: 'Priyanka' }),
      user({ userId: 'u3', displayName: 'Gone', status: 'deactivated' }),
      user({ userId: 'u4', displayName: 'Ops', role: 'Data operator' }),
    ];
    const caps: Capacity[] = [
      { userId: 'u2', team: 'demand', dailyCalls: 35, version: 2 },
      { userId: 'u9', team: 'supply', dailyCalls: 10, version: 1 },
    ];
    const rows = capacityRows(users, caps);
    expect(rows.map((r) => [r.name, r.team, r.dailyCalls, r.version])).toEqual([
      ['Vinit', 'supply', 40, null],
      ['Priyanka', 'demand', 35, 2],
      ['u9…', 'supply', 10, 1],
    ]);
  });
});

describe('invitations, micromarkets, publication, API keys', () => {
  it('invite: e-mail and role required; name optional and trimmed', () => {
    expect(validateInvite({ email: 'x', displayName: '', role: null, isDataOperator: false })).toHaveLength(2);
    const d = { email: ' Vinit@11Estates.in ', displayName: '  ', role: 'Supply agent' as const, isDataOperator: true };
    expect(validateInvite(d)).toEqual([]);
    expect(buildInvite(d)).toEqual({ email: 'vinit@11estates.in', role: 'Supply agent', isDataOperator: true });
  });

  it('hierarchy helpers', () => {
    expect(parentLevel('zone')).toBeNull();
    expect(parentLevel('locality')).toBe('micromarket');
    expect(parseAliases('a, b\nA,, c')).toEqual(['a', 'b', 'c']);
  });

  it('MahaRERA number: letter + 11 digits; pending when absent (A7)', () => {
    expect(validateRera('a51900012345')).toBeNull();
    expect(validateRera('A5190001234')).toMatch(/letter and 11 digits/);
    expect(validateRera('')).toMatch(/Enter/);
    expect(reraPending({ mahareraAgentNumber: '' })).toBe(true);
    expect(reraPending(undefined)).toBe(true);
    expect(reraPending({ mahareraAgentNumber: 'A51900012345' })).toBe(false);
  });

  it('API key: name 2..80, URL origins, rate limits in range', () => {
    const ok = { name: '11estates.in', origins: 'https://11estates.in, https://www.11estates.in', rateLimitRps: '50', burst: '100' };
    expect(validateApiKey(ok)).toEqual([]);
    expect(buildApiKey(ok)).toEqual({
      name: '11estates.in',
      allowedOrigins: ['https://11estates.in', 'https://www.11estates.in'],
      rateLimitRps: 50,
      burst: 100,
    });
    expect(validateApiKey({ name: 'x', origins: 'not a url', rateLimitRps: '51', burst: '0' })).toHaveLength(4);
  });
});
