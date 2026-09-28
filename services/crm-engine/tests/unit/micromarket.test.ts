// Micromarket hierarchy, proximity and adjacency (LLD §4.8, R-13; BRD §7 "Andheri East containing Chakala, Marol, MIDC").
import { describe, expect, it } from 'vitest';
import { Hierarchy, proximity } from '../../src/domain/micromarket.js';
import { MM, SOURCE, demand, hierarchy as h } from './fixtures.js';

describe('Hierarchy', () => {
  it('resolves names and aliases with R-11 matching (trim, case-fold, whitespace)', () => {
    expect(h.resolve('  andheri   EAST ', ['micromarket'])?.key).toBe(MM.andheriEast);
    expect(h.resolve('bkc', ['micromarket'])?.key).toBe(MM.bkc);
    expect(h.resolve('Nowhere', ['micromarket'])).toBeUndefined();
    expect(h.resolve('Western Suburbs', ['micromarket', 'locality'])).toBeUndefined(); // zones never used
  });

  it('offer path = most specific node + ancestors up to micromarket (zone excluded)', () => {
    expect(h.offerPath('Andheri East', 'Chakala')).toEqual([MM.chakala, MM.andheriEast]);
    expect(h.offerPath('Andheri East', 'Marol Naka')).toEqual([MM.marolNaka, MM.marol, MM.andheriEast]);
    expect(h.offerPath('Andheri East', null)).toEqual([MM.andheriEast]);
    expect(h.offerPath(null, 'Marol')).toEqual([MM.marol, MM.andheriEast]);
    expect(h.offerPath('Andheri East', 'Unknown Lane')).toEqual([MM.andheriEast]);
    expect(h.offerPath('Unknown', 'Unknown Lane')).toEqual([]);
  });

  it('demand expansion = listed nodes + descendants + parent micromarket of listed localities', () => {
    expect(h.demandExpanded(['Andheri East'], [])).toEqual(
      [MM.andheriEast, MM.chakala, MM.marol, MM.midc, MM.sakiNaka, MM.marolNaka].sort(),
    );
    expect(h.demandExpanded([], ['Marol'])).toEqual([MM.andheriEast, MM.marol, MM.marolNaka].sort());
    expect(h.demandExpanded(['Western Suburbs'], [])).toEqual([]);
  });

  it('adjacency is symmetric even when only listed on one side', () => {
    expect(h.sameOrAdjacent(MM.andheriEast, MM.powai)).toBe(true);
    expect(h.sameOrAdjacent(MM.powai, MM.andheriEast)).toBe(true);
    expect(h.sameOrAdjacent(MM.powai, MM.andheriWest)).toBe(false);
    expect(h.sameOrAdjacent(MM.bkc, MM.bkc)).toBe(true);
  });

  it('prefers a same-named locality under the given micromarket', () => {
    const twin = Hierarchy.fromSource([
      ...SOURCE,
      {
        id: 'loc-marol-2',
        parentId: MM.powai,
        level: 'locality',
        name: 'Marol',
        aliases: [],
        adjacentIds: [],
        inLaunchArea: true,
      },
    ]);
    expect(twin.offerPath('Powai', 'Marol')).toEqual(['loc-marol-2', MM.powai]);
    expect(twin.offerPath('Andheri East', 'Marol')).toEqual([MM.marol, MM.andheriEast]);
  });

  it('survives a parent cycle in bad reference data', () => {
    const bad = Hierarchy.fromSource([
      {
        id: 'a',
        parentId: 'b',
        level: 'locality',
        name: 'A',
        aliases: [],
        adjacentIds: [],
        inLaunchArea: true,
      },
      {
        id: 'b',
        parentId: 'a',
        level: 'micromarket',
        name: 'B',
        aliases: [],
        adjacentIds: [],
        inLaunchArea: true,
      },
    ]);
    expect(bad.ancestry('a').map((x) => x.key)).toEqual(['a', 'b']);
    expect(bad.descendants('b')).toEqual(['a']);
  });
});

describe('proximity (micromarket factor levels)', () => {
  it('sameLocality when the offer is in a listed locality or a sub-locality under it', () => {
    const d = demand({ micromarkets: [], localities: ['Marol'] });
    expect(proximity(h, h.offerPath('Andheri East', 'Marol'), d)).toBe('sameLocality');
    expect(proximity(h, h.offerPath('Andheri East', 'Marol Naka'), d)).toBe('sameLocality');
  });
  it('sameMicromarket when the offer lies in a listed micromarket (Chakala is inside Andheri East)', () => {
    const d = demand({ micromarkets: ['Andheri East'], localities: [] });
    expect(proximity(h, h.offerPath('Andheri East', 'Chakala'), d)).toBe('sameMicromarket');
    expect(proximity(h, h.offerPath('Andheri East', null), d)).toBe('sameMicromarket');
  });
  it('coarserLevel when the offer is known only at micromarket level for a locality demand', () => {
    const d = demand({ micromarkets: [], localities: ['Marol'] });
    expect(proximity(h, h.offerPath('Andheri East', null), d)).toBe('coarserLevel');
  });
  it('a sibling locality overlaps through the parent micromarket (literal LLD §4.8 expansion) at coarserLevel', () => {
    const d = demand({ micromarkets: [], localities: ['Marol'] });
    expect(proximity(h, h.offerPath('Andheri East', 'Chakala'), d)).toBe('coarserLevel');
  });
  it('none outside the area', () => {
    const d = demand({ micromarkets: [], localities: ['Marol'] });
    expect(proximity(h, h.offerPath('Powai', null), d)).toBe('none');
    expect(proximity(h, h.offerPath('Powai', 'Hiranandani Gardens'), d)).toBe('none');
    expect(proximity(h, [], d)).toBe('none');
  });
});
