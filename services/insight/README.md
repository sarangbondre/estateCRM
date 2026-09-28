# insight

Chat, dashboards and exports over a **PII-free, event-fed read model** (S6). Service owner: see CODEOWNERS.
Design: [docs/04-lld/insight.md](../../docs/04-lld/insight.md). Contract:
[contracts/openapi/insight.yaml](../../contracts/openapi/insight.yaml) (20 operations, all implemented).

"The model plans, the service executes" (ADR-0004): a question is redacted, a Hugging Face model picks a plan from
the catalogue (never data, never SQL), insight validates it and runs it on the read model, and the answer is composed
from the query results by templates — with "How I got this". No personal data is stored or sent to the model.

## Run locally

```bash
pnpm db:start && pnpm db:env > .env.local     # once, from the repo root
MIGRATOR_DATABASE_URL=… pnpm --filter @11e/insight migrate   # or INSIGHT_MIGRATOR_DATABASE_URL from .env.local
pnpm --filter @11e/insight dev                 # http://127.0.0.1:3006
pnpm mock                                     # other services as contract mocks (ports 4010–4016)
pnpm --filter @11e/insight test                # unit + integration + contract coverage (needs the local stack)
pnpm --filter @11e/insight benchmark           # M7 chat benchmark (PRD Appendix A)
```

Without `HF_TOKEN` the chat answers through the keyword parser (every answer then carries the
`model_unavailable_keyword_fallback` notice). Without a service credential, vocabulary-refresh keeps the built-in
release (libs/vocabulary v0.6) and contact exports fail with `dependency-unavailable`. Without Supabase Storage
variables, export files go to a local directory and "signed URLs" are `file://` URLs.

## Environment

| Variable                                     | Local default                             | Notes                                                                     |
| -------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------- |
| `DATABASE_URL`                               | `INSIGHT_DATABASE_URL` from `pnpm db:env` | pooler URL with the `insight_svc` role                                    |
| `CRON_SECRET`                                | `INSIGHT_CRON_SECRET`                     | must equal Vault `cron_secret_insight`                                    |
| `WEB_URL` / `JWKS_URL`                       | http://127.0.0.1:3000                     | staff tokens and service tokens (R-2)                                     |
| `SERVICE_CREDENTIAL`                         | —                                         | web service-token credential (records vocabulary, micromarkets, contacts) |
| `RECORDS_URL`                                | http://127.0.0.1:3002                     | records base URL                                                          |
| `HF_TOKEN` / `HF_MODEL` / `HF_BASE_URL`      | — / `Qwen/Qwen2.5-7B-Instruct` / router   | Hugging Face planner (LLD §4.2); secrets in the Vercel encrypted env      |
| `HF_CONCURRENCY`                             | 5                                         | model calls per instance (pilot 5, paid 20)                               |
| `EXPORT_MAX_ROWS`                            | 20000                                     | 20,000 pilot, 100,000 production (R-16)                                   |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | —                                         | private bucket for export files                                           |
| `EXPORT_BUCKET` / `LOCAL_EXPORT_DIR`         | `insight-exports` / OS temp dir           |                                                                           |
| `POOL_MAX`                                   | 3                                         | capacity plan                                                             |
| `PORT`                                       | 3006                                      | local only                                                                |

## Owned data (schema `insight`, runtime role `insight_svc`)

- **Read model** (no contact PII; staff by user id, people by pseudonymous id): `rm_offer`, `rm_demand`, `rm_touch`,
  `rm_enquiry`, `rm_match`, `rm_deal`, `rm_market_price`, `rm_sourcing_request`, `rm_proposal`, `rm_site_visit`,
  `rm_call`, `rm_project`, `rm_queue_counts`, `rm_user`, `rm_upload`, `rm_review_item`, `rm_merge_candidate`,
  `rm_row_stat`, `rm_desk_item`, `rm_watchlist_item`, `rm_person_flag`, `rm_version` (per-stream aggregate versions).
- **Rollups**: `rm_offer_rollup`, `rm_demand_rollup` (incremental in the projector transaction, rebuilt nightly),
  `rm_daily_fact`, `rm_state` ("data as of", nightly property count).
- **Chat**: `conversation`, `message` — redacted text only (`PII-possible`, never logged), cards stored with
  placeholders; 180-day retention; private to the author.
- **Catalogue**: `domain/plans/catalogue.ts` (19 templates, v1); `plan_template` holds tenant switches.
- **Exports**: `export_job` (plan and counts only; 1 year). Files: private bucket, 24 h, 10-minute signed URLs.
- **Reference**: `vocabulary_release`, `micromarket_ref`, `hf_usage`, `job_checkpoint`, `code_sequence`.
- Technical: `idempotency_keys`, `outbox`, `processed_events`, `job_leases`.

## Queues and events

- Event queue `q_insight`: consumes the **64** events routed to insight (event-topology.json) into the read model.
  Dedupe on `eventId`; per-stream version checks; stubs for out-of-order delivery.
- Work queue `q_insight_exports`: one export job per message (3 attempts).
- Publishes (outbox → `q_web`): `export.completed.v1`, `export.failed.v1`, `audit.recorded.v1` (`export.created`).
- Scheduled jobs: `export-expire`, `conversation-purge`, `rollup-reconcile`, `vocabulary-refresh`,
  `idempotency-prune`, `hf-credit-reset` (infra/schedules.yaml).

## Observability

Structured logs with the correlation ID (allow-listed fields only; questions, prompts, model output and plan values
are never logged), OpenTelemetry traces, RED metrics per endpoint, per consumer/work queue and per downstream
(`records`, `huggingface`). `/health/ready` reports `checks.db` and `checks.model = ok | degraded` (fallback active).

## Measured (local stack)

- M7 benchmark (13 Appendix A questions): 13/13 with recorded model replies, 13/13 with the keyword fallback.
- Dashboards on 5M-sized rollups (50k tuples each, a year of daily facts): p95 ≈ 5–100 ms (target 2 s).
- `POST /v1/queries` on 100k offers / 50k demands: p95 ≤ 25 ms (target 300 ms).
