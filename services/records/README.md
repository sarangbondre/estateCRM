# records

Service owner: see CODEOWNERS. Design: [docs/04-lld/records.md](../../docs/04-lld/records.md). Contract:
[contracts/openapi/records.yaml](../../contracts/openapi/records.yaml).

## Run locally

```bash
pnpm db:start && pnpm db:env > .env.local     # once, from the repo root
pnpm --filter @11e/records migrate
pnpm --filter @11e/records dev                 # http://127.0.0.1:3002
pnpm mock                                     # other services as contract mocks (ports 4010–4016)
```

## Environment

| Variable               | Local default                             | Notes                                      |
| ---------------------- | ----------------------------------------- | ------------------------------------------ |
| `DATABASE_URL`         | `RECORDS_DATABASE_URL` from `pnpm db:env` | pooler URL with the `records_svc` role     |
| `CRON_SECRET`          | `RECORDS_CRON_SECRET`                     | must equal Vault `cron_secret_records`     |
| `WEB_URL` / `JWKS_URL` | http://127.0.0.1:3000                     | service tokens (R-2)                       |
| `SERVICE_CREDENTIAL`   | —                                         | only if this service calls another service |
| `POOL_MAX`             | 3                                         | capacity plan                              |
| `PORT`                 | 3002                                      | local only                                 |

## Owned data

Schema `records` (owner `records_owner`, runtime role `records_svc`). Technical tables: `idempotency_keys`,
`outbox`, `processed_events`, `job_leases`.

## Queues and events

- Event queue: `q_records`. Work queues: `q_records_photo_fetch`.
- Publishes to: `q_crm_engine`, `q_insight`, `q_intake`, `q_journeys`, `q_listings`, `q_web`.
- Scheduled jobs: `activate-vocabulary`, `recompute-launch-area`, `resolve-pending-repeats`, `retention-purge`, `expire-idempotency-keys`, `reconcile-counters` (see infra/schedules.yaml).
