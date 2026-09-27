# listings

Service owner: see CODEOWNERS. Design: [docs/04-lld/listings.md](../../docs/04-lld/listings.md). Contract:
[contracts/openapi/listings.yaml](../../contracts/openapi/listings.yaml).

## Run locally

```bash
pnpm db:start && pnpm db:env > .env.local     # once, from the repo root
pnpm --filter @11e/listings migrate
pnpm --filter @11e/listings dev                 # http://127.0.0.1:3005
pnpm mock                                     # other services as contract mocks (ports 4010–4016)
```

## Environment

| Variable               | Local default                              | Notes                                      |
| ---------------------- | ------------------------------------------ | ------------------------------------------ |
| `DATABASE_URL`         | `LISTINGS_DATABASE_URL` from `pnpm db:env` | pooler URL with the `listings_svc` role    |
| `CRON_SECRET`          | `LISTINGS_CRON_SECRET`                     | must equal Vault `cron_secret_listings`    |
| `WEB_URL` / `JWKS_URL` | http://127.0.0.1:3000                      | service tokens (R-2)                       |
| `SERVICE_CREDENTIAL`   | —                                          | only if this service calls another service |
| `POOL_MAX`             | 3                                          | capacity plan                              |
| `PORT`                 | 3005                                       | local only                                 |

## Owned data

Schema `listings` (owner `listings_owner`, runtime role `listings_svc`). Technical tables: `idempotency_keys`,
`outbox`, `processed_events`, `job_leases`.

## Queues and events

- Event queue: `q_listings`. Work queues: `q_listings_photos`.
- Publishes to: `q_insight`, `q_journeys`, `q_records`, `q_web`.
- Scheduled jobs: `ceiling-sweep`, `projection-refresh`, `change-feed-prune`, `idempotency-prune`, `rate-limit-prune`, `api-key-expire` (see infra/schedules.yaml).
