// Verifies the platform bootstrap (F-06 locally, F-07 on the pilot): extensions, queues, schema isolation and
// queue-wrapper permissions, as the rules in data-hosting §2–3 require. Exit code 1 on any failure.
// Local:  node infra/scripts/verify-platform.mjs
// Pilot:  ADMIN_DATABASE_URL=... VERIFY_ROLE_URL_<SCHEMA>=... node infra/scripts/verify-platform.mjs
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { LOCAL_ADMIN_URL, SERVICES, adminUrl, localCronSecret, localUrl, schemaOf } from './db-roles.mjs';

const topology = JSON.parse(
  readFileSync(new URL('../../contracts/generated/event-topology.json', import.meta.url), 'utf8'),
);
const sendsTo = (svc) => topology.services[svc].sendsTo;
const ownQueues = (svc) => [topology.services[svc].eventQueue, ...topology.services[svc].workQueues];

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
    const missing = SERVICES.flatMap((s) => ownQueues(s).flatMap((q) => [q, `${q}_dlq`])).filter(
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
    await check(
      `${s}_svc: reads and acks its own queues (${ownQueues(svc).join(', ')}) and DLQs`,
      async () => {
        for (const q of ownQueues(svc)) {
          await c.query(`select * from ${s}.queue_read($1, 0, 1)`, [q]);
          await c.query(`select * from ${s}.queue_read($1, 0, 1)`, [`${q}_dlq`]);
          const { rows } = await c.query(`select ${s}.queue_send($1, $2::jsonb) as id`, [q, probeMsg]);
          await c.query(`select ${s}.queue_delete($1, $2)`, [q, rows[0].id]);
        }
      },
    );
    const foreign = ownQueues(SERVICES.find((x) => x !== svc))[0];
    await check(`${s}_svc: cannot read another service's queue (${foreign})`, () =>
      expectDenied(c, `select * from ${s}.queue_read($1, 0, 1)`, [foreign]),
    );
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

// Schedules and alarms (F-15, CR-008). Read-only checks everywhere; active checks (a real pg_cron → pg_net → HTTP call,
// an alarm fire/resolve cycle) only on the local stack, because they change endpoint config and queue contents.
const sched = await connect(adminUrl());
try {
  await check('pg_cron jobs scheduled and active (relay, drains, jobs, alarms)', async () => {
    const { rows } = await sched.query(
      "select count(*)::int as n, bool_and(active) as active from cron.job where jobname like 'estatecrm:%'",
    );
    const expected =
      2 + SERVICES.length + Object.values(topology.services).reduce((n, t) => n + 1 + t.workQueues.length, 0);
    if (rows[0].n < expected || !rows[0].active)
      throw new Error(`found ${rows[0].n} (expected ≥ ${expected}), active=${rows[0].active}`);
  });
  await check('every service has a cron secret in Vault', async () => {
    const { rows } = await sched.query("select name from vault.secrets where name like 'cron_secret_%'");
    const names = new Set(rows.map((r) => r.name));
    const missing = SERVICES.filter((s) => !names.has(`cron_secret_${schemaOf(s)}`));
    if (missing.length) throw new Error(`missing: ${missing.join(', ')}`);
  });
  await check('service roles cannot touch the platform schema', async () => {
    const { rows } = await sched.query(
      "select r from unnest($1::text[]) r where has_schema_privilege(r, 'platform', 'usage')",
      [SERVICES.map((s) => `${schemaOf(s)}_svc`)],
    );
    if (rows.length) throw new Error(rows.map((r) => r.r).join(', '));
  });

  if (adminUrl() === LOCAL_ADMIN_URL && !process.env['VERIFY_SKIP_ACTIVE']) {
    await check(
      'scheduler call reaches the service with its X-Cron-Secret (pg_cron path, local)',
      async () => {
        const received = [];
        const server = createServer((req, res) => {
          received.push({ url: req.url, secret: req.headers['x-cron-secret'] });
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"processed":0,"durationMs":0}');
        });
        await new Promise((r) => server.listen(0, '0.0.0.0', r));
        const port = server.address().port;
        const { rows: before } = await sched.query(
          "select base_url, enabled from platform.service_endpoints where service = 'records'",
        );
        try {
          await sched.query(
            "update platform.service_endpoints set base_url = $1, enabled = true where service = 'records'",
            [`http://host.docker.internal:${port}`],
          );
          await sched.query("select platform.invoke('records', '/internal/v1/relay')");
          for (let i = 0; i < 40 && !received.length; i++) await new Promise((r) => setTimeout(r, 250));
          if (!received.length)
            throw new Error('no request arrived (is host.docker.internal reachable from the DB container?)');
          if (received[0].url !== '/internal/v1/relay' || received[0].secret !== localCronSecret('records')) {
            throw new Error(`unexpected call ${JSON.stringify(received[0])}`);
          }
        } finally {
          await sched.query(
            "update platform.service_endpoints set base_url = $1, enabled = $2 where service = 'records'",
            [before[0].base_url, before[0].enabled],
          );
          server.close();
        }
      },
    );
    await check('DLQ depth raises an alarm and resolves when drained (local)', async () => {
      await sched.query("select pgmq.send('q_web_dlq', '{\"probe\":true}'::jsonb)");
      await sched.query('select platform.check_alarms()');
      const firing = await sched.query(
        "select service from platform.alarm_events where alarm = 'dlq-depth' and subject = 'q_web_dlq' and status = 'firing'",
      );
      await sched.query("select pgmq.purge_queue('q_web_dlq')");
      await sched.query('select platform.check_alarms()');
      const after = await sched.query(
        "select status from platform.alarm_events where alarm = 'dlq-depth' and subject = 'q_web_dlq' order by id desc limit 1",
      );
      await sched.query("delete from platform.alarm_events where subject = 'q_web_dlq'");
      if (firing.rows[0]?.service !== 'web') throw new Error('alarm did not fire for web');
      if (after.rows[0]?.status !== 'resolved') throw new Error('alarm did not resolve');
    });
  }
} finally {
  await sched.end();
}

for (const r of results)
  process.stdout.write(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ${r.why}`}\n`);
const failed = results.filter((r) => !r.ok).length;
process.stdout.write(`${results.length - failed}/${results.length} platform checks passed\n`);
process.exit(failed ? 1 : 0);
