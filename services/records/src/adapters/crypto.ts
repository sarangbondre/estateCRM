// Keyed hashes (HMAC-SHA256), UUIDv7 ids and the clock: the technical ports of the application layer.
import { createHmac, randomBytes } from 'node:crypto';
import type { Clock, IdGenerator, KeyedHash } from '../application/ports.js';

/**
 * Per-tenant HMAC keys derived from one secret (secrets manager). Lookup hashes (phone, email, building key) use the
 * tenant key; scan terms use the salt shared with listings (R-20), versioned.
 */
export class HmacKeyedHash implements KeyedHash {
  readonly #secret: string;
  readonly #scanSalt: string;
  readonly scanSaltVersion: number;
  readonly #tenantKeys = new Map<string, Buffer>();

  constructor(options: { contactHashSecret: string; scanSalt: string; scanSaltVersion: number }) {
    this.#secret = options.contactHashSecret;
    this.#scanSalt = options.scanSalt;
    this.scanSaltVersion = options.scanSaltVersion;
  }

  #key(tenantId: string): Buffer {
    let k = this.#tenantKeys.get(tenantId);
    if (!k) {
      k = createHmac('sha256', this.#secret).update(`tenant:${tenantId}`).digest();
      this.#tenantKeys.set(tenantId, k);
    }
    return k;
  }

  #mac(key: Buffer | string, value: string): string {
    return createHmac('sha256', key).update(value).digest('hex');
  }

  phone(tenantId: string, e164: string): string {
    return this.#mac(this.#key(tenantId), `phone:${e164}`);
  }

  email(tenantId: string, email: string): string {
    return this.#mac(this.#key(tenantId), `email:${email.trim().toLowerCase()}`);
  }

  building(tenantId: string, buildingNorm: string, micromarketKey: string): string {
    return this.#mac(this.#key(tenantId), `building:${micromarketKey}:${buildingNorm}`).slice(0, 32);
  }

  scanTerm(token: string): string {
    return this.#mac(this.#scanSalt, token);
  }
}

/** RFC 9562 UUIDv7: 48-bit ms timestamp, version 7, variant 10, random rest; monotonic within a millisecond. */
export class UuidV7 implements IdGenerator {
  #lastMs = 0;
  #seq = 0;

  next(): string {
    let ms = Date.now();
    if (ms <= this.#lastMs) {
      ms = this.#lastMs;
      this.#seq = (this.#seq + 1) & 0xfff;
      if (this.#seq === 0) ms = ++this.#lastMs;
    } else {
      this.#seq = randomBytes(2).readUInt16BE() & 0x7ff;
    }
    this.#lastMs = ms;
    const b = randomBytes(16);
    b.writeUIntBE(ms, 0, 6);
    b[6] = 0x70 | ((this.#seq >> 8) & 0x0f);
    b[7] = this.#seq & 0xff;
    b[8] = 0x80 | ((b[8] ?? 0) & 0x3f);
    const h = b.toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
}

export const systemClock: Clock = { now: () => new Date() };
