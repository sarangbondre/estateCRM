# ADR-0003: Transactional outbox + pgmq as the event bus

- Status: Accepted (Stage 3 approved 2026-09-24)
- Date: 2026-09-24

## Context
CLAUDE.md §3.4 requires a transactional outbox, idempotent consumers, a DLQ with alarms and additive schemas. Hosting is
Vercel + Supabase. Events must stay in India.

## Options
1. **Outbox table per service + relay into pgmq queues (one per consumer) in the same Supabase Postgres.**
2. A hosted serverless queue (e.g. QStash). Residency is unclear; it's another vendor.
3. Kafka. Too heavy for Phase 1.

## Decision
Option 1.
- The relay is a function invoked every minute by **Supabase pg_cron + pg_net** (it works on the free plan, unlike Vercel
  Hobby cron) and is also poked after commits. Queue drains are invoked the same way.
- It reads unpublished outbox rows (`FOR UPDATE SKIP LOCKED`) and enqueues one copy per subscribed consumer queue.
- Consumers drain in batches, dedupe on `event_id` (processed-events table), and retry with backoff.
- After 5 attempts a message moves to `<queue>_dlq`, and an alarm fires on DLQ depth > 0.
- Subscriptions are declared in `contracts/asyncapi/events.yaml`.

## Consequences
- Events are in India and the outbox write is atomic with state. Adding a consumer means adding a queue.
- Latency is at best seconds and at worst ~1 minute, which meets NFR-9 and NFR-10.
- All services depend on one Postgres cluster for events, which becomes a single point of failure. That's accepted for
  Phase 1 (Multi-AZ). The broker moves to SQS/SNS on the AWS move.
