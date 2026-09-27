# insight

Service owner: see CODEOWNERS. Design: [docs/04-lld/insight.md](../../docs/04-lld/insight.md). Contract:
[contracts/openapi/insight.yaml](../../contracts/openapi/insight.yaml).

## Run locally

```bash
pnpm db:start && pnpm db:env > .env.local     # once, from the repo root
pnpm --filter @11e/insight migrate
pnpm --filter @11e/insight dev                 # http://127.0.0.1:3006
pnpm mock                                     # other services as contract mocks (ports 4010–4016)
```

## Environment

| Variable               | Local default                             | Notes                                      |
| ---------------------- | ----------------------------------------- | ------------------------------------------ |
| `DATABASE_URL`         | `INSIGHT_DATABASE_URL` from `pnpm db:env` | pooler URL with the `insight_svc` role     |
| `CRON_SECRET`          | `INSIGHT_CRON_SECRET`                     | must equal Vault `cron_secret_insight`     |
| `WEB_URL` / `JWKS_URL` | http://127.0.0.1:3000                     | service tokens (R-2)                       |
| `SERVICE_CREDENTIAL`   | —                                         | only if this service calls another service |
| `POOL_MAX`             | 3                                         | capacity plan                              |
| `PORT`                 | 3006                                      | local only                                 |

## Owned data

Schema `insight` (owner `insight_owner`, runtime role `insight_svc`). Technical tables: `idempotency_keys`,
`outbox`, `processed_events`, `job_leases`.

## Queues and events

- Event queue: `q_insight`. Work queues: `q_insight_exports`.
- Publishes to: `q_web`.
- Scheduled jobs: `export-expire`, `conversation-purge`, `rollup-reconcile`, `vocabulary-refresh`, `idempotency-prune`, `hf-credit-reset` (see infra/schedules.yaml).
