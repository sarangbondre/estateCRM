// Contract `pattern` keywords with a leading inline-flag group, e.g. intake UploadCreate.fileName '(?i)\.(xlsx|xls|csv)$'.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Contract, patternRegExp } from '../src/contract.js';
import type { OpenApiDoc } from '../src/index.js';

const spec = JSON.parse(
  readFileSync(new URL('../../../contracts/generated/openapi/intake.json', import.meta.url), 'utf8'),
) as OpenApiDoc;

describe('patternRegExp', () => {
  it('turns a leading (?i) into the i flag and leaves other patterns alone', () => {
    expect(patternRegExp('(?i)\\.(xlsx|csv)$', 'u').test('A.XLSX')).toBe(true);
    expect(patternRegExp('(?i)\\.(xlsx|csv)$', 'u').flags).toBe('iu');
    expect(patternRegExp('^\\d{4}$', 'u').test('2026')).toBe(true);
    expect(patternRegExp('^\\d{4}$', 'u').flags).toBe('u');
  });

  it('validates the intake createUpload body instead of failing to compile', () => {
    const contract = new Contract(spec);
    const op = contract.operations.get('createUpload');
    expect(op).toBeDefined();
    const base = {
      contentType: 'text/csv',
      sizeBytes: 10,
      sourceType: 'Direct',
    };
    expect(contract.validateBody(op!, 'application/json', { ...base, fileName: 'Leads.CSV' })).toEqual([]);
    expect(contract.validateBody(op!, 'application/json', { ...base, fileName: 'leads.pdf' })).not.toEqual(
      [],
    );
  });
});
