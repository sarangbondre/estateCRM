# crm-engine

Service owner: see CODEOWNERS. Design: [docs/04-lld/crm-engine.md](../../docs/04-lld/crm-engine.md). Contract:
[contracts/openapi/crm-engine.yaml](../../contracts/openapi/crm-engine.yaml).

## Run locally

```bash
pnpm db:start && pnpm db:env > .env.local     # once, from the repo root
pnpm --filter @11e/crm-engine migrate
pnpm --filter @11e/crm-engine dev                 # http://127.0.0.1:3004
pnpm mock                                     # other services as contract mocks (ports 4010–4016)
```

## Environment

| Variable               | Local default                                | Notes                                      |
| ---------------------- | -------------------------------------------- | ------------------------------------------ |
| `DATABASE_URL`         | `CRM_ENGINE_DATABASE_URL` from `pnpm db:env` | pooler URL with the `crm_engine_svc` role  |
| `CRON_SECRET`          | `CRM_ENGINE_CRON_SECRET`                     | must equal Vault `cron_secret_crm_engine`  |
| `WEB_URL` / `JWKS_URL` | http://127.0.0.1:3000                        | service tokens (R-2)                       |
| `SERVICE_CREDENTIAL`   | —                                            | only if this service calls another service |
| `POOL_MAX`             | 3                                            | capacity plan                              |
| `PORT`                 | 3004                                         | local only                                 |

## Owned data

Schema `crm_engine` (owner `crm_engine_owner`, runtime role `crm_engine_svc`). Technical tables: `idempotency_keys`,
`outbox`, `processed_events`, `job_leases`.

## Queues and events

- Event queue: `q_crm_engine`. Work queues: `q_crm_engine_rescore`.
- Publishes to: `q_insight`, `q_journeys`, `q_listings`, `q_web`.
- Scheduled jobs: `full-rescore`, `micromarket-refresh`, `projection-reconcile` (see infra/schedules.yaml).
