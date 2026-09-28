// Domain: standard schema, strict/mapping detection (D-15, LLD §4.2), fingerprints, suggestions, mapping rules.
import { describe, expect, it } from 'vitest';
import { EXTRACTOR_COLUMNS } from '@11e/testing';
import {
  STANDARD_COLUMNS,
  chooseLoadSheet,
  headerFingerprint,
  isStrictHeader,
  normaliseHeader,
  suggestMapping,
  validateMapping,
} from '../../src/domain/schema.js';

describe('standard schema', () => {
  it('has the 89 Appendix C columns (same list as the synthetic generator, which is checked against the PRD)', () => {
    expect(STANDARD_COLUMNS).toHaveLength(89);
    expect([...STANDARD_COLUMNS]).toEqual([...EXTRACTOR_COLUMNS]);
  });

  it('normalises headers: trim, lower-case, spaces and hyphens to _', () => {
    expect(normaliseHeader('  Record ID ')).toBe('record_id');
    expect(normaliseHeader('Follow-Up  Date')).toBe('follow_up_date');
  });
});

describe('strict vs mapping mode', () => {
  it('is strict only when the normalised header set equals the 89 names, in any order and case', () => {
    const shuffled = [...STANDARD_COLUMNS].reverse().map((c) => c.toUpperCase().replace(/_/g, ' '));
    expect(isStrictHeader(shuffled)).toBe(true);
  });

  it('is mapping mode with a missing, an extra or a repeated column (Q-I1)', () => {
    expect(isStrictHeader(STANDARD_COLUMNS.slice(1))).toBe(false);
    expect(isStrictHeader([...STANDARD_COLUMNS, 'extra'])).toBe(false);
    expect(isStrictHeader([...STANDARD_COLUMNS.slice(1), 'record_id'])).toBe(false);
  });

  it('fingerprints ignore order, case and spacing', () => {
    expect(headerFingerprint(['Mobile', 'Name', 'Lead ID'])).toBe(
      headerFingerprint(['lead_id', 'name ', 'MOBILE']),
    );
    expect(headerFingerprint(['a'])).not.toBe(headerFingerprint(['b']));
  });

  it('loads the Leads sheet, else the first data sheet', () => {
    expect(chooseLoadSheet(['run_log', 'leads', 'migration_map'])).toBe('leads');
    expect(chooseLoadSheet(['migration_map', 'Sheet1'])).toBe('Sheet1');
    expect(chooseLoadSheet([])).toBeNull();
  });
});

describe('suggested mapping', () => {
  it('uses exact names, then synonyms, and never maps a single-use target twice', () => {
    expect(
      suggestMapping([
        'Lead ID',
        'Mobile',
        'Alternate Number',
        'Rent',
        'Campaign',
        'record_scope',
        'rent',
        'Colour',
      ]),
    ).toEqual({
      'Lead ID': 'external_id',
      Mobile: 'phones',
      'Alternate Number': 'phones',
      Rent: 'rent_monthly_inr_min',
      Campaign: 'campaign_ref',
      record_scope: 'record_scope',
      rent: null,
      Colour: null,
    });
  });

  it('prefers the matching template', () => {
    expect(suggestMapping(['Col A', 'Col B'], { 'Col A': 'raw_text', 'Col B': null })).toEqual({
      'Col A': 'raw_text',
      'Col B': null,
    });
  });
});

describe('mapping validation (LLD §4.2 step 5)', () => {
  const headers = ['Name', 'Mobile', 'Mobile 2', 'Text', 'Type', 'Campaign'];
  it('accepts multi-mapped phones and a classifier input', () => {
    expect(
      validateMapping(
        { Name: 'contact_name', Mobile: 'phones', 'Mobile 2': 'phones', Text: 'raw_text' },
        {},
        'Direct',
        headers,
      ),
    ).toEqual([]);
  });

  it('rejects a single-use target used twice, unknown columns and a missing classifier input', () => {
    const codes = validateMapping(
      { Name: 'contact_name', Mobile: 'contact_name', Nope: 'phones' },
      {},
      'Direct',
      headers,
    ).map((i) => i.code);
    expect(codes).toEqual(['duplicate-target', 'unknown-column', 'classifier-input-missing']);
  });

  it('accepts record_scope as a constant, but only a vocabulary value', () => {
    expect(validateMapping({ Name: 'contact_name' }, { recordScope: 'property' }, 'Direct', headers)).toEqual(
      [],
    );
    expect(
      validateMapping({ Name: 'contact_name' }, { recordScope: 'House' }, 'Direct', headers)[0]?.code,
    ).toBe('value-not-in-list');
  });

  it('requires a Digi reference when the header has a candidate column', () => {
    const map = { Text: 'raw_text' };
    expect(validateMapping(map, {}, 'Digi', headers).map((i) => i.code)).toEqual(['digi-reference-missing']);
    expect(validateMapping({ ...map, Campaign: 'campaign_ref' }, {}, 'Digi', headers)).toEqual([]);
    expect(validateMapping(map, {}, 'Digi', ['Text'])).toEqual([]);
  });
});
