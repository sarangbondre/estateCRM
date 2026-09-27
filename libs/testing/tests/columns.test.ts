import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXTRACTOR_COLUMNS } from '../src/index.js';

/** Column names of PRD Appendix C, parsed from the approved PRD (first backticked cell of each table row). */
function appendixCColumns(): string[] {
  const prd = readFileSync(new URL('../../../docs/02-prd.md', import.meta.url), 'utf8');
  const start = prd.indexOf('## Appendix C');
  expect(start).toBeGreaterThan(0);
  const rest = prd.slice(start + 3);
  const end = rest.search(/^## /m);
  const section = end === -1 ? rest : rest.slice(0, end);
  const names: string[] = [];
  for (const line of section.split('\n')) {
    const match = /^\|\s*`([a-z_]+)`\s*\|/.exec(line);
    if (match?.[1] !== undefined) names.push(match[1]);
  }
  return names;
}

describe('extractor column schema', () => {
  it('has 89 distinct columns', () => {
    expect(EXTRACTOR_COLUMNS).toHaveLength(89);
    expect(new Set(EXTRACTOR_COLUMNS).size).toBe(89);
  });

  it('equals PRD Appendix C exactly, in the same order', () => {
    const prd = appendixCColumns();
    expect(prd).toHaveLength(89);
    expect([...EXTRACTOR_COLUMNS]).toEqual(prd);
  });
});
