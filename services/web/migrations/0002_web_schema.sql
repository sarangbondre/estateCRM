-- web business tables (docs/04-lld/web.md §3). Schema `web`, runtime role `web_svc`. PII columns are marked "-- PII".

-- Staff roles (seeded, read-only). Global rows use the nil tenant. users.role / invitation.role are checked against
-- the same five codes; the permission lists mirror src/domain/roles.ts (a test keeps them in step).
create table if not exists role (
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000000',
  code text not null,
  description text not null,
  permissions text[] not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, code)
);

create table if not exists users (
  tenant_id uuid not null,
  id uuid not null,                       -- = Supabase auth.users.id
  email text not null,                    -- PII: lower-cased Google e-mail; Admin view only; never logged
  email_hash bytea not null,              -- HMAC-SHA-256(lower(email)): lookups without scanning plaintext
  display_name text not null,             -- PII (staff name)
  role text not null check (role in ('Admin', 'Manager', 'Demand agent', 'Supply agent', 'Data operator')),
  is_data_operator boolean not null default false,
  status text not null check (status in ('invited', 'active', 'deactivated')),
  invited_by uuid,
  invited_at timestamptz,
  activated_at timestamptz,
  deactivated_at timestamptz,
  last_seen_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
-- sign-in callback: look up by the Supabase user id before the tenant is known (documented exception to tenant-first)
create unique index if not exists users_id on users (id);
-- invite duplicate check among invited/active users (a revoked or expired invitation leaves a deactivated row)
create unique index if not exists users_email_hash on users (tenant_id, email_hash) where status <> 'deactivated';
-- GET /v1/users sorted by name, cursor
create index if not exists users_name on users (tenant_id, display_name, id);
-- role= / status= filters; last-admin check (role = 'Admin' and status = 'active')
create index if not exists users_role_status on users (tenant_id, role, status);
-- idle-session-sweep
create index if not exists users_idle on users (tenant_id, status, last_seen_at) where status = 'active';
-- re-invite: latest row for an e-mail regardless of status
create index if not exists users_email_hash_all on users (tenant_id, email_hash, created_at desc);

create table if not exists invitation (
  tenant_id uuid not null,
  id uuid not null,
  user_id uuid not null,
  email_hash bytea not null,
  role text not null check (role in ('Admin', 'Manager', 'Demand agent', 'Supply agent', 'Data operator')),
  is_data_operator boolean not null default false,
  status text not null check (status in ('pending', 'accepted', 'revoked', 'expired')),
  invited_by uuid not null,
  expires_at timestamptz not null,        -- 7 days
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
-- revoke; activation (pending invitation of a user)
create index if not exists invitation_user on invitation (tenant_id, user_id);
-- email-already-invited
create unique index if not exists invitation_pending_email on invitation (tenant_id, email_hash) where status = 'pending';
-- invitation-expire job
create index if not exists invitation_expiry on invitation (tenant_id, status, expires_at) where status = 'pending';
-- invitation-expire job across tenants (bounded batches, oldest first)
create index if not exists invitation_pending_expiry on invitation (expires_at) where status = 'pending';

-- Immutable audit log (US-35): append-only, kept 24 months, monthly range partitions on recorded_at.
create table if not exists audit_log (
  tenant_id uuid not null,
  id uuid not null,
  event_id uuid,                          -- source audit.recorded.v1 eventId (null for web's own entries)
  occurred_at timestamptz not null,
  recorded_at timestamptz not null,
  producer text not null,
  action text not null,
  actor_user_id uuid not null,
  subject_type text not null,
  subject_id uuid not null,
  via text not null check (via in ('ui', 'chat', 'system')),
  details jsonb not null default '{}',    -- flat string map, PII-free by producer contract, scrubbed on ingest
  correlation_id text,
  prev_hash bytea not null,
  entry_hash bytea not null,
  primary key (tenant_id, recorded_at, id)
) partition by range (recorded_at);
create table if not exists audit_log_default partition of audit_log default;
-- GET /v1/audit-log default order, cursor
create index if not exists audit_log_occurred on audit_log (tenant_id, occurred_at desc, id desc);
-- actorUserId=
create index if not exists audit_log_actor on audit_log (tenant_id, actor_user_id, occurred_at desc);
-- subjectType=&subjectId= (history of one record)
create index if not exists audit_log_subject on audit_log (tenant_id, subject_type, subject_id, occurred_at desc);
-- action= exact or prefix (export.*)
create index if not exists audit_log_action on audit_log (tenant_id, action text_pattern_ops, occurred_at desc);
-- producer=
create index if not exists audit_log_producer on audit_log (tenant_id, producer, occurred_at desc);
-- second-level dedupe of redelivered audit events
create unique index if not exists audit_log_event on audit_log (tenant_id, event_id, recorded_at) where event_id is not null;

create or replace function audit_log_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only' using errcode = 'insufficient_privilege';
end $$;
drop trigger if exists audit_log_no_change on audit_log;
create trigger audit_log_no_change before update or delete on audit_log
  for each row execute function audit_log_immutable();

-- Monthly partitions from the current month to `months_ahead` ahead (run by audit-chain-verify daily as web_svc).
create or replace function ensure_audit_partitions(months_ahead integer default 3) returns integer
language plpgsql security definer set search_path = web as $$
declare
  m date := date_trunc('month', now())::date;
  created integer := 0;
  part text;
begin
  for i in 0..months_ahead loop
    part := format('audit_log_%s', to_char(m, 'YYYYMM'));
    if to_regclass(format('web.%I', part)) is null then
      execute format(
        'create table web.%I partition of web.audit_log for values from (%L) to (%L)',
        part, m, (m + interval '1 month')::date);
      execute format('revoke update, delete on web.%I from web_svc', part);
      created := created + 1;
    end if;
    m := (m + interval '1 month')::date;
  end loop;
  return created;
end $$;
select ensure_audit_partitions(3);
revoke update, delete on audit_log from web_svc;
revoke update, delete on audit_log_default from web_svc;

create table if not exists notification (
  tenant_id uuid not null,
  id uuid not null,
  user_id uuid not null,
  kind text not null check (kind in ('upload_completed', 'upload_failed', 'export_ready', 'export_failed', 'role_changed', 'account_reactivated')),
  subject_type text not null check (subject_type in ('upload', 'export', 'user')),
  subject_id uuid not null,
  subject_code text,
  title text not null,                    -- no PII: codes and counts only
  link text not null,
  source_event_id uuid,                   -- null for web's own user notifications
  read_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
-- list + cursor
create index if not exists notification_user on notification (tenant_id, user_id, created_at desc, id desc);
-- unread count and unreadOnly
create index if not exists notification_unread on notification (tenant_id, user_id, created_at desc, id desc) where read_at is null;
-- dedupe of redelivered events
create unique index if not exists notification_source on notification (tenant_id, source_event_id) where source_event_id is not null;
-- 90-day prune
create index if not exists notification_created on notification (created_at);

-- Postgres token bucket (web LLD §4.4). subject_key = user id, or HMAC of the client IP for public_page.
create table if not exists rate_limit_bucket (
  tenant_id uuid not null,
  subject_key text not null,
  bucket text not null check (bucket in ('api', 'chat_msg', 'upload', 'public_page', 'invite', 'service_token')),
  tokens numeric not null,
  refilled_at timestamptz not null,
  primary key (tenant_id, subject_key, bucket)
);
-- prune rows idle > 1 h
create index if not exists rate_limit_bucket_refilled on rate_limit_bucket (refilled_at);

-- One call takes `cost` tokens if available. Returns allowed + the tokens left (or available when refused).
create or replace function take_token(
  p_tenant uuid, p_subject text, p_bucket text, p_rate numeric, p_burst numeric, p_cost numeric
) returns table (allowed boolean, tokens numeric) language plpgsql as $$
declare
  v_now timestamptz := clock_timestamp();
  v_left numeric;
begin
  insert into rate_limit_bucket as b (tenant_id, subject_key, bucket, tokens, refilled_at)
  values (p_tenant, p_subject, p_bucket, p_burst - p_cost, v_now)
  on conflict (tenant_id, subject_key, bucket) do update
    set tokens = least(p_burst, b.tokens + extract(epoch from (v_now - b.refilled_at)) * p_rate) - p_cost,
        refilled_at = v_now
    where least(p_burst, b.tokens + extract(epoch from (v_now - b.refilled_at)) * p_rate) >= p_cost
  returning b.tokens into v_left;
  if found then
    return query select true, v_left;
  else
    select least(p_burst, b.tokens + extract(epoch from (v_now - b.refilled_at)) * p_rate) into v_left
      from rate_limit_bucket b
     where b.tenant_id = p_tenant and b.subject_key = p_subject and b.bucket = p_bucket;
    return query select false, coalesce(v_left, 0);
  end if;
end $$;

-- One chat stream per user (lease 20 s > the 15 s stream cap).
create table if not exists chat_stream_lease (
  tenant_id uuid not null,
  user_id uuid not null,
  lease_id uuid not null,
  expires_at timestamptz not null,
  primary key (tenant_id, user_id)
);

-- Per-service client credentials for POST /internal/v1/service-tokens (global: nil tenant).
create table if not exists service_client (
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000000',
  name text not null check (name in ('intake', 'records', 'journeys', 'crm-engine', 'listings', 'insight')),
  credential_hash bytea not null,         -- HMAC-SHA-256 of the credential
  allowed_audiences text[] not null,
  status text not null default 'active' check (status in ('active', 'revoked')),
  rotated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, name)
);
-- authenticate X-Service-Credential
create unique index if not exists service_client_credential on service_client (credential_hash);
create unique index if not exists service_client_name on service_client (name);

-- ES256 service-token signing keys (global: nil tenant). Private keys are AES-256-GCM encrypted under WEB_KEK.
create table if not exists signing_key (
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000000',
  kid text not null,
  alg text not null default 'ES256',
  public_jwk jsonb not null,
  private_key_enc bytea not null,
  status text not null check (status in ('next', 'active', 'previous', 'retired')),
  activated_at timestamptz not null,
  retire_after timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, kid)
);
-- load the next/active/previous keys at cold start
create index if not exists signing_key_status on signing_key (status);
-- at most one active key
create unique index if not exists signing_key_one_active on signing_key ((status)) where status = 'active';

insert into role (code, description, permissions) values
  ('Admin', 'Everything, plus users, settings, reference data, API keys and the audit log',
   array['api_keys.manage','audit.read','capacity.set','chat.use','dashboards.all','dashboards.quality','deals.work','demand.work','desks.view','desks.work','exits.work','export.create','matches.confirm','merge.undo','offer.retire','publication.set','queue.reassign','records.view','review.work','settings.manage','site_visits.work','supply.work','upload.create','users.manage','watchlist.close']),
  ('Manager', 'Everything a team member can do, plus reassigning work, call capacity, undoing merges and all dashboards',
   array['capacity.set','chat.use','dashboards.all','dashboards.quality','deals.work','demand.work','desks.view','desks.work','exits.work','export.create','matches.confirm','merge.undo','offer.retire','publication.set','queue.reassign','records.view','review.work','site_visits.work','supply.work','upload.create','watchlist.close']),
  ('Demand agent', 'Works demand: quick add, qualify, match, sourcing requests, proposals, site visits, exits',
   array['chat.use','dashboards.all','dashboards.quality','deals.work','demand.work','desks.view','exits.work','export.create','matches.confirm','records.view','site_visits.work','supply.add_for_own_demand','upload.create']),
  ('Supply agent', 'Works offers: call queues, contact, verify, publication levels, Add supply, projects',
   array['chat.use','dashboards.all','dashboards.quality','desks.view','export.create','matches.suggest','offer.retire','publication.set','records.view','site_visits.work','supply.work','upload.create','watchlist.close']),
  ('Data operator', 'Uploads files, maps templates, works review queues',
   array['chat.use','dashboards.quality','desks.view','export.create','records.view','review.work','upload.create'])
on conflict (tenant_id, code) do nothing;
