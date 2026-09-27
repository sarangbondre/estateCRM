# @11e/outbox

Transactional outbox, relay, queue drains, DLQ replay and retention (F-09, ADR-0003, conventions §5, capacity plan §5).

## Flow

```
state change + writeEvent(trx)  ──►  outbox (same transaction)
relayOutbox (pg_cron every minute + poke)  ──►  one pgmq copy per consumer queue, rows marked published (one transaction)
drainEvents (pg_cron every minute + re-poke while non-empty)  ──►  processed_events dedupe + handler + ack (one transaction)
                               └─ read more than 5 times ──►  <queue>_dlq (alarm on depth > 0)
```

| Export                                                                                                                                 | Notes                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `writeEvent(trx, { eventType, tenantId, aggregateType, aggregateId, aggregateVersion, data, correlationId, producer })`, `writeEvents` | `data` is typed per event from `@11e/contracts/events`. The envelope (eventId, schemaVersion, occurredAt, …) is built for you. **Call inside the state-change transaction.**                                                                                                              |
| `relayOutbox({ db, schema }, { routes })`                                                                                              | `routes` = `event-topology.json` `routes` from `@11e/contracts`. Up to 5,000 rows per run, `FOR UPDATE SKIP LOCKED`, so parallel runs never double-publish. Rows with no route stay unpublished and are counted as `unroutable` (contract drift: alarm).                                  |
| `drainEvents(ctx, { queue, consumer, handlers })`                                                                                      | Handlers get `(event, { trx, attempt })`. Their DB writes, the `processed_events` insert and the message delete commit together, so effects apply **exactly once** under at-least-once delivery. A thrown error rolls everything back and retries after `5·2^(n-1)` s (±20%, max 10 min). |
| `drainWork(ctx, { queue, handler })`                                                                                                   | Private work queues (chunks, exports, photos). The handler dedupes on its own work key and manages its own transactions.                                                                                                                                                                  |
| `replayDeadLetters(ctx, queue, limit)`                                                                                                 | Runbook "DLQ replay".                                                                                                                                                                                                                                                                     |
| `purgeProcessedEvents` (30 days), `purgePublishedOutbox` (7 days)                                                                      | Bounded batches for the retention jobs.                                                                                                                                                                                                                                                   |

Options for both drains: `batchSize` (100), `visibilityTimeoutSec` (60), `maxAttempts` (5), `budgetMs` (50 s; unprocessed
messages are released at once), `retryDelaySec`, and `onError` for logs and metrics. The lib never logs, because errors
may contain PII.

## Ordering is the consumer's job

Delivery is at least once and may be out of order. Per conventions §5, a consumer ignores an event whose
`aggregateVersion` is ≤ the version it has already applied. It stores that version where its LLD says (for example
`inbound_versions` in records, `facts_version` in journeys). Projections re-read the owner's API on a gap.

## Tables

Copy [`sql/outbox.sql`](sql/outbox.sql) (outbox + processed_events, R-4 technical tables) into the service's first
migration. The pgmq wrapper functions (`<schema>.queue_*`) come from the platform bootstrap, which also enforces
which queues a service may write to and read from.

Integration tests run against real pgmq on the local stack (`pnpm db:start`).
