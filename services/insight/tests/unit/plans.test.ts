// Domain unit tests: plan validation rules (LLD §4.3), term translation and the "How I got this" description.
import { describe, expect, it } from 'vitest';
import { libraryVocabulary } from '../../src/adapters/reference.js';
import { CATALOGUE, templateOf } from '../../src/domain/plans/catalogue.js';
import { describePlan } from '../../src/domain/plans/describe.js';
import { translateTerm } from '../../src/domain/plans/termTranslator.js';
import type { QueryPlan } from '../../src/domain/plans/types.js';
import { validatePlan } from '../../src/domain/plans/validator.js';
import type { ValidationContext } from '../../src/domain/plans/validator.js';

const ctx: ValidationContext = {
  role: 'Manager',
  userId: '11111111-1111-4111-8111-111111111111',
  now: new Date('2026-10-07T06:30:00.000Z'),
  vocabulary: libraryVocabulary(),
  locations: new Map([
    ['andheri west', { name: 'Andheri West', level: 'micromarket' }],
    ['andheri w', { name: 'Andheri West', level: 'micromarket' }],
    ['chakala', { name: 'Chakala', level: 'locality' }],
  ]),
};
const v = (plan: QueryPlan, c: Partial<ValidationContext> = {}) => validatePlan(plan, templateOf(plan.planId), { ...ctx, ...c });

describe('catalogue', () => {
  it('has unique plan ids, ≤ 100 templates and filters that compile', () => {
    expect(new Set(CATALOGUE.map((t) => t.planId)).size).toBe(CATALOGUE.length);
    expect(CATALOGUE.length).toBeLessThanOrEqual(100);
    for (const t of CATALOGUE)
      for (const f of t.filters) {
        if (f.shape === 'range') expect(f.min && f.max).toBeTruthy();
        else if (t.base !== 'none') expect(f.column).toBeTruthy();
      }
  });
});

describe('term translation', () => {
  const deal = libraryVocabulary().values['deal_type'] ?? [];
  it('translates legacy terms, keeps canonical values and rejects labels', () => {
    expect(translateTerm('deal_type', 'lease', deal)).toEqual({ maps: { deal_type: 'Lease' } });
    expect(translateTerm('deal_type', 'Rent', deal)?.maps).toEqual({ deal_type: 'Lease' });
    expect(translateTerm('deal_type', 'Leave and License', deal)?.maps['deal_type']).toBe('Lease');
    expect(translateTerm('deal_type', 'new project', deal)?.maps).toEqual({ deal_type: 'Sale', market: 'Primary' });
    expect(translateTerm('property_type', 'galas', libraryVocabulary().values['property_type'] ?? [])?.maps).toEqual({ property_type: 'Gala', segment: 'Industrial' });
    expect(translateTerm('deal_type', 'For Rent', deal)).toBeUndefined();
    expect(translateTerm('deal_type', 'Wants to Buy', deal)).toBeUndefined();
  });
});

describe('validatePlan', () => {
  it('resolves locations through aliases and rejects unknown ones', () => {
    const ok = v({ planId: 'count_offers', templateVersion: 1, filters: [{ field: 'location', op: 'eq', value: 'andheri w' }] });
    expect(ok.ok && ok.value.plan.filters?.[0]?.value).toBe('Andheri West');
    const bad = v({ planId: 'count_offers', templateVersion: 1, filters: [{ field: 'location', op: 'eq', value: 'Gotham' }] });
    expect(!bad.ok && bad.errors[0]?.code).toBe('unknown-location');
    // no hierarchy yet: names are accepted as given
    const open = v({ planId: 'count_offers', templateVersion: 1, filters: [{ field: 'location', op: 'eq', value: 'Gotham' }] }, { locations: new Map() });
    expect(open.ok).toBe(true);
  });

  it('never accepts contact placeholders', () => {
    const r = v({ planId: 'list_offers', templateVersion: 1, filters: [{ field: 'location', op: 'eq', value: '⟨NAME_1⟩' }] });
    expect(!r.ok && r.errors[0]?.code).toBe('placeholder-not-allowed');
  });

  it('checks role, version, ops, BHK steps, groupBy, metrics, sort and limits', () => {
    expect(v({ planId: 'list_offers', templateVersion: 1 }, { role: 'Data operator' })).toMatchObject({ ok: false, code: 'not-allowed-for-role' });
    expect(v({ planId: 'list_offers', templateVersion: 9 })).toMatchObject({ ok: false, code: 'plan-not-in-catalogue' });
    const bhk = v({ planId: 'count_offers', templateVersion: 1, filters: [{ field: 'bhk', op: 'eq', value: 2.3 }] });
    expect(!bhk.ok && bhk.errors[0]?.message).toMatch(/0\.5/);
    expect(v({ planId: 'count_offers', templateVersion: 1, filters: [{ field: 'bhk', op: 'eq', value: 0.5 }] }).ok).toBe(true);
    const grp = v({ planId: 'group_offers', templateVersion: 1, groupBy: ['phone'] });
    expect(!grp.ok && grp.errors[0]?.code).toBe('group-by-not-allowed');
    const met = v({ planId: 'group_offers', templateVersion: 1, groupBy: ['segment'], metrics: [{ fn: 'sum', field: 'sale_price_inr' }] });
    expect(!met.ok && met.errors[0]?.code).toBe('metric-not-allowed');
    const srt = v({ planId: 'list_offers', templateVersion: 1, sort: [{ field: 'owner_phone', dir: 'asc' }] });
    expect(!srt.ok && srt.errors[0]?.code).toBe('sort-not-allowed');
    expect(validatePlan({ planId: 'list_offers', templateVersion: 1 }, templateOf('list_offers'), ctx, { limit: 500 }).ok).toBe(false);
  });

  it('resolves periods in IST and restricts "me" to the caller', () => {
    const r = v({ planId: 'list_my_followups', templateVersion: 1, filters: [{ field: 'follow_up_date', op: 'lte', value: 'today' }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.me).toBe(ctx.userId);
    expect(r.value.filters.find((f) => f.spec.field === 'follow_up_date')?.value).toBe('2026-10-07');
    expect(r.value.filters.some((f) => f.fixed && f.value === 'open')).toBe(true);
    const p = v({ planId: 'list_offers', templateVersion: 1, period: { preset: 'this_week', field: 'life_stage_since' } });
    expect(p.ok && p.value.period?.range).toEqual({ from: '2026-10-05', to: '2026-10-07' });
    const bad = v({ planId: 'list_offers', templateVersion: 1, period: { preset: 'this_week', field: 'phone' } });
    expect(!bad.ok && bad.errors[0]?.code).toBe('period-field-not-allowed');
  });

  it('describes the plan in plain English with translated terms', () => {
    const r = v({
      planId: 'count_offers',
      templateVersion: 1,
      filters: [
        { field: 'deal_type', op: 'eq', value: 'rent' },
        { field: 'bhk', op: 'eq', value: 2 },
        { field: 'location', op: 'eq', value: 'Andheri West' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(describePlan(r.value)).toBe('Offers where deal type = Lease, bhk = 2, location = Andheri West, counted');
    expect(r.value.translatedTerms).toEqual(['rent → deal_type Lease']);
  });
});
