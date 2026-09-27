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
