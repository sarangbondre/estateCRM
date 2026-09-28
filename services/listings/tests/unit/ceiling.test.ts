// Publication ceiling (BRD §4.6, PRD §4.6, LLD §4.1) and auto-downgrade (LLD §4.3).
import { describe, expect, it } from 'vitest';
import { autoChangeReason, decideDowngrade, restoredLevel } from '../../src/domain/autoDowngrade.js';
import {
  computeDemandCeiling,
  computeOfferCeiling,
  computeProjectCeiling,
} from '../../src/domain/ceiling.js';
import type { OfferCeilingInput } from '../../src/domain/ceiling.js';
import { demand, offer, project } from './fixtures.js';

const pilot = { agentNumberRequired: false };
const production = { agentNumberRequired: true };

const input = (over: Partial<OfferCeilingInput> = {}): OfferCeilingInput => ({
  offer: offer(),
  agentNumberSet: true,
  projectReraNumber: null,
  readyRealSelectedPhotos: 1,
  currentLevel: 'Private',
  classifiable: true,
  ...over,
});

describe('offer ceiling', () => {
  it('is Public for a Fresh, Verified offer with a processed real photo', () => {
    expect(computeOfferCeiling(input(), production)).toEqual({ ceiling: 'Public', reasons: [] });
  });

  it('treats a missing life stage as Fresh (journeys has not reported yet)', () => {
    expect(computeOfferCeiling(input({ offer: offer({ lifeStage: null }) }), production).ceiling).toBe(
      'Public',
    );
  });

  it.each([
    [{ commercialStatus: 'Closed' }, 'commercial_closed'],
    [{ commercialStatus: 'Inactive' }, 'commercial_inactive'],
    [{ voidedReason: 'side_changed' }, 'voided'],
    [{ mergedIntoId: '00000000-0000-4000-8000-000000000999' }, 'merged'],
    [{ lifeStage: 'Expired' as const }, 'life_expired'],
    [{ lifeStage: 'Paused' as const }, 'life_paused'],
    [{ outsideLaunchArea: true }, 'outside_launch_area'],
  ])('caps at Private: %o → %s', (patch, reason) => {
    const r = computeOfferCeiling(input({ offer: offer(patch) }), production);
    expect(r.ceiling).toBe('Private');
    expect(r.reasons).toContain(reason);
  });

  it('retired unwilling is never publishable (both reasons)', () => {
    const r = computeOfferCeiling(
      input({ offer: offer({ commercialStatus: 'Inactive', retiredReason: 'unwilling' }) }),
      production,
    );
    expect(r).toEqual({ ceiling: 'Private', reasons: ['commercial_inactive', 'retired_unwilling'] });
    // Even if a later status arrives first, unwilling stays.
    expect(
      computeOfferCeiling(
        input({ offer: offer({ commercialStatus: 'Available', retiredReason: 'unwilling' }) }),
        production,
      ).reasons,
    ).toContain('retired_unwilling');
  });

  it('Sale/Primary needs the project RERA number', () => {
    const o = offer({
      dealType: 'Sale',
      market: 'Primary',
      rentMonthlyInrMin: null,
      salePriceInrMin: 1_20_00_000,
    });
    expect(computeOfferCeiling(input({ offer: o }), production)).toEqual({
      ceiling: 'Private',
      reasons: ['project_rera_missing'],
    });
    expect(
      computeOfferCeiling(input({ offer: o, projectReraNumber: 'P51800012345' }), production).ceiling,
    ).toBe('Public');
  });

  it('A-L1: Stale keeps Anonymous for items already published but blocks new publishing', () => {
    const stale = offer({ lifeStage: 'Stale' });
    expect(computeOfferCeiling(input({ offer: stale, currentLevel: 'Public' }), production).ceiling).toBe(
      'Anonymous',
    );
    expect(computeOfferCeiling(input({ offer: stale, currentLevel: 'Anonymous' }), production).ceiling).toBe(
      'Anonymous',
    );
    expect(computeOfferCeiling(input({ offer: stale, currentLevel: 'Private' }), production)).toEqual({
      ceiling: 'Private',
      reasons: ['life_stale'],
    });
  });

  it('not verified or no real photo caps at Anonymous, and every failing reason is listed', () => {
    const r = computeOfferCeiling(
      input({ offer: offer({ recordStage: 'Enriched', hasRealPhotos: false }), readyRealSelectedPhotos: 0 }),
      production,
    );
    expect(r).toEqual({ ceiling: 'Anonymous', reasons: ['not_verified', 'no_real_photos'] });
    expect(computeOfferCeiling(input({ readyRealSelectedPhotos: 0 }), production).reasons).toEqual([
      'no_real_photos',
    ]);
  });

  it('an unclassifiable offer (no label or segment) cannot be served', () => {
    expect(computeOfferCeiling(input({ classifiable: false }), production).ceiling).toBe('Private');
  });

  it('the agent number is mandatory in production only (pilot: "registration pending", questionnaire A7)', () => {
    expect(computeOfferCeiling(input({ agentNumberSet: false }), production)).toEqual({
      ceiling: 'Private',
      reasons: ['agent_rera_missing'],
    });
    expect(computeOfferCeiling(input({ agentNumberSet: false }), pilot).ceiling).toBe('Public');
  });

  it('the lowest cap decides when several apply', () => {
    const r = computeOfferCeiling(
      input({
        offer: offer({ recordStage: 'Captured', commercialStatus: 'Closed' }),
        readyRealSelectedPhotos: 0,
      }),
      production,
    );
    expect(r.ceiling).toBe('Private');
    expect(r.reasons).toEqual(['commercial_closed', 'not_verified', 'no_real_photos']);
  });
});

describe('project ceiling (Private or Public, A-L3)', () => {
  it('needs the RERA numbers and one live configuration', () => {
    expect(
      computeProjectCeiling(
        { project: project(), agentNumberSet: true, configurationCeilings: ['Anonymous'] },
        production,
      ),
    ).toEqual({ ceiling: 'Public', reasons: [] });
    expect(
      computeProjectCeiling(
        { project: project({ reraNumber: null }), agentNumberSet: false, configurationCeilings: ['Private'] },
        production,
      ),
    ).toEqual({
      ceiling: 'Private',
      reasons: ['agent_rera_missing', 'project_rera_missing', 'project_no_live_configuration'],
    });
  });
});

describe('demand post ceiling (Private or Anonymous)', () => {
  it('is Anonymous while in Sourcing, Fresh or Ageing, not exited', () => {
    expect(computeDemandCeiling({ demand: demand(), agentNumberSet: true }, production)).toEqual({
      ceiling: 'Anonymous',
      reasons: [],
    });
    expect(
      computeDemandCeiling({ demand: demand({ lifeStage: 'Ageing' }), agentNumberSet: true }, production)
        .ceiling,
    ).toBe('Anonymous');
  });

  it.each([
    [{ status: 'Qualified' }, 'demand_not_sourcing'],
    [{ matched: true }, 'demand_not_sourcing'],
    [{ exitType: 'Lost' }, 'demand_exited'],
    [{ lifeStage: 'Stale' as const }, 'life_stale'],
    [{ lifeStage: 'Expired' as const }, 'life_expired'],
    [{ voidedReason: 'duplicate_discarded' }, 'voided'],
  ])('is Private: %o → %s', (patch, reason) => {
    const r = computeDemandCeiling({ demand: demand(patch), agentNumberSet: true }, production);
    expect(r.ceiling).toBe('Private');
    expect(r.reasons).toContain(reason);
  });
});

describe('auto-downgrade (LLD §4.3 table)', () => {
  it('maps causes to publication.changed reasons', () => {
    expect(autoChangeReason(['life_stale'])).toBe('ceiling_dropped');
    expect(autoChangeReason(['life_expired'])).toBe('expired');
    expect(autoChangeReason(['life_paused'])).toBe('expired');
    expect(autoChangeReason(['commercial_closed'])).toBe('closed');
    expect(autoChangeReason(['commercial_inactive', 'retired_unwilling'])).toBe('retired');
    expect(autoChangeReason(['merged'])).toBe('merged');
    expect(autoChangeReason(['voided', 'commercial_closed'])).toBe('voided');
    expect(autoChangeReason(['not_verified'])).toBe('ceiling_dropped');
  });

  it('downgrades Public → Anonymous at Stale and withdraws at Expired; never raises', () => {
    expect(decideDowngrade('offer', 'Public', 'Anonymous', ['life_stale'])).toEqual({
      level: 'Anonymous',
      reason: 'ceiling_dropped',
    });
    expect(decideDowngrade('offer', 'Anonymous', 'Private', ['life_expired'])).toEqual({
      level: 'Private',
      reason: 'expired',
    });
    expect(decideDowngrade('offer', 'Anonymous', 'Public', [])).toBeNull();
    // A project has no Anonymous level: an Anonymous ceiling means Private.
    expect(decideDowngrade('project', 'Public', 'Anonymous', ['project_no_live_configuration'])?.level).toBe(
      'Private',
    );
  });

  it('merge undo restores the prior level capped at the ceiling', () => {
    expect(restoredLevel('offer', 'Public', 'Anonymous')).toBe('Anonymous');
    expect(restoredLevel('offer', 'Anonymous', 'Public')).toBe('Anonymous');
  });
});
