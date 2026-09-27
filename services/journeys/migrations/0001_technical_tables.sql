-- journeys: technical tables (conventions §6, R-3, R-4). Business tables start at 0002.
-- Template for each service's first migration (R-3, R-4; intake LLD technical tables).
-- Copy into services/<svc>/migrations/0001_technical_tables.sql (the runner sets search_path to the service schema).
create table if not exists idempotency_keys (
  tenant_id uuid not null,
  user_id uuid not null,
  route text not null,
  key text not null,
  request_hash text not null,
  status_code integer,
  response_body jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (tenant_id, user_id, route, key)
);
-- expire-idempotency-keys job (technical table, R-4: not tenant-first).
create index if not exists idempotency_keys_expires_at on idempotency_keys (expires_at);

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

-- Template for each service's first migration: single-flight scheduled jobs (libs/http registerPlatformEndpoints).
-- A run claims the row while leased_until < now(); the lease outlives the 60 s function limit so a killed run frees it.
create table if not exists job_leases (
  name text primary key,
  run_id uuid not null,
  leased_until timestamptz not null,
  last_started_at timestamptz not null,
  last_finished_at timestamptz
);
