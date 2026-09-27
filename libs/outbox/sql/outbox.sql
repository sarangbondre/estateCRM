-- Template for each service's first migration (conventions §6, R-4, capacity plan §5).
-- Copy into services/<svc>/migrations/0001_technical_tables.sql together with libs/db/sql/idempotency_keys.sql.
create table if not exists outbox (
  id uuid primary key,                 -- = envelope eventId
  tenant_id uuid not null,
  event_type text not null,
  aggregate_type text not null,
  aggregate_id uuid not null,
  aggregate_version integer not null,
  payload jsonb not null,              -- the full envelope as published
  occurred_at timestamptz not null,
  published_at timestamptz
);
-- relay: ... where published_at is null order by occurred_at, id limit 5000 for update skip locked (technical table, R-4)
create index if not exists outbox_unpublished on outbox (occurred_at, id) where published_at is null;
-- debugging / replay by aggregate
create index if not exists outbox_aggregate on outbox (tenant_id, aggregate_id, aggregate_version);
-- purge of published rows after 7 days
create index if not exists outbox_published_at on outbox (published_at) where published_at is not null;

create table if not exists processed_events (
  event_id uuid primary key,           -- consumer dedupe
  consumer text not null,
  processed_at timestamptz not null default now()
);
-- purge after 30 days
create index if not exists processed_events_processed_at on processed_events (processed_at);
