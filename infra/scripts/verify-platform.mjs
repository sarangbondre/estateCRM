// Verifies the platform bootstrap (F-06 locally, F-07 on the pilot): extensions, queues, schema isolation and
// queue-wrapper permissions, as the rules in data-hosting §2–3 require. Exit code 1 on any failure.
// Local:  node infra/scripts/verify-platform.mjs
// Pilot:  ADMIN_DATABASE_URL=... VERIFY_ROLE_URL_<SCHEMA>=... node infra/scripts/verify-platform.mjs
import pg from 'pg';
import { events, queueOf } from '../../tools/contracts/events.mjs';
import { SERVICES, adminUrl, localUrl, schemaOf } from './db-roles.mjs';

const all = events();
const sendsTo = (svc) =>
  [...new Set(all.filter((e) => e.producer === svc || e.producer === '*').flatMap((e) => e.consumers))].map(
    queueOf,
  );

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, why: e.message });
  }
};
const expectDenied = async (client, sql, params = []) => {
  await client.query('savepoint probe');
  try {
    await client.query(sql, params);
  } catch (e) {
    await client.query('rollback to savepoint probe');
    if (e.code === '42501' || /permission denied|not a consumer/.test(e.message)) return;
    throw new Error(`expected permission denied, got: ${e.message}`, { cause: e });
  }
  throw new Error(`expected permission denied, but it succeeded: ${sql}`);
};
const connect = async (url) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
};
const roleUrl = (svc) =>
  process.env[`VERIFY_ROLE_URL_${schemaOf(svc).toUpperCase()}`] ?? localUrl(`${schemaOf(svc)}_svc`);

const admin = await connect(adminUrl());
try {
  await check('extensions pgmq, pg_cron, pg_net installed', async () => {
    const { rows } = await admin.query(
      "select extname from pg_extension where extname in ('pgmq','pg_cron','pg_net') order by 1",
    );
    const got = rows.map((r) => r.extname).join(',');
    if (got !== 'pg_cron,pg_net,pgmq') throw new Error(`found: ${got}`);
  });
  await check('schemas owned by <svc>_owner', async () => {
    const { rows } = await admin.query(
      'select nspname, pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = any($1)',
      [SERVICES.map(schemaOf)],
    );
    const wrong = SERVICES.map(schemaOf).filter(
      (s) => rows.find((r) => r.nspname === s)?.owner !== `${s}_owner`,
    );
    if (wrong.length) throw new Error(`wrong/missing: ${wrong.join(', ')}`);
  });
  await check('queues exist with DLQs', async () => {
    const { rows } = await admin.query('select queue_name from pgmq.list_queues()');
    const names = new Set(rows.map((r) => r.queue_name));
    const missing = SERVICES.flatMap((s) => [`q_${schemaOf(s)}`, `q_${schemaOf(s)}_dlq`]).filter(
      (q) => !names.has(q),
    );
    if (missing.length) throw new Error(`missing: ${missing.join(', ')}`);
  });
  await check('anon/authenticated have no usage on service schemas', async () => {
    const { rows } = await admin.query(
      `select s as schema from unnest($1::text[]) s
       where has_schema_privilege('anon', s, 'usage') or has_schema_privilege('authenticated', s, 'usage')`,
      [SERVICES.map(schemaOf)],
    );
    if (rows.length) throw new Error(`exposed: ${rows.map((r) => r.schema).join(', ')}`);
  });
  await check('PUBLIC cannot create in schema public', async () => {
    const { rows } = await admin.query("select has_schema_privilege('anon', 'public', 'create') as c");
    if (rows[0].c) throw new Error('anon can create in public');
  });
} finally {
  await admin.end();
}

// Per-service isolation, run as the runtime role inside a rolled-back transaction.
const probeMsg = JSON.stringify({ eventId: 'verify-platform', eventType: 'verify.probe.v1', data: {} });
for (const svc of SERVICES) {
  const s = schemaOf(svc);
  const other = schemaOf(SERVICES.find((x) => x !== svc));
  let c;
  try {
    c = await connect(roleUrl(svc));
  } catch (e) {
    results.push({ name: `${s}_svc can connect`, ok: false, why: e.message });
    continue;
  }
  try {
    await c.query('begin');
    await check(`${s}_svc: no usage on ${other}`, () =>
      expectDenied(c, `select ${other}.queue_send('x', '{}'::jsonb)`),
    );
    await check(`${s}_svc: no direct pgmq access`, () =>
      expectDenied(c, "select * from pgmq.send($1, '{}'::jsonb)", [`q_${s}`]),
    );
    await check(`${s}_svc: no DDL in own schema`, () =>
      expectDenied(c, `create table ${s}.probe_t (id int)`),
    );
    await check(`${s}_svc: reads own queue`, async () => {
      await c.query(`select * from ${s}.queue_read(0, 1)`);
    });
    await check(`${s}_svc: sends to its consumers' queues (${sendsTo(svc).join(', ')})`, async () => {
      for (const q of sendsTo(svc)) await c.query(`select ${s}.queue_send($1, $2::jsonb)`, [q, probeMsg]);
    });
    await check(`${s}_svc: sending to an unrelated queue is rejected`, () =>
      expectDenied(c, `select ${s}.queue_send('q_does_not_exist', $1::jsonb)`, [probeMsg]),
    );
  } finally {
    await c.query('rollback').catch(() => {});
    await c.end();
  }
}

// Migrator: DDL as <svc>_owner in its own schema only; new tables are granted to the runtime role by default privileges.
for (const svc of SERVICES) {
  const s = schemaOf(svc);
  const other = schemaOf(SERVICES.find((x) => x !== svc));
  const url = process.env[`VERIFY_MIGRATOR_URL_${s.toUpperCase()}`] ?? localUrl(`${s}_migrator`);
  let c;
  try {
    c = await connect(url);
  } catch (e) {
    results.push({ name: `${s}_migrator can connect`, ok: false, why: e.message });
    continue;
  }
  try {
    await c.query('begin');
    await check(`${s}_migrator: creates tables owned by ${s}_owner, DML granted to ${s}_svc`, async () => {
      await c.query(`create table ${s}.verify_probe (id int primary key)`);
      const { rows } = await c.query(
        `select pg_get_userbyid(relowner) as owner,
                has_table_privilege('${s}_svc', '${s}.verify_probe', 'select,insert,update,delete') as dml
         from pg_class where oid = '${s}.verify_probe'::regclass`,
      );
      if (rows[0].owner !== `${s}_owner` || !rows[0].dml) throw new Error(JSON.stringify(rows[0]));
    });
    await check(`${s}_migrator: no DDL in ${other}`, () =>
      expectDenied(c, `create table ${other}.verify_probe (id int)`),
    );
  } finally {
    await c.query('rollback').catch(() => {});
    await c.end();
  }
}

for (const r of results)
  process.stdout.write(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ${r.why}`}\n`);
const failed = results.filter((r) => !r.ok).length;
process.stdout.write(`${results.length - failed}/${results.length} platform checks passed\n`);
process.exit(failed ? 1 : 0);
