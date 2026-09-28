// Keyed hashing and encryption under WEB_KEK (data-hosting §3): subkeys by HKDF, HMAC-SHA-256 for e-mail / credential
// / IP lookups, AES-256-GCM for signing keys at rest.
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';

export type KeyPurpose = 'email-hash' | 'credential-hash' | 'ip-hash' | 'signing-key-enc';

export class Keyring {
  private readonly keys = new Map<KeyPurpose, Buffer>();
  constructor(private readonly kek: Buffer) {
    if (kek.length !== 32) throw new Error('KEK must be 32 bytes');
  }

  private key(purpose: KeyPurpose): Buffer {
    let k = this.keys.get(purpose);
    if (!k) {
      k = Buffer.from(hkdfSync('sha256', this.kek, Buffer.alloc(0), `11e-web:${purpose}`, 32));
      this.keys.set(purpose, k);
    }
    return k;
  }

  hmac(purpose: Exclude<KeyPurpose, 'signing-key-enc'>, value: string): Buffer {
    return createHmac('sha256', this.key(purpose)).update(value, 'utf8').digest();
  }

  /** iv(12) ‖ tag(16) ‖ ciphertext */
  encrypt(plain: Buffer): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key('signing-key-enc'), iv);
    const body = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]);
  }

  decrypt(blob: Buffer): Buffer {
    const d = createDecipheriv('aes-256-gcm', this.key('signing-key-enc'), blob.subarray(0, 12));
    d.setAuthTag(blob.subarray(12, 28));
    return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
  }
}

export const sha256 = (data: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(data).digest());
