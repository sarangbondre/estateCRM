/**
 * Seeded pseudo-random numbers (sfc32 seeded through splitmix32). Same seed → same sequence on
 * every platform: only 32-bit integer arithmetic, no Math.random.
 */

function splitmix32(state: number): () => number {
  let s = state >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/** 32-bit string hash (FNV-1a), used to derive independent streams from one seed. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export type Weighted<T> = readonly (readonly [T, number])[];

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number | string) {
    const init = splitmix32(typeof seed === 'number' ? seed : hash32(seed));
    this.a = init();
    this.b = init();
    this.c = init();
    this.d = init();
    for (let i = 0; i < 12; i += 1) this.nextUint32();
  }

  /** An independent stream derived from this seed and a label (does not advance this stream). */
  static derive(seed: number, label: string): Rng {
    return new Rng((Math.imul(seed >>> 0, 0x9e3779b1) ^ hash32(label)) >>> 0);
  }

  nextUint32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.nextUint32() / 4294967296;
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return p > 0 && this.next() < p;
  }

  /** Integer in [min, max] (inclusive). */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Float in [min, max). */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from an empty list');
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** Picks by weight (weights need not sum to 1). */
  weighted<T>(items: Weighted<T>): T {
    let total = 0;
    for (const [, w] of items) total += w;
    let r = this.next() * total;
    for (const [item, w] of items) {
      r -= w;
      if (r < 0) return item;
    }
    const last = items[items.length - 1];
    if (last === undefined) throw new Error('weighted pick from an empty list');
    return last[0];
  }

  /** k distinct items (order of first pick). */
  sample<T>(items: readonly T[], k: number): T[] {
    const out: T[] = [];
    const n = Math.min(k, items.length);
    while (out.length < n) {
      const item = this.pick(items);
      if (!out.includes(item)) out.push(item);
    }
    return out;
  }

  /** Lower-case hex string of the given length. */
  hex(length: number): string {
    let out = '';
    while (out.length < length) out += this.nextUint32().toString(16).padStart(8, '0');
    return out.slice(0, length);
  }
}

/**
 * Bijective 48-bit mix (4-round Feistel on two 24-bit halves). Maps a row index to a unique,
 * random-looking 12-hex id: distinct indexes never collide (up to 2^48).
 */
export function feistel48(index: number, key: number): number {
  let left = Math.floor(index / 0x1000000) & 0xffffff;
  let right = index & 0xffffff;
  for (let round = 0; round < 4; round += 1) {
    let f = Math.imul(right ^ key, 0x2c1b3c6d) ^ Math.imul(round + 1, 0x297a2d39);
    f = Math.imul(f ^ (f >>> 15), 0x85ebca6b);
    f = (f ^ (f >>> 13)) & 0xffffff;
    const next = left ^ f;
    left = right;
    right = next;
  }
  return left * 0x1000000 + right;
}

export function hex12(value: number): string {
  return value.toString(16).padStart(12, '0');
}
