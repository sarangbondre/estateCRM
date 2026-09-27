// Dead-letter queue operations for the runbook (docs/runbooks/dlq-replay.md, F-16). Admin connection only.
//   node infra/scripts/dlq.mjs list                         depth of every *_dlq with the oldest message age
//   node infra/scripts/dlq.mjs show <queue> [--limit 20]    reason, attempts, event type/id of dead-lettered messages
//   node infra/scripts/dlq.mjs replay <queue> [--limit 100] [--yes]   move them back to <queue> (dry run without --yes)
// <queue> is the source queue (e.g. q_records), not the _dlq. Output never prints message bodies (they may hold PII).
// Env: ADMIN_DATABASE_URL (default: the local stack).
import pg from 'pg';
import { adminUrl } from './db-roles.mjs';

const [cmd, queue] = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : dflt;
};
const out = (s) => process.stdout.write(`${s}\n`);
const QUEUE = /^q_[a-z0-9_]+$/;

const client = new pg.Client({ connectionString: adminUrl() });
await client.connect();
try {
  if (cmd === 'list') {
    const { rows } = await client.query(
      "select queue_name, queue_length, oldest_msg_age_sec from pgmq.metrics_all() where queue_name like '%\\_dlq' order by queue_length desc, queue_name",
    );
    for (const r of rows)
      out(`${r.queue_name.padEnd(28)} depth=${r.queue_length}  oldest=${r.oldest_msg_age_sec ?? '-'}s`);
  } else if ((cmd === 'show' || cmd === 'replay') && queue && QUEUE.test(queue) && !queue.endsWith('_dlq')) {
    const dlq = `${queue}_dlq`;
    const limit = arg('--limit', cmd === 'show' ? 20 : 100);
    const { rows } = await client.query(
      `select msg_id, enqueued_at, message->'deadLetter' as dl, message->'message'->>'eventType' as event_type,
              message->'message'->>'eventId' as event_id
       from pgmq.${`q_${dlq}`} order by msg_id limit $1`,
      [limit],
    );
    for (const r of rows) {
      out(
        `#${r.msg_id} ${r.enqueued_at.toISOString()} reason=${r.dl?.reason ?? '?'} attempts=${r.dl?.attempts ?? '?'} ${r.event_type ?? '(work item)'} ${r.event_id ?? ''}`,
      );
    }
    if (cmd === 'replay') {
      if (!process.argv.includes('--yes')) {
        out(
          `dry run: ${rows.length} message(s) would move ${dlq} → ${queue}. Fix the cause first, then re-run with --yes.`,
        );
      } else {
        await client.query('begin');
        const moved = await client.query(
          `select count(*)::int as n from (
             select pgmq.send($1, coalesce(d.message->'message', d.message)), pgmq.delete($2, d.msg_id)
             from (select msg_id, message from pgmq.${`q_${dlq}`} order by msg_id limit $3 for update skip locked) d
           ) x`,
          [queue, dlq, limit],
        );
        await client.query('commit');
        out(`replayed ${moved.rows[0].n} message(s) ${dlq} → ${queue}`);
      }
    }
  } else {
    out(
      'usage: dlq.mjs list | show <queue> [--limit n] | replay <queue> [--limit n] [--yes]   (queue = q_<service>[_work])',
    );
    process.exitCode = 2;
  }
} finally {
  await client.end();
}
