// INT-10: POST /v1/parse — rules first, redacted model only for what the rules leave unknown, contacts returned to the
// caller, nothing stored; the model is an intercepting fake that records what it received (no PII may reach it).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ModelUnavailableError } from '../src/application/ports.js';
import type { ModelClassifier } from '../src/application/ports.js';
import { createHarness, newTenant } from './support/harness.js';
import type { Harness } from './support/harness.js';

const seen: string[] = [];
let available = true;
const model: ModelClassifier = {
  classify(items) {
    seen.push(...items.map((i) => i.text));
    if (!available) return Promise.reject(new ModelUnavailableError('down'));
    return Promise.resolve(
      items.map((i) => ({
        id: i.id,
        recordScope: 'Property',
        dealTypes: ['Sale'],
        side: 'Demand',
        confidence: 0.9,
      })),
    );
  },
};

let h: Harness;
beforeAll(async () => {
  h = await createHarness({
    model,
    localities: {
      resolver: () =>
        Promise.resolve((n: string) => (n.toLowerCase() === 'andheri west' ? 'Andheri West' : undefined)),
    },
  });
});
afterAll(() => h.close());

describe('POST /v1/parse', () => {
  it('classifies with rules only when they suffice and returns the caller its own contacts', async () => {
    seen.length = 0;
    const hd = await h.staff(newTenant(), 'Demand agent');
    const r = await h.call('POST', '/v1/parse', hd, {
      text: 'Wanted 2BHK flat on rent in Andheri West, budget 60k pm, semi furnished, immediate. Call Mr Test Person 90000 11111',
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.body).toMatchObject({
      classification: {
        recordScope: 'Property',
        side: 'Demand',
        dealTypes: ['Lease'],
        segment: 'Residential',
        propertyTypes: ['Apartment'],
      },
      fields: {
        bhkMin: 2,
        rentMonthlyInrMin: 60_000,
        furnishing: 'Semi Furnished',
        micromarketHint: 'Andheri West',
        moveInText: 'immediate',
      },
      contacts: { phones: ['+919000011111'] },
      usedModel: false,
      needsReview: false,
      vocabularyVersion: 'v0.6',
    });
    expect(seen).toEqual([]);
  });

  it('asks the model (redacted text only) when rules leave the classification unknown', async () => {
    seen.length = 0;
    const r = await h.call('POST', '/v1/parse', await h.staff(newTenant(), 'Supply agent'), {
      text: 'Call Rakesh Kulkarni 90000 22222 or tp@example.com, details later',
    });
    expect(r.body).toMatchObject({
      usedModel: true,
      classification: { recordScope: 'Property', side: 'Demand' },
      confidence: 0.9,
    });
    expect(r.body['contacts']).toMatchObject({
      phones: ['+919000022222'],
      emails: ['tp@example.com'],
      nameCandidate: 'Rakesh Kulkarni',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toMatch(/90000|22222|tp@example|Rakesh|Kulkarni/);
  });

  it('falls back to rules only when the model is unavailable', async () => {
    available = false;
    try {
      const r = await h.call('POST', '/v1/parse', await h.staff(newTenant(), 'Manager'), {
        text: 'something vague about Thane',
      });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ usedModel: false, modelUnavailable: true, needsReview: true });
    } finally {
      available = true;
    }
  });

  it('validates the body (2,000 chars max) and the roles', async () => {
    const hd = await h.staff(newTenant(), 'Admin');
    expect((await h.call('POST', '/v1/parse', hd, { text: 'x'.repeat(2001) })).status).toBe(400);
    expect(
      (
        await h.call('POST', '/v1/parse', await h.staff(newTenant(), 'Data operator'), {
          text: 'hello there',
        })
      ).status,
    ).toBe(403);
  });
});
