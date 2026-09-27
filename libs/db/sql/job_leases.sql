-- Template for each service's first migration: single-flight scheduled jobs (libs/http registerPlatformEndpoints).
-- A run claims the row while leased_until < now(); the lease outlives the 60 s function limit so a killed run frees it.
create table if not exists job_leases (
  name text primary key,
  run_id uuid not null,
  leased_until timestamptz not null,
  last_started_at timestamptz not null,
  last_finished_at timestamptz
);
