# journeys

Service owner: see CODEOWNERS. Design: [docs/04-lld/journeys.md](../../docs/04-lld/journeys.md). Contract:
[contracts/openapi/journeys.yaml](../../contracts/openapi/journeys.yaml).

## Run locally

```bash
pnpm db:start && pnpm db:env > .env.local     # once, from the repo root
pnpm --filter @11e/journeys migrate
pnpm --filter @11e/journeys dev                 # http://127.0.0.1:3003
pnpm mock                                     # other services as contract mocks (ports 4010–4016)
```

## Environment

| Variable               | Local default                              | Notes                                      |
| ---------------------- | ------------------------------------------ | ------------------------------------------ |
| `DATABASE_URL`         | `JOURNEYS_DATABASE_URL` from `pnpm db:env` | pooler URL with the `journeys_svc` role    |
| `CRON_SECRET`          | `JOURNEYS_CRON_SECRET`                     | must equal Vault `cron_secret_journeys`    |
| `WEB_URL` / `JWKS_URL` | http://127.0.0.1:3000                      | service tokens (R-2)                       |
| `SERVICE_CREDENTIAL`   | —                                          | only if this service calls another service |
| `POOL_MAX`             | 3                                          | capacity plan                              |
| `PORT`                 | 3003                                       | local only                                 |

## Owned data

Schema `journeys` (owner `journeys_owner`, runtime role `journeys_svc`). Technical tables: `idempotency_keys`,
`outbox`, `processed_events`, `job_leases`.

## Queues and events

- Event queue: `q_journeys`. Work queues: `q_journeys_work`.
- Publishes to: `q_crm_engine`, `q_insight`, `q_listings`, `q_records`, `q_web`.
- Scheduled jobs: `life-curve-nightly`, `demand-gap-refresh`, `rank-refresh`, `lease-renewal-scan`, `dormant-revisit`, `follow-up-reminders`, `queue-counts-flush`, `retention-purge` (see infra/schedules.yaml).
