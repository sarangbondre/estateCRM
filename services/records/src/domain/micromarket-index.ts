// MicromarketTree: alias resolution of stated localities to hierarchy nodes (records LLD §2 reference/, §4.9).
import { norm } from './text.js';

export interface MicromarketNode {
  id: string;
  parent_id: string | null;
  level: string;
  name_norm: string;
  aliases_norm: readonly string[];
  city_norm: string;
  in_launch_area: boolean;
}

const DEPTH: Record<string, number> = { zone: 0, micromarket: 1, locality: 2, sub_locality: 3 };

export class MicromarketIndex {
  readonly #byName = new Map<string, MicromarketNode>();
  readonly #byId = new Map<string, MicromarketNode>();

  constructor(nodes: readonly MicromarketNode[]) {
    // The most specific level wins when a name is shared across levels (e.g. "Powai" micromarket vs locality).
    const sorted = [...nodes].sort((a, b) => (DEPTH[b.level] ?? 0) - (DEPTH[a.level] ?? 0));
    for (const n of sorted) {
      this.#byId.set(n.id, n);
      for (const key of [n.name_norm, ...n.aliases_norm]) if (!this.#byName.has(key)) this.#byName.set(key, n);
    }
  }

  get size(): number {
    return this.#byId.size;
  }

  byId(id: string): MicromarketNode | undefined {
    return this.#byId.get(id);
  }

  /** Resolves free text ("Andheri (E)", "chakala") to a node, or undefined. */
  resolve(locality: string | null | undefined): MicromarketNode | undefined {
    const n = norm(locality);
    if (!n) return undefined;
    const hit = this.#byName.get(n);
    if (hit) return hit;
    // "Andheri E" / "Andheri (East)" style variants.
    const expanded = n.replace(/\b(e)\b/g, 'east').replace(/\b(w)\b/g, 'west');
    return this.#byName.get(expanded);
  }

  /** The node and its ancestors (a demand for Andheri East also covers Chakala's parent chain). */
  ancestors(id: string): string[] {
    const out: string[] = [];
    let cur = this.#byId.get(id);
    let guard = 0;
    while (cur && guard++ < 6) {
      out.push(cur.id);
      cur = cur.parent_id ? this.#byId.get(cur.parent_id) : undefined;
    }
    return out;
  }
}
