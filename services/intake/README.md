# intake

Service owner: see CODEOWNERS. Design: [docs/04-lld/intake.md](../../docs/04-lld/intake.md). Contract:
[contracts/openapi/intake.yaml](../../contracts/openapi/intake.yaml).

## Run locally

```bash
pnpm db:start && pnpm db:env > .env.local     # once, from the repo root
pnpm --filter @11e/intake migrate
pnpm --filter @11e/intake dev                 # http://127.0.0.1:3001
pnpm mock                                     # other services as contract mocks (ports 4010–4016)
```

## Environment

| Variable               | Local default                            | Notes                                      |
| ---------------------- | ---------------------------------------- | ------------------------------------------ |
| `DATABASE_URL`         | `INTAKE_DATABASE_URL` from `pnpm db:env` | pooler URL with the `intake_svc` role      |
| `CRON_SECRET`          | `INTAKE_CRON_SECRET`                     | must equal Vault `cron_secret_intake`      |
| `WEB_URL` / `JWKS_URL` | http://127.0.0.1:3000                    | service tokens (R-2)                       |
| `SERVICE_CREDENTIAL`   | —                                        | only if this service calls another service |
| `POOL_MAX`             | 3                                        | capacity plan                              |
| `PORT`                 | 3001                                     | local only                                 |

## Owned data

Schema `intake` (owner `intake_owner`, runtime role `intake_svc`). Technical tables: `idempotency_keys`,
`outbox`, `processed_events`, `job_leases`.

## Queues and events

- Event queue: `q_intake`. Work queues: `q_intake_chunks`, `q_intake_finalize`, `q_intake_inspect`, `q_intake_split`.
- Publishes to: `q_insight`, `q_records`, `q_web`.
- Scheduled jobs: `retention-purge`, `expire-idempotency-keys`, `reap-chunk-leases`, `delete-processed-files` (see infra/schedules.yaml).
