# web

Next.js chat-first UI + BFF gateway (sign-in, service tokens, routing, users & roles, audit sink).

|          |                                                                                  |
| -------- | -------------------------------------------------------------------------------- |
| Contract | `contracts/openapi/web.yaml` (BFF own endpoints + routing table)                 |
| Events   | `contracts/asyncapi/events.yaml` (produced/consumed per `docs/04-lld/web.md` §5) |
| Design   | `docs/04-lld/web.md`, UI: `docs/prototype/11estate-crm-prototype.html`           |
| Tasks    | `docs/05-tasks.md` (WEB-\*)                                                      |
| Owner    | Sarang Bondre (see `CODEOWNERS`)                                                 |

## Layout

Next.js 16 App Router + React 19 + Tailwind 4. Server code follows the service layering (dependency-cruiser):

```
src/domain/        pure rules: roles/permissions, user rules, audit hash chain, service-token policy, errors
src/application/   use cases (Sessions, Tokens, …) and ports
src/adapters/      db (Kysely), supabase (Auth + cookie sessions), signer (jose ES256), crypto, http (Hono app)
src/main.ts        composition root (one runtime per server instance)
src/app/           Next.js routes: pages, /auth/*, and route handlers that hand /v1, /internal, /health and
                   /.well-known/jwks.json to the Hono app
src/proxy.ts       refreshes the Supabase session on page navigations; no session → /sign-in
src/ui/            React: shell, chat thread, cards, panels (calls /v1 on web only)
migrations/        0001 technical tables, 0002 web schema
scripts/           local-env, bootstrap-admin, service-client
tests/             Vitest: domain, use cases + HTTP contract on in-memory adapters, @11e/auth compatibility,
                   Postgres integration (skipped when the local DB is not reachable)
```

## Sign-in (D-7, questionnaire A6)

- Google via Supabase Auth (PKCE): `POST /auth/sign-in` → Google → `GET /auth/callback`. Only users that exist in
  `web.users` get in; the first sign-in of an invited user activates it (audit `user.activated`, `user.changed.v1`).
  A Google account that was never invited is refused (`/sign-in?reason=not-invited`) and removed from Supabase Auth.
- E-mail links (`GET /auth/confirm?token_hash=…&type=invite|magiclink`) for the Supabase invite template.
- Sessions: httpOnly, SameSite=Lax cookies (`@supabase/ssr`); 12 h idle timeout (`session-expired`); CSRF origin check
  on cookie-authenticated POST/PUT/PATCH/DELETE.
- The first Admin is created with `bootstrap-admin`; everyone else is invited in the app (Settings → Users, WEB-04).

## Service tokens (R-2)

- `GET /.well-known/jwks.json`: ES256 keys (next + active + previous). Keys are created on first use, stored AES-256-GCM
  encrypted under `WEB_KEK`, rotated by the `signing-key-rotate` job (a new key is published before it signs).
- `POST /internal/v1/service-tokens` with `X-Service-Credential`: `{iss: web, sub: <caller>, aud, tid, jti, exp: +5 min}`
  for the allowed pairs (listings/journeys/insight/crm-engine → records, records → intake). Create a credential with
  `pnpm --filter @11e/web service-client <service>` and put it into that service's `SERVICE_CREDENTIAL`.
- User-context tokens for proxied calls: `{iss: web, sub: web, aud, tid, uid, role, dop}` + `X-User-Id`, `X-User-Role`,
  `X-Tenant-Id` (verified by `@11e/auth`), cached per user and audience for 4 min.

## Gateway (web LLD §4.3–4.5)

- Routing: the contract's `x-routes` table (first match wins; `*` one segment). web's own operations always win; any
  other `/v1/**` path goes one hop to its owner at `SVC_<NAME>_URL`; unknown paths → `404 route-not-found`;
  `/internal/**` is never routed. A test checks that every staff path of every service contract routes to its owner.
- Checks only "authenticated, active, tenant" (ADR-0007); the owning service applies role rules. Client `X-User-*`,
  `X-Tenant-*`, `Authorization` and cookies are not forwarded; web adds its user-context service token, `X-User-Id`,
  `X-User-Role`, `X-Tenant-Id`, `X-Correlation-Id` and `traceparent`. `Idempotency-Key`, `If-Match`, `Content-Type`
  and `Accept` pass through unchanged (services own idempotency, R-3).
- One hop only (sync depth ≤ 2 end to end): the gateway makes exactly one downstream call per request and never calls
  itself; services call each other only with service tokens outside user request chains.
- Resilience: 2 s timeout (`/v1/parse` 4 s; chat stream first byte 3 s, total 15 s), one retry with 100–400 ms jitter
  for GET/PUT/DELETE and for POST/PATCH carrying `Idempotency-Key`/`If-Match`, a circuit breaker per downstream (state
  in `/health/ready`). Timeout / open breaker → `503 dependency-unavailable` + `Retry-After: 30`.
- Responses stream back unchanged (SSE with `Cache-Control: no-transform`); web adds `X-Correlation-Id`,
  `X-RateLimit-Limit/Remaining`, and the correlation id to downstream problems that lack it.
- Rate limits (Postgres token bucket `web.take_token`): `api` 20/s burst 40 per user on every own and proxied call
  (taken in blocks of 5 per round trip), `chat_msg` 30/min, one concurrent chat stream (`chat_stream_lease`), `upload`
  5/h, `public_page` 60/min per HMAC(client IP) on `/p/*`, `service_token` 60/min per caller. A store error or a round
  trip over 50 ms falls back to an in-memory bucket at half the rates (fail-open) and logs `ratelimit_fallback`.
- Correlation ids: `X-Correlation-Id` accepted if it matches `^[A-Za-z0-9-]{8,64}$`, else a UUIDv7.

## Users, audit and notifications (web LLD §4.6–4.8)

- `GET /v1/users` (directory for everyone; e-mail and audit fields for Admins), `POST /v1/users/invitations`
  (Admin; Supabase invite e-mail, then users + invitation + audit + `user.changed.v1` in one transaction; the Supabase
  user is deleted again if the transaction fails; 20 invitations/h per tenant; Idempotency-Key replay),
  `DELETE /v1/users/invitations/{id}` (revoke), `PATCH /v1/users/{id}` (merge patch + If-Match: role, Data operator
  flag, display name, deactivate/reactivate; own role and the last active Admin are protected; deactivation blocks the
  Supabase user and evicts caches at once), `GET /v1/roles`.
- Audit sink: `audit.recorded.v1` from every producer → `audit_log` (dedupe on eventId, `details` must be a flat string
  map — non-strings go to the DLQ, contact-like values are removed and `scrubbed=true` is set), per-tenant hash chain;
  web's own actions (invites, role changes, activation, sign-out) are written directly. `GET /v1/audit-log` (Admin).
- Notifications: `upload.completed/failed.v1` → uploader, `export.completed/failed.v1` → requester, role change /
  reactivation → the user. `GET /v1/me/notifications`, `POST /v1/me/notifications/read`. The bell in the top bar
  merges them with journeys' `/v1/notifications` client-side and polls every 30 s and on focus.
- Scheduler (`X-Cron-Secret`): `POST /internal/v1/relay`, `/internal/v1/drain/q_web`, `/internal/v1/jobs/{name}` for
  `invitation-expire`, `idle-session-sweep`, `notification-prune`, `rate-limit-prune`, `idempotency-prune`,
  `audit-chain-verify` (48 h window, logs `audit_chain_broken`; also keeps monthly partitions 3 months ahead),
  `signing-key-rotate`, `keep-alive`.

## Run locally

```sh
pnpm install && pnpm db:start && pnpm db:env > .env.local     # repo root: local Postgres + WEB_DATABASE_URL etc.
pnpm --filter @11e/web migrate                                 # web schema (web_migrator)
pnpm --filter @11e/web env:local                               # services/web/.env.local (Supabase keys, WEB_KEK, …)
pnpm --filter @11e/web bootstrap-admin --email admin.local@example.com --name "Local Admin"
pnpm --filter @11e/web dev                                     # http://127.0.0.1:3000
pnpm --filter @11e/web test
```

Google OAuth is not configured on the local stack; with `ENVIRONMENT_NAME=local` the sign-in page also offers an
e-mail link (existing users only), delivered to the local mail catcher at http://127.0.0.1:54324.

## Cards and panels (PRD §5.4)

Each area registers its cards and panels in `src/ui/cards/<area>/index.ts` (`all.ts` loads them): intake (C-04
upload, C-05 review), records (C-06 quick add, C-07 add supply, P-02…P-05 record panels + contact reveal, P-08 desks,
C-21 desk item), journeys (P-01 My queue, C-08 call outcome, C-09 qualify, C-11 sourcing, C-13 proposal, C-14 site
visit, C-15 deal, C-16 exit, C-17 retire/close), engine (C-10 matches and bundles), listings (C-12 publication),
insight (C-02/C-03 streamed answers with How I got this and proposed action cards, P-07 table, C-20/P-06
dashboards, exports), and the Settings page (`src/ui/settings`). Rules every card follows: data only through `/v1`
on web; nothing changes until a click (R-CHAT-1), one Idempotency-Key per action, merge patch + If-Match where the
contract has versions; controlled dropdowns from the vocabulary; buttons disabled for roles outside the contract's
`x-roles` (services re-check); pure logic in `<area>/logic.ts` with unit tests in `tests/ui/`.

## End-to-end tests and accessibility (WEB-09)

Playwright + axe-core against the local stack (`e2e/`, `playwright.config.ts`):

```sh
pnpm db:start && pnpm --filter @11e/web migrate && pnpm --filter @11e/web env:local   # once
pnpm --filter @11e/web build
pnpm --filter @11e/web e2e          # starts the Prism mocks (4011–4016) and `next start` on :3000 unless running
```

- `e2e/global-setup.ts` seeds one synthetic user per role (Supabase Auth + `web.users`) and signs each in through
  `/auth/confirm` with an admin-generated magic link; storage states land in `e2e/.auth/` (git-ignored).
- `shell.spec.ts`: sign-in redirect, 401 problems, home, "/" menu by keyboard, side panel, theme, sign-out.
- `cards.spec.ts`: every card and panel renders against the contract mocks without errors, panel tabs work by
  keyboard, every Settings tab — each with an axe WCAG 2.1 A/AA check (light and dark on home).
- `flows.spec.ts`: quick add lookup (nothing sent before the click), match confirm (Idempotency-Key), streamed chat
  answer (SSE stubbed), upload to the signed URL, publication choices, gateway headers.
- Locally it uses the installed Google Chrome (`PW_CHANNEL=chrome`); CI would need `playwright install chromium`, a
  database and the mocks (the web CI job runs without a database, so E2E is not part of it yet).

Latest local run: 38 passed, 1 skipped (match confirm is skipped when the random mock data has no confirmable match).

## Metrics and performance

- Logs, traces and RED metrics come from `@11e/observability`: per route for web's own endpoints (`onRequestEnd`),
  per downstream for the gateway (`onCall`: status, duration, attempt), relay and drain results, plus the log events
  `ratelimit_fallback`, `audit_details_scrubbed`, `audit_chain_broken`. `/health/ready` reports DB/migration, the
  signing key and each downstream circuit.
- Gateway overhead (LLD §8 target p95 ≤ 30 ms): `node scripts/gateway-overhead.mjs` sends the same GET straight to the
  records mock and through web. Local run (300 samples, `next start`, M-series Mac): direct p95 11.6 ms, through the
  gateway p95 18.2 ms, **overhead p50 1.5 ms / p95 10.0 ms**; own `GET /v1/me` p95 7.0 ms.

## Environment variables

| Name                                | Purpose                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `WEB_DATABASE_URL` / `DATABASE_URL` | Postgres (web_svc, via Supavisor in the cloud)                                 |
| `WEB_POOL_MAX`                      | pool size (default 3; capacity plan)                                           |
| `WEB_CRON_SECRET` / `CRON_SECRET`   | `X-Cron-Secret` for `/internal/v1/{relay,drain,jobs}`                          |
| `WEB_APP_ORIGIN`                    | public origin (CSRF check, OAuth redirects), e.g. https://crm.11estates.in     |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Supabase Auth (sessions)                                                       |
| `SUPABASE_SERVICE_ROLE_KEY`         | Auth admin API (invites, deactivation); web only, secret                       |
| `WEB_KEK`                           | 32-byte base64 key: signing keys at rest, e-mail/credential/IP HMACs; secret   |
| `WEB_TENANT_ID`                     | the tenant (11 Estates) new users belong to                                    |
| `ENVIRONMENT_NAME`                  | local / pilot / dev / staging / production                                     |
| `WEB_PILOT`                         | shows the "sample / anonymised data only" banner (default on for local, pilot) |
| `SVC_<SERVICE>_URL`                 | downstream base URLs for the gateway (default: contract mocks 4011–4016)       |

## Owned data

Schema `web`: `users` (PII: email, display_name), `invitation`, `audit_log` (immutable, partitioned, hash chain),
`notification`, `rate_limit_bucket`, `chat_stream_lease`, `service_client`, `signing_key`, `role`, plus the technical
tables (`outbox`, `processed_events`, `idempotency_keys`, `job_leases`).

## Events

Produces `user.changed.v1` (outbox). Consumes `audit.recorded.v1`, `upload.completed.v1`, `upload.failed.v1`,
`export.completed.v1`, `export.failed.v1` (queue `q_web`, WEB-04).
