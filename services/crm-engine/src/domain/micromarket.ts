// Micromarket hierarchy, proximity and adjacency (LLD §4.8, R-13). records owns the Mumbai hierarchy
// (zone → micromarket → locality → sub-locality, with aliases) and the Admin-maintained adjacency list; crm-engine keeps
// a copy. Zones are never used for overlap (too broad). Unknown place strings resolve to no node, so such a pair
// cannot pass the micromarket filter.
import { matchKey } from '@11e/vocabulary';

export type MmLevel = 'zone' | 'micromarket' | 'locality' | 'sub_locality';

export interface MmNode {
  key: string;
  level: MmLevel;
  name: string;
  /** R-11 keys of the name and its aliases. */
  nameKeys: string[];
  parentKey: string | null;
  adjacentKeys: string[];
  inLaunchArea: boolean;
}

/** The raw node list as records serves it (GET /v1/micromarkets). */
export interface MmSourceNode {
  id: string;
  parentId: string | null;
  level: MmLevel;
  name: string;
  aliases: string[];
  adjacentIds: string[];
  inLaunchArea: boolean;
}

const LEVEL_RANK: Record<MmLevel, number> = { zone: 0, micromarket: 1, locality: 2, sub_locality: 3 };

export class Hierarchy {
  readonly nodes: ReadonlyMap<string, MmNode>;
  private readonly byName = new Map<string, MmNode[]>();
  private readonly children = new Map<string, string[]>();

  constructor(nodes: Iterable<MmNode>) {
    const map = new Map<string, MmNode>();
    for (const n of nodes) map.set(n.key, n);
    this.nodes = map;
    for (const n of map.values()) {
      for (const k of n.nameKeys) {
        const list = this.byName.get(k) ?? [];
        list.push(n);
        this.byName.set(k, list);
      }
      if (n.parentKey) {
        const list = this.children.get(n.parentKey) ?? [];
        list.push(n.key);
        this.children.set(n.parentKey, list);
      }
    }
  }

  static fromSource(source: readonly MmSourceNode[]): Hierarchy {
    return new Hierarchy(
      source.map((s) => ({
        key: s.id,
        level: s.level,
        name: s.name,
        nameKeys: [...new Set([s.name, ...s.aliases].map(matchKey).filter((k) => k.length > 0))],
        parentKey: s.parentId,
        adjacentKeys: [...s.adjacentIds],
        inLaunchArea: s.inLaunchArea,
      })),
    );
  }

  get size(): number {
    return this.nodes.size;
  }

  node(key: string): MmNode | undefined {
    return this.nodes.get(key);
  }

  /** Ancestors including self, most specific first (up to the root). Cycles are cut. */
  ancestry(key: string): MmNode[] {
    const out: MmNode[] = [];
    const seen = new Set<string>();
    let cur = this.nodes.get(key);
    while (cur && !seen.has(cur.key)) {
      seen.add(cur.key);
      out.push(cur);
      cur = cur.parentKey ? this.nodes.get(cur.parentKey) : undefined;
    }
    return out;
  }

  /** All descendants (not self), bounded by the tree size. */
  descendants(key: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>([key]);
    const stack = [...(this.children.get(key) ?? [])];
    while (stack.length) {
      const k = stack.pop() as string;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(k);
      stack.push(...(this.children.get(k) ?? []));
    }
    return out;
  }

  /**
   * Resolves a place string. Prefers the given levels (in order) and, among equals, a node under `under` (e.g. the
   * locality "Marol" under the micromarket "Andheri East"). Zones are ignored.
   */
  resolve(
    name: string | null | undefined,
    levels: readonly MmLevel[],
    under?: string | null,
  ): MmNode | undefined {
    if (!name) return undefined;
    const candidates = (this.byName.get(matchKey(name)) ?? []).filter((n) => n.level !== 'zone');
    if (!candidates.length) return undefined;
    const inAncestry = (n: MmNode) => (under ? this.ancestry(n.key).some((a) => a.key === under) : false);
    const ordered = [...candidates].sort((a, b) => {
      const la = levels.indexOf(a.level);
      const lb = levels.indexOf(b.level);
      const ra = la < 0 ? 99 : la;
      const rb = lb < 0 ? 99 : lb;
      if (ra !== rb) return ra - rb;
      const ua = inAncestry(a) ? 0 : 1;
      const ub = inAncestry(b) ? 0 : 1;
      if (ua !== ub) return ua - ub;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
    return ordered[0];
  }

  /** The micromarket-level node of a node (itself or an ancestor). */
  micromarketOf(key: string): MmNode | undefined {
    return this.ancestry(key).find((n) => n.level === 'micromarket');
  }

  /**
   * offer.mm_path (LLD §4.8): the offer's most specific node + ancestors up to micromarket level. The locality string
   * may name a locality or sub-locality; the micromarket string disambiguates it and is the fallback.
   */
  offerPath(micromarket: string | null, locality: string | null): string[] {
    const mm = this.resolve(micromarket, ['micromarket', 'locality', 'sub_locality']);
    const loc = this.resolve(locality, ['sub_locality', 'locality', 'micromarket'], mm?.key ?? null);
    const most = loc ?? mm;
    if (!most) return [];
    const out: string[] = [];
    for (const n of this.ancestry(most.key)) {
      if (n.level === 'zone') break;
      out.push(n.key);
      if (n.level === 'micromarket') break;
    }
    return out;
  }

  /** Nodes a demand lists (micromarkets and localities), resolved; zones and unknown strings dropped. */
  demandListed(micromarkets: readonly string[], localities: readonly string[]): MmNode[] {
    const out = new Map<string, MmNode>();
    for (const m of micromarkets) {
      const n = this.resolve(m, ['micromarket', 'locality', 'sub_locality']);
      if (n) out.set(n.key, n);
    }
    for (const l of localities) {
      const n = this.resolve(l, ['locality', 'sub_locality', 'micromarket']);
      if (n) out.set(n.key, n);
    }
    return [...out.values()];
  }

  /**
   * demand.mm_expanded (LLD §4.8): listed nodes + all their descendants + the parent micromarket of each listed
   * locality / sub-locality (so an offer known only at micromarket level still overlaps, scored coarserLevel).
   */
  demandExpanded(micromarkets: readonly string[], localities: readonly string[]): string[] {
    const out = new Set<string>();
    for (const n of this.demandListed(micromarkets, localities)) {
      out.add(n.key);
      for (const d of this.descendants(n.key)) out.add(d);
      if (LEVEL_RANK[n.level] > LEVEL_RANK.micromarket) {
        const mm = this.micromarketOf(n.key);
        if (mm) out.add(mm.key);
      }
    }
    return [...out].sort();
  }

  /** True when two micromarket nodes are the same or listed as adjacent (either direction, R-13). */
  sameOrAdjacent(a: string, b: string): boolean {
    if (a === b) return true;
    return (
      (this.nodes.get(a)?.adjacentKeys.includes(b) ?? false) ||
      (this.nodes.get(b)?.adjacentKeys.includes(a) ?? false)
    );
  }
}

export type Proximity = 'sameLocality' | 'sameMicromarket' | 'coarserLevel' | 'none';

/**
 * Micromarket proximity of an offer to a demand (LLD §4.2 micromarket factor):
 * - sameLocality: a locality / sub-locality the demand lists is on the offer's path (the offer is in it or under it);
 * - sameMicromarket: a micromarket the demand lists is on the offer's path;
 * - coarserLevel: overlap only through a coarser node (e.g. offer known only at micromarket level, demand lists a
 *   locality under it);
 * - none: no overlap (filter 8 fails).
 */
export function proximity(
  h: Hierarchy,
  offerPath: readonly string[],
  demand: { micromarkets: readonly string[]; localities: readonly string[]; mmExpanded: readonly string[] },
): Proximity {
  const path = new Set(offerPath);
  const listed = h.demandListed(demand.micromarkets, demand.localities);
  if (listed.some((n) => (n.level === 'locality' || n.level === 'sub_locality') && path.has(n.key)))
    return 'sameLocality';
  if (listed.some((n) => n.level === 'micromarket' && path.has(n.key))) return 'sameMicromarket';
  if (demand.mmExpanded.some((k) => path.has(k))) return 'coarserLevel';
  return 'none';
}
