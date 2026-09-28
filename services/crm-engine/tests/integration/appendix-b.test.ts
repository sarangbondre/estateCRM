// ENG-07 precision check through the whole service (events → projection → pipeline → matches): PRD Appendix B
// AS-D1 inventory check for DEM-000127 (3 matches incl. a Marol bundle) on a noisy synthetic inventory.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harness } from '../helpers.js';
import type { Harness } from '../helpers.js';
import {
  deliver,
  envelopeFor,
  matchesOf,
  officeDemandFacts,
  officeFacts,
  outbox,
  settle,
} from '../pipeline-helpers.js';
import { SOURCE } from '../unit/fixtures.js';

let h: Harness;
beforeAll(async () => {
  h = await harness();
  await h.tx((s) => s.hierarchy.replace(h.tenant, SOURCE, 1));
});
afterAll(() => h.close());

async function offer(over: Record<string, unknown>) {
  const id = randomUUID();
  await deliver(h, envelopeFor(h, 'offer.created.v1', id, 1, officeFacts(id, over)));
  return id;
}

describe('AS-D1 end to end', () => {
  it('DEM-000127: exactly INV-00452, the Chakala office and one Marol bundle (precision = recall = 1)', async () => {
    const inv452 = await offer({
      code: 'INV-00452',
      areaSqftMin: 5000,
      areaSqftMax: 5000,
      rentMonthlyInrMin: 850_000,
      furnishing: 'Furnished',
    });
    const chakala = await offer({
      code: 'INV-00460',
      areaSqftMin: 6500,
      areaSqftMax: 6500,
      rentMonthlyInrMin: 950_000,
      locality: 'Chakala',
    });
    const floor1 = await offer({
      code: 'INV-00471',
      areaSqftMin: 3200,
      areaSqftMax: 3200,
      rentMonthlyInrMin: 420_000,
      buildingKey: 'bk-marol-tower',
    });
    const floor2 = await offer({
      code: 'INV-00472',
      areaSqftMin: 3000,
      areaSqftMax: 3000,
      rentMonthlyInrMin: 400_000,
      buildingKey: 'bk-marol-tower',
    });
    const noise = [
      await offer({ code: 'INV-00480', micromarket: 'Powai', locality: 'Hiranandani Gardens' }),
      await offer({ code: 'INV-00481', propertyTypes: ['Shop'] }),
      await offer({
        code: 'INV-00482',
        dealType: 'Sale',
        salePriceInrMin: 110_000_000,
        rentMonthlyInrMin: undefined,
      }),
      await offer({
        code: 'INV-00483',
        areaSqftMin: 900,
        areaSqftMax: 900,
        rentMonthlyInrMin: 150_000,
        locality: 'Saki Naka',
      }),
      await offer({
        code: 'INV-00484',
        segment: 'Residential',
        propertyTypes: ['Apartment'],
        bhkMin: 2,
        bhkMax: 2,
      }),
      await offer({ code: 'INV-00485', segment: 'Industrial', propertyTypes: ['Gala'], locality: 'MIDC' }),
      await offer({ code: 'INV-00487', possessionStatus: 'Available From', possessionDate: '2027-03' }),
      await offer({ code: 'INV-00488', outsideLaunchArea: true }),
    ];
    const d = randomUUID();
    await deliver(
      h,
      envelopeFor(
        h,
        'demand.created.v1',
        d,
        1,
        officeDemandFacts(d, { code: 'DEM-000127', moveInBy: '2026-11-30' }),
      ),
    );
    await settle(h);
    await deliver(h, envelopeFor(h, 'demand.qualified.v1', d, 2, { demandId: d }, 'journeys'));
    await settle(h);

    const open = (await matchesOf(h, d)).filter((m) => m.status === 'Suggested');
    const got = new Set(open.map((m) => [...m.offer_ids].sort().join(',')));
    const expected = new Set([inv452, chakala, [floor1, floor2].sort().join(',')]);
    const correct = [...got].filter((k) => expected.has(k)).length;
    expect({ precision: correct / got.size, recall: correct / expected.size }).toEqual({
      precision: 1,
      recall: 1,
    });
    expect(open.filter((m) => m.is_bundle)).toHaveLength(1);
    expect(open.every((m) => !noise.some((n) => m.offer_ids.includes(n)))).toBe(true);
    const completed = (await outbox(h, 'demand.matching_completed.v1')).find((e) => e.aggregateId === d);
    expect(completed?.data).toMatchObject({ demandId: d, matchCount: 2, bundleCount: 1 });
  });
});
