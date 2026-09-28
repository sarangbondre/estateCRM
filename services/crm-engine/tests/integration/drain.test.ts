// End to end through the queues: events published into q_crm_engine (as the producers' relays would, like
// `pnpm mock:event`) → drain → projection → q_crm_engine_rescore → drain → match + outbox row → relay.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harness } from '../helpers.js';
import type { Harness } from '../helpers.js';
import { envelopeFor, matchesOf, officeDemandFacts, officeFacts, outbox } from '../pipeline-helpers.js';
import { SOURCE } from '../unit/fixtures.js';

// Local stack superuser (Supabase CLI defaults), standing in for the producers' relays.
const ADMIN_URL =
  process.env['LOCAL_ADMIN_DATABASE_URL'] ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

let h: Harness;
let admin: pg.Client;
beforeAll(async () => {
  h = await harness();
  await h.tx((s) => s.hierarchy.replace(h.tenant, SOURCE, 1));
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
});
afterAll(async () => {
  await admin.end();
  await h.close();
});

const publish = (message: unknown) =>
  admin.query('select pgmq.send($1, $2::jsonb)', ['q_crm_engine', JSON.stringify(message)]);

// The work queue is FIFO and shared by every test file (earlier files leave no-op messages behind), so drain until
// this test's subject is reached rather than a fixed number of rounds.
async function drainUntil(queue: string, done: () => Promise<boolean>, rounds = 200) {
  for (let i = 0; i < rounds; i++) {
    const r = await h.app.request(`/internal/v1/drain/${queue}`, { method: 'POST', headers: h.cron });
    expect(r.status).toBe(200);
    if (await done()) return;
  }
  throw new Error(`${queue} did not settle`);
}

describe('queues end to end', () => {
  it(
    'offer and demand events → drains → a suggested match in the outbox → relayed',
    { timeout: 300_000 },
    async () => {
      const offerId = randomUUID();
      const demandId = randomUUID();
      await publish(envelopeFor(h, 'offer.created.v1', offerId, 1, officeFacts(offerId)));
      await publish(envelopeFor(h, 'demand.created.v1', demandId, 1, officeDemandFacts(demandId)));
      await drainUntil(
        'q_crm_engine',
        async () =>
          !!(await h.tx((s) => s.mx.getDemand(h.tenant, demandId))) &&
          !!(await h.tx((s) => s.mx.getOffer(h.tenant, offerId))),
      );
      await drainUntil('q_crm_engine_rescore', async () => (await matchesOf(h, demandId)).length > 0);
      const [m] = await matchesOf(h, demandId);
      expect(m).toMatchObject({ status: 'Suggested', offer_ids: [offerId] });
      expect((await outbox(h, 'match.suggested.v1')).some((e) => e.aggregateId === m?.id)).toBe(true);

      const relay = await h.app.request('/internal/v1/relay', { method: 'POST', headers: h.cron });
      expect(relay.status).toBe(200);
      const body = (await relay.json()) as { claimed: number; published: number };
      expect(body.published).toBeGreaterThan(0);
    },
  );

  it('a duplicate delivery is applied once (processed_events dedupe)', async () => {
    const offerId = randomUUID();
    const e = envelopeFor(
      h,
      'offer.created.v1',
      offerId,
      1,
      officeFacts(offerId, { micromarket: 'Powai', locality: null }),
    );
    await publish(e);
    await publish(e);
    let duplicates = 0;
    for (let round = 0; round < 200; round++) {
      const r = await h.app.request('/internal/v1/drain/q_crm_engine', { method: 'POST', headers: h.cron });
      duplicates += ((await r.json()) as { duplicates: number }).duplicates;
      if (duplicates > 0 && (await h.tx((s) => s.mx.getOffer(h.tenant, offerId)))) break;
    }
    expect(duplicates).toBeGreaterThanOrEqual(1);
    expect(await h.tx((s) => s.mx.getOffer(h.tenant, offerId))).toMatchObject({ micromarket: 'Powai' });
  });
});
