import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AREA_BASES,
  DEAL_TYPES,
  FIELDS,
  PROPERTY_TYPES,
  PROPERTY_TYPES_BY_SEGMENT,
  RECORD_SCOPES,
  RECORD_SCOPE_RULES,
  SIDES,
  VOCABULARY_FIELDS,
  VOCABULARY_RELEASE_ID,
  VOCABULARY_VERSION,
  releaseContent,
} from '../src/index.js';

const contract = (path: string): string =>
  readFileSync(new URL(`../../../contracts/${path}`, import.meta.url), 'utf8');

describe('release v0.6 data (BRD §4.2, PRD Appendix C)', () => {
  it('version', () => {
    expect(VOCABULARY_VERSION).toBe('0.6');
    expect(VOCABULARY_RELEASE_ID).toBe('v0.6');
  });

  it('property types per segment match the BRD counts and are unique across segments', () => {
    expect(PROPERTY_TYPES_BY_SEGMENT.Residential).toHaveLength(9);
    expect(PROPERTY_TYPES_BY_SEGMENT.Commercial).toHaveLength(10);
    expect(PROPERTY_TYPES_BY_SEGMENT.Industrial).toHaveLength(6);
    expect(PROPERTY_TYPES_BY_SEGMENT.Land).toHaveLength(3);
    expect(new Set(PROPERTY_TYPES).size).toBe(28);
  });

  it('record scope rules cover every scope and use known deal types and sides', () => {
    for (const scope of RECORD_SCOPES) {
      const rule = RECORD_SCOPE_RULES[scope];
      expect(rule.value).toBe(scope);
      for (const dealType of rule.allowedDealTypes) expect(DEAL_TYPES).toContain(dealType);
      for (const side of rule.sides) expect(SIDES).toContain(side);
    }
  });

  it('deal_type union is exactly the union of the per-scope lists', () => {
    const union = new Set(RECORD_SCOPES.flatMap((scope) => RECORD_SCOPE_RULES[scope].allowedDealTypes));
    expect([...union].sort()).toEqual([...DEAL_TYPES].sort());
  });

  it('has the 23 controlled fields of the intake strict-mode list', () => {
    expect(VOCABULARY_FIELDS).toHaveLength(23);
  });
});

describe('agreement with the contracts (values fixed by the contract)', () => {
  it('record_scope enum', () => {
    expect(contract('openapi/_common.yaml')).toContain(`enum: [${RECORD_SCOPES.join(', ')}]`);
    const pattern = new RegExp(RECORD_SCOPES.map((s) => `- "${s}"`).join('\\s+'), 'u');
    expect(contract('asyncapi/events.yaml')).toMatch(pattern);
    expect(contract('openapi/intake.yaml')).toContain(`enum: [${RECORD_SCOPES.join(', ')}, null]`);
  });

  it('side enum (Supply, Demand, None) in the events catalogue', () => {
    expect(contract('asyncapi/events.yaml')).toMatch(/- "Supply"\s+- "Demand"\s+- "None"/u);
  });

  it('area_basis enum', () => {
    expect(contract('asyncapi/events.yaml')).toMatch(/- "Carpet"\s+- "Builtup"\s+- "Saleable"/u);
    expect(AREA_BASES).toEqual(['Carpet', 'Builtup', 'Saleable']);
  });

  it('every x-vocabulary name used in the contracts is a field of the release', () => {
    const files = [
      'openapi/records.yaml',
      'openapi/intake.yaml',
      'openapi/listings.yaml',
      'openapi/crm-engine.yaml',
      'openapi/journeys.yaml',
      'openapi/insight.yaml',
      'asyncapi/events.yaml',
    ];
    const names = new Set<string>();
    for (const file of files) {
      for (const match of contract(file).matchAll(/x-vocabulary:\s*"?([a-z_]+)"?/gu))
        names.add(match[1] as string);
    }
    names.delete('field'); // insight.yaml description text "x-vocabulary field name"
    expect(names.size).toBeGreaterThan(0);
    for (const name of names) expect(VOCABULARY_FIELDS, name).toContain(name);
  });
});

describe('releaseContent (records.yaml VocabularyRelease shape)', () => {
  const content = releaseContent();

  it('carries version, every field, scopes, legacy terms and label rows', () => {
    expect(content.version).toBe('v0.6');
    expect(Object.keys(content.fields)).toEqual([...VOCABULARY_FIELDS]);
    for (const field of VOCABULARY_FIELDS) {
      expect(content.fields[field].values).toEqual(FIELDS[field].values);
      expect(content.fields[field].multi).toBe(FIELDS[field].multi);
    }
    expect(content.fields.property_type.bySegment).toEqual(PROPERTY_TYPES_BY_SEGMENT);
    expect(content.fields.segment.bySegment).toBeUndefined();
    expect(content.recordScopes.map((r) => r.value)).toEqual([...RECORD_SCOPES]);
    expect(content.legacyTerms.length).toBeGreaterThan(0);
    expect(content.displayLabels).toHaveLength(8);
  });

  it('is JSON-serialisable and stable', () => {
    expect(JSON.parse(JSON.stringify(content))).toEqual(JSON.parse(JSON.stringify(releaseContent())));
  });
});
