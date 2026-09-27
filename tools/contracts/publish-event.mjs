// Publishes an event fixture into the consumers' pgmq queues on a local database (F-05), standing in for the
// producer's outbox relay so a consumer can be built and tested alone.
//
// Usage: pnpm mock:event <eventType | path/to/event.json> [--to <consumer>] [--set data.path=json] [--keep-id] [--dry-run]
//   --to       only this consumer's queue (default: every consumer in the AsyncAPI x-consumers)
//   --set      override a field, value parsed as JSON when possible (repeatable), e.g. --set data.rowCount=3
//   --keep-id  keep the fixture's eventId (to exercise consumer dedupe); by default a fresh eventId is used
// Env: DATABASE_URL (local stack connection with rights on pgmq, e.g. the Supabase CLI postgres URL).
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { events, queueOf, root } from './events.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const values = (name) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));
const target = argv.find((a, i) => !a.startsWith('--') && !['--to', '--set'].includes(argv[i - 1] ?? ''));
if (!target) {
  process.stderr.write('usage: pnpm mock:event <eventType | file.json> [--to consumer] [--set a.b=v] [--keep-id] [--dry-run]\n');
  process.exit(2);
}

const file = existsSync(target) ? target : new URL(`contracts/fixtures/events/${target}.json`, root);
if (!existsSync(file)) {
  process.stderr.write(`no fixture for "${target}" (run pnpm contracts:gen)\n`);
  process.exit(2);
}
const event = JSON.parse(readFileSync(file, 'utf8'));
const spec = events().find((e) => e.type === event.eventType);
if (!spec) {
  process.stderr.write(`unknown event type ${event.eventType}\n`);
  process.exit(2);
}

for (const kv of values('--set')) {
  const eq = kv.indexOf('=');
  const path = kv.slice(0, eq).split('.');
  const raw = kv.slice(eq + 1);
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    value = raw;
  }
  const last = path.pop();
  const parent = path.reduce((o, k) => (o[k] ??= {}), event);
  parent[last] = value;
}
if (!flag('--keep-id')) event.eventId = randomUUID();
event.occurredAt = new Date().toISOString();
event.correlationId = `mock-${event.eventId}`;

const only = values('--to');
const consumers = only.length ? spec.consumers.filter((c) => only.includes(c)) : spec.consumers;
if (!consumers.length) {
  process.stderr.write(`${event.eventType} has no consumer ${only.join(', ')} (consumers: ${spec.consumers.join(', ')})\n`);
  process.exit(2);
}

if (flag('--dry-run')) {
  process.stdout.write(`${JSON.stringify({ queues: consumers.map(queueOf), event }, null, 2)}\n`);
  process.exit(0);
}
if (!process.env.DATABASE_URL) {
  process.stderr.write('DATABASE_URL is not set (use the local stack URL, see infra/supabase)\n');
  process.exit(2);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  for (const c of consumers) {
    const { rows } = await client.query('select pgmq.send($1, $2::jsonb) as msg_id', [queueOf(c), JSON.stringify(event)]);
    process.stdout.write(`${event.eventType} → ${queueOf(c)} (msg ${rows[0].msg_id}, event ${event.eventId})\n`);
  }
} finally {
  await client.end();
}
