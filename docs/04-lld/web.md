# 04 — LLD: web (edge web app and BFF)

| | |
|---|---|
| Version | 0.2 (draft; aligned to events v0.2 and conventions §10 R-1…R-22) |
| Date | 2026-09-24 |
| Based on | PRD v0.6 (§2 roles, §5 UI, D-7, D-9, R-CHAT-1, US-34, US-35, FR-NTF-1, NFR-2/13/16/19), HLD v0.2 (Edge web, §3.2, §8, §10.1), ADR-0007, `conventions.md` §4 |
| Contract | `contracts/openapi/web.yaml` (17 operations + the `x-routes` routing table); events per `events.yaml` **v0.2** |
| Status | IN PROGRESS (Stage 4) |

## 1. Purpose and scope
web is the staff-facing **Next.js app on Vercel** (bom1): the chat-first UI, cards and panels. It is also the
**gateway/BFF** for every staff API call.

It owns:
- Google sign-in (Supabase Auth), sessions and the 12 h idle timeout;
- JWT validation and **service-token minting**, including the JWKS used by all services and the token issuer for
  service-to-service calls;
- one-hop **routing** by the `x-routes` table;
- **rate limiting** (Postgres token bucket);
- **correlation IDs**;
- **users, roles and invitations**, published as **`user.changed.v1`** through web's own outbox (consumers journeys,
  insight);
- the immutable **audit log sink** (`audit.recorded.v1`);
- **upload, export and user notifications** (R-6): from `upload.completed.v1`, `upload.failed.v1`,
  `export.completed.v1`, `export.failed.v1`, and web's own user changes.

**It holds no business rules** (ADR-0007):
- It doesn't compose data from several services into decisions.
- It doesn't evaluate ceilings, stages, matches or permissions on business objects.
- For proxied routes it checks only "authenticated, active, tenant", and the owning service applies role rules. This
  avoids two copies of the permission matrix drifting apart.
- Review rule in CI: `src/bff/**` may not import any `@11e/*-domain` package, and route handlers under `api/v1/[...path]`
  may not branch on response bodies.

Out of scope:
- journeys' work notifications (`/v1/notifications`, owned by journeys, R-6);
- capacities (journeys);
- all business data.

## 2. Internal module layout (Next.js App Router + thin BFF)
```
services/web/
  src/app/                                   # Next.js (UI + route handlers); adapters only
    (auth)/sign-in/page.tsx                  # "Sign in with Google" → supabase.auth.signInWithOAuth
    auth/callback/route.ts                   # PKCE code exchange → session cookie → invited-user check
    (app)/layout.tsx                         # sidebar (New chat, My queue, Dashboards, Quick add, Upload, Recent chats)
    (app)/page.tsx                           # Home: Today tiles (C-01) + composer
    (app)/chat/[conversationId]/page.tsx     # conversation; SSE client (fetch + ReadableStream; POST, so no EventSource)
    (app)/settings/**                        # Users & roles, audit log, API keys (listings), RERA (listings), vocabulary (records, read-only)
    api/v1/me/**, api/v1/users/**, api/v1/roles/route.ts, api/v1/audit-log/route.ts   # web's own endpoints
    api/v1/[...path]/route.ts                # the proxy: route table → downstream (streams bodies, SSE passthrough)
    internal/v1/relay/route.ts, internal/v1/drain/[queue]/route.ts, internal/v1/jobs/[name]/route.ts,
    internal/v1/service-tokens/route.ts
    .well-known/jwks.json/route.ts
    health/live/route.ts, health/ready/route.ts
  middleware.ts                              # session refresh, correlation id, CSRF origin check (edge-safe)
  next.config.ts                             # rewrites /v1/:path* → /api/v1/:path*
  src/ui/                                    # React: card renderers C-01…C-21, panels P-01…P-08, forms from controlled lists
    cards/ActionCard.tsx                     # renders insight ProposedActionCard; on click → fetch(method, path, payload, Idempotency-Key)
  src/bff/                                   # thin layer, web-own logic only (users, audit, tokens, limits)
    domain/                                  # pure: role/permission table (PRD §2.3 codes for /v1/me), user status rules
                                             # (last admin, own role), audit hash chain, notification text templates
    application/
      ports/ UserRepo, InvitationRepo, AuditRepo, NotificationRepo, RateLimiter, ChatStreamLease, TokenSigner,
             SigningKeyStore, AuthProvider (Supabase Auth admin), RouteTable, Downstream (HTTP client), IdempotencyStore,
             ServiceClientRepo, Outbox (libs/outbox), Clock
      Authenticate, GetMe, SignOut, InviteUser, RevokeInvitation, UpdateUser, ListUsers, ListAuditLog,
      ListMyNotifications, MarkRead, ProxyRequest, MintServiceToken, RecordAudit, ApplyEvent, jobs
    adapters/ supabase-auth, db (postgres via Supavisor), http (undici: timeouts, retry, circuit breaker),
              messaging (outbox relay → pgmq; drain q_web), crypto (ES256 via jose), composition.ts
  migrations/  tests/  Dockerfile  README.md
```
Layering (`domain → application → adapters`) is enforced by the import linter. UI components never call services
directly: they call `/v1/...` on web.

## 3. Data schema (schema `web`, role `web_svc`)
Every table has `tenant_id uuid not null`, `created_at`, `updated_at`. The PK is `(tenant_id, id)` unless noted.

**`role`** (seeded, read-only): code text (Admin, Manager, Demand agent, Supply agent, Data operator), description,
permissions text[] (e.g. `records.view`, `upload.create`, `review.work`, `merge.undo`, `publication.set`,
`users.manage`, `audit.read`). Index: UNIQUE (tenant_id, code). Global seed rows use the nil tenant.

**`users`**

| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | no | = Supabase `auth.users.id` |
| email | text | no | **PII**. Lowercased Google e-mail |
| email_hash | bytea | no | HMAC-SHA-256(lower(email)): uniqueness and lookup without scanning plaintext |
| display_name | text | no | **PII** |
| role | text | no | FK role.code |
| is_data_operator | boolean | no | A-15 |
| status | text | no | invited / active / deactivated |
| invited_by | uuid | yes | |
| invited_at, activated_at, deactivated_at | timestamptz | yes | |
| last_seen_at | timestamptz | yes | written at most once a minute per instance (idle timeout) |
| version | integer | no | If-Match / ETag |

| Index | Serves |
|---|---|
| PK (tenant_id, id) | GET /v1/me, PATCH, role cache load |
| UNIQUE (id) | sign-in callback: look up by the Supabase user id before the tenant is known (documented exception to tenant-first) |
| UNIQUE (tenant_id, email_hash) | invite duplicate check |
| (tenant_id, display_name, id) | `GET /v1/users` sorted by name, cursor |
| (tenant_id, role, status) | filters `role=` / `status=`; the last-admin check (`role='Admin' AND status='active'`) |
| (tenant_id, status, last_seen_at) WHERE status = 'active' | `idle-session-sweep` |

**`invitation`**: id, user_id, email_hash, role, is_data_operator, status (pending / accepted / revoked / expired),
invited_by, expires_at (7 days), accepted_at.
Indexes:
- (tenant_id, user_id): revoke;
- UNIQUE (tenant_id, email_hash) WHERE status = 'pending': `email-already-invited`;
- (tenant_id, status, expires_at) WHERE status = 'pending': `invitation-expire`.

**`audit_log`**: **immutable**, append-only, kept 24 months (≥ 1 year, US-35).

| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | no | |
| event_id | uuid | yes | source `audit.recorded.v1` eventId (null for web's own entries) |
| occurred_at | timestamptz | no | from the event |
| recorded_at | timestamptz | no | partition key (monthly range partitions) |
| producer | text | no | web / intake / records / journeys / crm-engine / listings / insight |
| action | text | no | e.g. contact.viewed, export.created, merge.done, merge.undone, publication.set, publication.auto_changed, demand.exited, deal.closed, settings.changed, api_key.created, user.invited, user.role_changed, user.deactivated, session.signed_out |
| actor_user_id | uuid | no | the reserved system id `00000000-0000-0000-0000-000000000001` for system actions (R-7) |
| subject_type, subject_id | text, uuid | no | |
| via | text | no | ui / chat / system |
| details | jsonb | no | PII-free by producer contract; scrubbed by web (§4.6) |
| correlation_id | text | yes | |
| prev_hash, entry_hash | bytea | no | per-tenant SHA-256 hash chain (tamper evidence) |

- PK: (tenant_id, recorded_at, id), because the partition key must be in the PK.
- Grants: `web_svc` has **INSERT, SELECT only**. A trigger raises on UPDATE/DELETE. Old partitions are dropped only by
  the `web_owner` pg_cron SQL job (24 months).

| Index | Serves |
|---|---|
| (tenant_id, occurred_at DESC, id DESC) | `GET /v1/audit-log` default, cursor |
| (tenant_id, actor_user_id, occurred_at DESC) | `actorUserId=` |
| (tenant_id, subject_type, subject_id, occurred_at DESC) | `subjectType=&subjectId=` (history of one record) |
| (tenant_id, action text_pattern_ops, occurred_at DESC) | `action=` exact or prefix `export.*` |
| (tenant_id, producer, occurred_at DESC) | `producer=` |
| UNIQUE (tenant_id, event_id, recorded_at) WHERE event_id IS NOT NULL | second-level dedupe of redelivered audit events |

**`notification`**: id, user_id, kind (upload_completed / upload_failed / export_ready / export_failed /
role_changed / account_reactivated), subject_type (upload / export / user), subject_id, subject_code, title
(PII-free), link, source_event_id (null for web's own user notifications), read_at.
Indexes:
- (tenant_id, user_id, created_at DESC, id DESC): list + cursor;
- (tenant_id, user_id) WHERE read_at IS NULL: unread count and `unreadOnly`;
- UNIQUE (tenant_id, source_event_id) WHERE source_event_id IS NOT NULL: dedupe;
- (tenant_id, created_at): 90-day prune.

**`rate_limit_bucket`**: subject_key text (user id, or HMAC of the client IP for `public_page`), bucket text (api,
chat_msg, upload, public_page), tokens numeric, refilled_at.
- PK (tenant_id, subject_key, bucket): the take-token upsert.
- Prune: (refilled_at), for rows idle > 1 h.

**`chat_stream_lease`**: user_id, lease_id uuid, expires_at.
- PK (tenant_id, user_id): acquire with `INSERT … ON CONFLICT DO UPDATE … WHERE expires_at < now()`.

**`idempotency_keys`** (R-3; technical table, R-4): user_id, route, key, request_hash, status_code, response_body, expires_at (24 h).
- UNIQUE (tenant_id, user_id, route, key): replay (web's own POST endpoints only).
- (expires_at): prune.

**`service_client`**: name (listings, records, journeys, insight, intake, crm-engine), credential_hash bytea,
allowed_audiences text[], status, rotated_at.
- UNIQUE (credential_hash): authenticate `X-Service-Credential`.
- UNIQUE (name).

**`signing_key`**: kid, alg (ES256), public_jwk jsonb, private_key_enc bytea (AES-256-GCM under `WEB_KEK` from Vercel
env), status (active / previous / retired), activated_at, retire_after.
- Index (status): load the active + previous keys at cold start. A global table (the nil tenant).

**Plumbing** (technical tables, R-4):
- `outbox` (conventions §6): used for **`user.changed.v1`**. The index `(published_at) WHERE published_at IS NULL,
  created_at` serves the relay batch. `POST /internal/v1/relay` (pg_cron every minute + poke after commit).
- `processed_events` (event_id PK) and `job_checkpoint`.
- web's own audit entries are still written directly to `audit_log` (web is the sink), not through the outbox.

## 4. Business rules and algorithms (web-own only)

### 4.1 Authentication flow (D-7, NFR-16)
1. `/auth/sign-in` → `supabase.auth.signInWithOAuth({provider:'google', options:{redirectTo:'/auth/callback'}})`,
   with PKCE. Supabase **sign-ups are disabled**, so only invited users exist in `auth.users`.
2. `/auth/callback`:
   - exchange the code → session (access token 1 h + refresh token), set in httpOnly Secure SameSite=Lax cookies
     (`@supabase/ssr`);
   - look up `web.users` by `id`:
     - absent → sign out, redirect with `not-invited`;
     - `deactivated` → sign out, `user-deactivated`;
     - `invited` → set `active`, `activated_at`, and mark the invitation `accepted`, in one transaction, with an audit
       entry `user.activated` and an outbox row `user.changed.v1 {userId, role, active: true, displayName}`.
3. **Each request** (`middleware.ts` + `Authenticate`):
   a. Refresh the session if the access token is near expiry.
   b. Verify the Supabase JWT (local JWKS verification, cached 10 min; `aud`, `exp`, `iss`).
   c. Load `{role, tenantId, status, isDataOperator}` from the in-memory user cache (TTL 60 s). The cache is evicted on
      PATCH /v1/users in the same instance. Other instances pick the change up within 60 s. Service tokens live 5 min,
      so a deactivation takes full effect within ≤ 5 min.
   d. **Idle timeout 12 h:** if `now − last_seen_at > 12 h` → sign out, `401 session-expired`. `last_seen_at` is written
      at most once a minute.
   e. **CSRF:** for POST/PUT/PATCH/DELETE, `Origin` must equal the app origin, else `403 origin-not-allowed`. Cookies
      are SameSite=Lax.
   f. Correlation ID (§4.5) → rate limit (§4.4) → route (§4.3) or the own handler.
4. **2-step verification** (NFR-16) is a Google account policy. web can't read it from the OIDC token for consumer
   accounts. See OQ-W1.

### 4.2 Service-token minting (conventions §4)
- web is the **issuer** for all service tokens and the JWKS (conventions R-2).
- **Signing:** ES256 (`jose`). The active key comes from `signing_key`, and its private key is decrypted with
  `WEB_KEK` at cold start. **JWKS** at `/.well-known/jwks.json` (active + previous; CDN cache 10 min).
- **User-context token** (for proxied calls):

  ```
  {iss:"web", sub:"web", aud:"<service>", tid, uid, role, dop, jti, iat, exp: iat+300, cid:<correlationId>}
  ```

  - It's cached per (uid, aud) in instance memory for 240 s.
  - Headers `X-User-Id`, `X-User-Role`, `X-Tenant-Id` are set from the same values. Services verify the signature,
    `aud`, `exp`, and that the headers equal the claims.
- **Service-to-service token** (`POST /internal/v1/service-tokens`):
  - The caller authenticates with `X-Service-Credential` (HMAC compared with `service_client.credential_hash`).
  - The audience must be in `allowed_audiences` (listings→records for rebuilds and scan-terms (R-20), journeys→records,
    insight→records for contacts:batch (R-21), records→intake row fetch, crm-engine→records, and every service→records
    for the vocabulary fetch).
  - Token: `{iss:"web", sub:"<caller>", aud, tid, jti, exp: +300}`, with no `uid`.
  - Used only for projection rebuilds and background jobs, **never** in a user request chain (HLD §3.2).
- **Rotation:** `signing-key-rotate` every 90 days.
  1. Generate a new key and publish it in JWKS as `previous-to-be` for 10 min.
  2. Switch it to `active`.
  3. Keep the old key as `previous` for 1 h, then retire it.

### 4.3 Routing (`x-routes`, sync depth ≤ 2)
- The table is compiled at build time into an ordered matcher, first match wins (specific sub-resources such as
  `/v1/offers/*/publication` come before `/v1/offers`).
- The target base URL comes from env: `SVC_<NAME>_URL`.
- Forwarding: method, path and query unchanged. The body is streamed (up to 1 MB; uploads go straight to storage via
  intake's signed URL).
- Headers added: service token, `X-User-*`, `X-Tenant-Id`, `X-Correlation-Id`, `traceparent`. Passed through:
  `Idempotency-Key`, `If-Match`, `Content-Type`, `Accept`. Client `X-User-*`/`X-Tenant-*` headers are stripped.
- The response is streamed back unchanged (SSE with `Cache-Control: no-transform`, no buffering). Added headers:
  `X-Correlation-Id`, `X-RateLimit-*`.
- **Resilience** (conventions §4):
  - timeout 2 s (chat SSE: first byte 3 s, total 15 s);
  - 1 retry with 100–400 ms jitter for GET/PUT/DELETE, and for POST/PATCH only when the request carries an
    Idempotency-Key or If-Match;
  - a circuit breaker per downstream (50% errors over 20 calls → open 30 s → half-open).
  - Breaker open or timeout → 503 `dependency-unavailable` with `Retry-After: 30`.
- **Call-outcome card (HLD §7):** the UI makes the two writes (records + journeys) itself, as two calls through web,
  each with its own Idempotency-Key. web doesn't orchestrate them.
- The proposal share page `/p/{token}` is routed with **no auth**, and only the `public_page` limit per IP.

### 4.4 Rate limiting (Postgres token bucket)
- `web.take_token(tenant, subject, bucket, rate, burst, cost)` is a single `INSERT … ON CONFLICT DO UPDATE SET
  tokens = LEAST(burst, tokens + elapsed*rate) − cost … WHERE LEAST(…) ≥ cost RETURNING tokens`.
  - No row returned → 429 `rate-limited`, `Retry-After = ceil((cost − tokens)/rate)`.
- Buckets:
  - `api`: 20/s, burst 40 per user, on every proxied and own call;
  - `chat_msg`: 30/min per user, on POST chat messages;
  - `upload`: 5/h per user, on POST /v1/uploads;
  - `public_page`: 60/min per HMAC(IP), on `/p/*`.
- **Chat concurrency:** `chat_stream_lease` (1 per user, 20 s lease > the 15 s stream cap), released when the stream
  ends. A second concurrent stream → 429.
- **Lease blocks:** for `api`, each instance takes 5 tokens per DB round trip, so writes drop 5× (over-admit ≤ 4
  requests per instance per window).
- **Failure:** if the DB call fails or exceeds 50 ms, fall back to an in-memory bucket (half the rates) and raise the
  metric `ratelimit_fallback`. This is fail-open, for availability.
- The Listings public API is **not** limited here (listings does it; see listings A-L7).

### 4.5 Correlation IDs and observability
- Accept `X-Correlation-Id` if it matches `^[A-Za-z0-9-]{8,64}$`. Otherwise generate a UUIDv7.
- Echo it on the response, put it in the service token (`cid`), and log it on every line.
- Start an OpenTelemetry span per request (`traceparent` propagated).
- RED metrics per route prefix and per downstream, plus breaker state in `/health/ready`.

### 4.6 Audit sink (US-35)
- The `q_web` drain gets `audit.recorded.v1`:
  1. Dedupe (`processed_events` + unique event_id).
  2. **Validate and scrub** `details`: v0.2 defines it as a flat string map with no PII (IDs, codes, counts, field
     names). Non-string values are rejected to the DLQ. Any value matching the phone/e-mail patterns (`libs/redaction`)
     is removed and `details.scrubbed = "true"` is set, which raises an alarm (defence in depth).
  3. Insert with the per-tenant hash chain (`pg_advisory_xact_lock('audit:'||tenant)`,
     `entry_hash = sha256(prev_hash ‖ canonical_json(entry))`).
- web's own actions write directly with the same helper, in the same transaction as the change:
  - user.invited, user.invitation_revoked, user.activated, user.role_changed, user.deactivated, user.reactivated;
  - session.signed_out.
- `audit-chain-verify` runs daily over 48 h and alarms on a mismatch.
- Read: Admin only, cursor, filters on stored fields. `actorDisplayName` is resolved at read time from `users`.

### 4.7 Notifications (FR-NTF-1, web's part per R-6)
| Event | Recipient | Title (no PII) | Link |
|---|---|---|---|
| upload.completed.v1 | `uploadedBy` | "{code} processed: {accepted} accepted, {rejected} rejected, {needsReview} to review" | /uploads/{code} |
| upload.failed.v1 | `uploadedBy` | "{code} failed: {reason code → fixed message}". Free-text reasons are replaced by a generic message | /uploads/{code} |
| export.completed.v1 | `requestedBy` | "{code} is ready ({rowCount} rows). Link valid 24 h" | /exports/{code} |
| export.failed.v1 | `requestedBy` | "{code} failed ({reason code → fixed message})" | /exports/{code} |
| web's own PATCH /v1/users (role change, reactivation) | the affected user | "Your role is now {role}" / "Your account was reactivated" | /settings/profile |

- Delivery: the UI polls `GET /v1/me/notifications?unreadOnly=true` every 30 s and on window focus. **No SSE** for
  notifications: serverless streams cost function time and would count against the single chat stream.
- The bell merges web's list with journeys' `/v1/notifications` **client-side** (sorted by createdAt). web doesn't
  aggregate across services (no composition logic, and no extra hop).

### 4.8 Users and roles (US-34)
- **Invite (Admin):**
  1. Validate the e-mail.
  2. `email_hash` must be unique for pending or active users.
  3. Supabase Auth admin `inviteUserByEmail` (service_role key, web only; data-hosting §3), with the redirect to
     `/auth/callback`.
  4. Insert `users` (status invited) + `invitation` + audit entry + outbox `user.changed.v1 {active: false}`, in one
     transaction after the Supabase call succeeds.
  5. If Supabase fails → 503 and nothing stored. If the DB fails after Supabase succeeds, a compensation deletes the
     Supabase user.
  6. The invite e-mail comes from Supabase. Fallback (HLD §8): the Admin copies the invite link.
- **Role change / deactivate:**
  - JSON Merge Patch with If-Match.
  - Rules (web-own domain): a user can't change their own role; the last active Admin can't be demoted or deactivated
    (409 `last-admin`).
  - Deactivate → Supabase admin `signOut(userId, 'global')`, evict caches, audit.
  - Every role, status or display-name change (and revoking an invitation) writes `user.changed.v1 {userId, role,
    active, displayName}` to the outbox in the same transaction, so journeys (capacities, assignees) and insight
    ("per agent") stay current.
- There are no per-object permissions in web. The `permissions` list in `/v1/me` only drives UI visibility (hiding
  buttons). Services enforce the real rules.

## 5. Events
**Produced** (outbox → `POST /internal/v1/relay` → queues `q_journeys`, `q_insight`):

| Event | When | Payload |
|---|---|---|
| `user.changed.v1` | Invite (active false), first sign-in (active true), role/data-operator/display-name change, deactivate/reactivate, invitation revoked or expired | userId, role, active, displayName (staff name only; no e-mail) |

web's own audit entries are written locally, since web is the audit sink.

**Consumed** (queue `q_web`; exactly the 5 web subscriptions in `events.yaml` v0.2):
- `audit.recorded.v1` (producer `*`) → `audit_log`;
- `upload.completed.v1`, `upload.failed.v1` (intake; `uploadedBy` is now required) → notification;
- `export.completed.v1`, `export.failed.v1` (insight) → notification.

## 6. Error codes
| Code | HTTP | Where | Meaning |
|---|---|---|---|
| validation-failed | 400 | own endpoints | |
| unauthenticated | 401 | all | No or invalid session |
| session-expired | 401 | all | Idle > 12 h |
| service-credential-invalid | 401 | /internal/v1/service-tokens | |
| not-invited | 403 | callback, /v1/me | Google account not invited |
| user-deactivated | 403 | all | |
| forbidden | 403 | own endpoints | Role not allowed (e.g. non-Admin on /v1/audit-log) |
| origin-not-allowed | 403 | mutating requests | CSRF origin check |
| audience-not-allowed | 403 | /internal/v1/service-tokens | |
| not-found / route-not-found | 404 | all | Unknown resource / no route |
| email-already-invited, user-exists | 409 | invite | |
| invitation-already-accepted | 409 | revoke invitation | |
| last-admin, cannot-change-own-role | 409 | PATCH user | |
| idempotency-key-reused | 409 | own POST | |
| version-mismatch | 412 | PATCH user | |
| unsupported-media-type | 415 | PATCH user | Not `application/merge-patch+json` |
| rate-limited | 429 | all | Any bucket, or a second chat stream |
| dependency-unavailable | 503 | proxy, invite | Downstream timeout, breaker open, Supabase Auth down |
| internal | 500 | all | |

Errors from downstream services pass through unchanged (RFC 7807 from the owner). web adds `correlationId` if it's
missing.

## 7. PII fields and retention
| Field | Why | Handling | Retention |
|---|---|---|---|
| users.email | Sign-in identity, invites | PII; `email_hash` for lookups; shown only to Admins; never logged | While the user exists. Anonymised (`email = 'deleted+<id>'`, name "Former user") 24 months after deactivation. `id` is kept so audit entries resolve |
| users.display_name | UI, assignee pickers | PII (staff); never logged | Same |
| rate_limit_bucket.subject_key (public_page) | IP rate limit | HMAC of the IP, not reversible | Deleted after 1 h idle |
| audit_log.details | Audit | Flat string map, PII-free by contract (v0.2); scrubbed on ingest | 24 months (R-15; ≥ 1 year, US-35), then partitions are dropped |
| user.changed.v1 displayName | journeys/insight need the staff name for pickers | Staff name only (conventions §9 "staff name" owned by web); never client/owner PII | Per consumer |
| notification.title | UI | Codes and counts only | 90 days |
| Session cookies | Auth | httpOnly, Secure; never logged | Supabase session lifetime; 12 h idle |

Logs: the allow-list from conventions §7. Request and response bodies are **never** logged by the proxy.

## 8. Performance (NFR-2, NFR-7, NFR-16)
- **Overhead budget per proxied call:** p95 ≤ 30 ms.

  | Step | Budget |
  |---|---|
  | JWT verify (local JWKS) | ~1 ms |
  | User cache hit | < 1 ms |
  | Token-bucket DB round trip (same region, lease blocks) | ~5–8 ms |
  | Service token (cached) | < 1 ms |
  | Proxy hop to a bom1 function | ~10–15 ms |

  That leaves ≥ 250 ms for the owning service inside the 300 ms NFR-2 target.
- **Volume:** staff traffic is small (tens of users, at most a few hundred rps at peak). The 1,000 rps NFR mostly
  concerns the Listings API, which doesn't pass through web. `web_svc` pool: pilot 3, production 6–8 (data-hosting §5).
  Little's law: 200 rps × 8 ms ≈ 2 concurrent DB calls for rate limits.
- **SSE passthrough:** no buffering. The Vercel function stays open ≤ 15 s per chat stream. It's capped by
  `chat_stream_lease` (1 per user).
- **Cold starts:** Fluid compute keeps instances warm. The signing key and JWKS load once per instance.
- **Pilot (CR-005):** Hobby limits. The same design, best effort. The `keep-alive` job pings every 12 h.

## 9. Endpoint summary
| Method | Path | Auth | Roles | Idempotency | Paginated | Rate limit | Timeout | Emits |
|---|---|---|---|---|---|---|---|---|
| GET | /v1/me | staffSession | all staff | safe | — | api 20/s | 2 s | — |
| DELETE | /v1/me/session | staffSession | all staff | idempotent | — | api | 2 s | — (local audit) |
| GET | /v1/me/notifications | staffSession | all staff | safe | cursor ≤ 100 | api | 2 s | — |
| POST | /v1/me/notifications/read | staffSession | all staff | natural + Idempotency-Key | — | api | 2 s | — |
| GET | /v1/roles | staffSession | all staff | safe | — (≤ 10) | api | 2 s | — |
| GET | /v1/users | staffSession | all staff (email for Admin only) | safe | cursor ≤ 100 | api | 2 s | — |
| POST | /v1/users/invitations | staffSession | Admin | Idempotency-Key | — | api + 20/h per tenant | 2 s | user.changed.v1 (+ local audit) |
| DELETE | /v1/users/invitations/{userId} | staffSession | Admin | idempotent | — | api | 2 s | user.changed.v1 (+ local audit) |
| PATCH | /v1/users/{userId} | staffSession | Admin | Merge Patch + If-Match | — | api | 2 s | user.changed.v1 (+ local audit) |
| GET | /v1/audit-log | staffSession | Admin | safe | cursor ≤ 100 | api | 2 s | — |
| GET | /.well-known/jwks.json | none | services | safe | — | CDN | 0.5 s | — |
| POST | /internal/v1/service-tokens | serviceCredential | services | none needed (no side effects) | — | 60/min per caller | 2 s | — |
| POST | /internal/v1/relay | cronSecret | scheduler | idempotent (SKIP LOCKED) | — | — | 55 s | user.changed.v1 (relayed) |
| POST | /internal/v1/drain/{queue} | cronSecret | scheduler | processed_events | batch ≤ 500 | — | 55 s | — |
| POST | /internal/v1/jobs/{name} | cronSecret | scheduler | resumable | — | — | 55 s | — |
| GET | /health/live | none | — | safe | — | — | 0.5 s | — |
| GET | /health/ready | none | — | safe | — | — | 1 s | — |
| * | every other `/v1/**` and `/p/*` | per `x-routes` | owner decides | passthrough | owner | api (+ chat/upload/public_page) | 2 s (chat 3 s / 15 s) | owner |

**Idempotency decision (confirmed by R-3):** each service keeps **its own** idempotency store (the `libs/idempotency` table in its
schema, keyed per tenant + user + route + key). web **forwards `Idempotency-Key` unchanged** and stores keys only for
its own endpoints. Why:
1. A replay must return the **owner's** original status and body, including ids the owner created. A web-side cache
   would have to store every service's responses, which would put other services' data (including PII in responses)
   into the web schema, breaking data ownership (CLAUDE.md §3.2).
2. Scheduler, service-to-service and retry calls that never pass through web are protected too.
3. The owner can compare the request hash against its own validation (409 `idempotency-key-reused`).

## 10. Contract gaps, assumptions, open questions

### Closed by events v0.2 and conventions §10
| Former gap | Resolution |
|---|---|
| W-1 uploadedBy | required in `upload.completed/failed.v1` |
| W-2 export failure | `export.failed.v1` consumed → notification |
| W-3 system actor | R-7 (`00000000-0000-0000-0000-000000000001`) |
| W-4 audit details | a flat string map with no PII (web still scrubs as defence in depth) |
| W-5 user lifecycle | web **emits** `user.changed.v1` (outbox + relay added) |
| W-6 listings rate limit | R-1: enforced by listings |
| W-7 service tokens | R-2: web is the issuer; `_common` serviceToken description updated |
| W-8 notifications split | R-6 |
| OQ-W2 audit retention | R-15: 24 months |

### Remaining gaps
| # | Gap | Proposal |
|---|---|---|
| W-9 | `_common.yaml` has no scheme for the caller's client secret on `POST /internal/v1/service-tokens`. It's declared locally in web.yaml as `serviceCredential` (`X-Service-Credential`). | Optionally move it to `_common.yaml`, so every service's README references one definition. |
| W-10 | The routing table follows the current records/journeys/crm-engine/intake paths (incl. `/v1/queue-items`, `/v1/life-curves`, `/v1/settings/*`, `/v1/second-sources`, `/v1/reveals`, `/v1/source-ads`, `/v1/launch-area`, `/v1/market-data`, `/v1/matching-runs`). | Re-check it when those contracts are frozen. A contract test fails the build if a `/v1` path in any service spec has no route. |

### Assumptions
- **A-W1** Proxied routes are gated by authentication, active status and tenant only. Role rules live in the owning
  service.
- **A-W3** Invitations expire after 7 days. Re-invite is allowed after expiry or revocation.
- **A-W4** Rate-limit store failure fails **open** with a lower in-memory limit (availability over strictness).
- **A-W5** Notifications are polled every 30 s (no push channel in Phase 1).

### Open questions (product owner)
- **OQ-W1** NFR-16 requires 2-step verification on Google accounts, but web can't verify it for personal Gmail
  accounts. Options: (a) require Google Workspace accounts with 2SV enforced by the 11 Estates Workspace admin;
  (b) accept it as a policy with no technical check.
