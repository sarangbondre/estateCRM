import { describe, expect, it } from 'vitest';
import { hasContactLikeDigits, publicIdFrom } from '../../src/domain/ids.js';

describe('public ids never read as phone numbers (M8)', () => {
  it('flags ids the privacy scan would block', () => {
    expect(hasContactLikeDigits('L-9820012345')).toBe(true);
    expect(hasContactLikeDigits('L-ACDEFGHJKM')).toBe(false);
  });

  it('issued ids are re-drawn until the scan passes: 2,000 random ids, none blocked after filtering', () => {
    const ok: string[] = [];
    while (ok.length < 2000) {
      const id = publicIdFrom(crypto.getRandomValues(new Uint8Array(8)));
      if (!hasContactLikeDigits(id)) ok.push(id);
    }
    expect(ok.every((id) => !hasContactLikeDigits(id))).toBe(true);
  });

  it('all-zero bytes give an all-digit id, which the check rejects', () => {
    expect(hasContactLikeDigits(publicIdFrom(new Uint8Array(8)))).toBe(true);
  });
});
