// Generates one deterministic, schema-valid fixture per event into contracts/fixtures/events/<eventType>.json (F-05).
// Fixtures carry no real personal data: values come from a seeded faker over the AsyncAPI payload schema.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { generateSync } from 'json-schema-faker';
import { events, root } from './events.mjs';

export const FIXTURE_TENANT = '00000000-0000-4000-8000-000000000001';

const uuidFrom = (s) => {
  const h = createHash('sha256').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const seedFrom = (s) => createHash('sha256').update(s).digest().readUInt32BE(0);

const dir = new URL('contracts/fixtures/events/', root);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const all = events();
for (const e of all) {
  const generated = generateSync(e.schema, {
    seed: seedFrom(e.type),
    alwaysFakeOptionals: true,
    fixedProbabilities: true,
    useExamplesValue: true,
    maxDefaultItems: 2,
  });
  const fixture = {
    ...generated,
    eventId: uuidFrom(`event:${e.type}`),
    eventType: e.type,
    schemaVersion: Number(e.type.match(/\.v(\d+)$/)?.[1] ?? 1),
    occurredAt: '2026-01-01T00:00:00.000Z',
    correlationId: `fixture-${e.type}`,
    producer: e.producer,
    tenantId: FIXTURE_TENANT,
    aggregateType: e.type.split('.')[0],
    aggregateId: uuidFrom(`aggregate:${e.type}`),
    aggregateVersion: 1,
  };
  delete fixture.traceparent;
  writeFileSync(new URL(`${e.type}.json`, dir), `${JSON.stringify(fixture, null, 2)}\n`);
}
process.stdout.write(`event fixtures: ${all.length} (${readdirSync(dir).length} files)\n`);
