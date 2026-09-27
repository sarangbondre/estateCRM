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
