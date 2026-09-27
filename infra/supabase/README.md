# Local database stack (F-06)

This is the Supabase CLI stack for local development: Postgres 17, Auth, Storage, Studio and Mailpit. Realtime, edge
functions, analytics and the Data API schemas are off (data-hosting §2).

```bash
pnpm db:start     # start the stack, apply migrations, set local role passwords, print connection env
pnpm db:env       # print <SCHEMA>_DATABASE_URL / <SCHEMA>_MIGRATOR_DATABASE_URL for every service
pnpm db:verify    # 61 checks: extensions, schemas, queues, isolation, queue-wrapper and migrator permissions
pnpm db:reset     # re-create the database from migrations (idempotent: roles survive, the bootstrap re-runs)
pnpm db:stop
pnpm dev          # db:start + every service's dev task
```

## What the bootstrap creates

`migrations/20260927000000_platform_bootstrap.sql` is **generated** by `tools/gen-db-bootstrap.mjs` from
`contracts/asyncapi/events.yaml` (`pnpm contracts:gen`, drift-checked in CI). Don't edit it by hand.

| Object          | Detail                                                                                                                                                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extensions      | `pgmq`, `pg_cron`, `pg_net` (in `extensions`)                                                                                                                                                                                                                    |
| Per service     | schema `<svc>` owned by `<svc>_owner` (NOLOGIN) · `<svc>_migrator` (LOGIN, runs as owner) · `<svc>_svc` (LOGIN, DML only, pilot connection cap from data-hosting §5)                                                                                             |
| Queues          | `q_<consumer>` + `q_<consumer>_dlq` for each of the 7 consumers                                                                                                                                                                                                  |
| Queue wrappers  | `<svc>.queue_send(queue, msg, delay)` only to the consumers of events that `<svc>` produces · `queue_read`, `queue_archive`, `queue_delete`, `queue_dead_letter`, `queue_depths` on its own queue. SECURITY DEFINER. Service roles have no direct `pgmq` access. |
| `relay_invoker` | NOLOGIN, `EXECUTE net.http_post` only (pg_cron jobs, F-15)                                                                                                                                                                                                       |
| Hardening       | `anon`/`authenticated` have no rights on service schemas. No `CREATE` on `public`.                                                                                                                                                                               |

Service tables are **not** created here. Each service's own migrations (`services/<svc>/migrations`) create them,
run by its migrator (F-08).

## Local-only credentials

Local role passwords are deterministic (`local_<role>`) and set by `infra/scripts/local-roles.mjs`. The migration never
sets a password. Pilot and production passwords are set in the provisioning session (docs/runbooks/provisioning.md)
and stored only in each Vercel project's encrypted env.

The local pooler (Supavisor) is off, and services connect to port 54322 directly. The DB client disables prepared
statements in every environment, so behaviour matches the pilot's transaction-mode pooler.

`verify-platform.mjs` is reused on the pilot in F-07, with `ADMIN_DATABASE_URL` and `VERIFY_ROLE_URL_<SCHEMA>` /
`VERIFY_MIGRATOR_URL_<SCHEMA>` set in the shell (never committed).
