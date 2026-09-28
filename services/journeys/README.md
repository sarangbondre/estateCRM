# journeys

Work management for 11estates CRM (HLD S3): My queue and call ranking, the life curve of every live offer and
demand, the Commercial axis and demand exits, sourcing requests, proposals (snapshot, PDF, share link), site visits,
deals, lease renewals, work notifications and Watchlist tasks.

Service owner: see CODEOWNERS. Design: [docs/04-lld/journeys.md](../../docs/04-lld/journeys.md). Contract:
[contracts/openapi/journeys.yaml](../../contracts/openapi/journeys.yaml) (60 operations, all implemented). Events:
[contracts/asyncapi/events.yaml](../../contracts/asyncapi/events.yaml).

## Run locally

```bash
pnpm db:start && pnpm db:env > .env.local     # once, from the repo root
pnpm --filter @11e/journeys migrate            # needs MIGRATOR_DATABASE_URL (= JOURNEYS_MIGRATOR_DATABASE_URL)
pnpm --filter @11e/journeys dev                # http://127.0.0.1:3003
pnpm mock records listings                     # records (4012) and listings (4015) contract mocks for proposals
pnpm --filter @11e/journeys test               # unit + integration + contract tests on the local database
```

Tests apply the migrations once (vitest globalSetup), use a fresh tenant per file, a controllable clock and fake
records/listings/storage/PDF ports, deliver events straight to the application handlers (no dependency on the shared
queues) and validate every response against the contract and every produced event against AsyncAPI. The `test`
script also fails when any contract operation was not exercised with both a success and an error status.

Performance (opt-in): `PERF_SUBJECTS=1000000 pnpm --filter @11e/journeys exec vitest run tests/perf`
(`PERF_LEAN=1` for 5M on a laptop; `PERF_DUE_SHARE` = share of curves due today, default 0.03).

## Environment

| Variable | Local default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `JOURNEYS_DATABASE_URL` from `pnpm db:env` | pooler URL with the `journeys_svc` role |
| `CRON_SECRET` | `JOURNEYS_CRON_SECRET` | must equal Vault `cron_secret_journeys` |
| `WEB_URL` / `JWKS_URL` | http://127.0.0.1:3000 | service tokens (R-2) |
| `SERVICE_CREDENTIAL` | — | web `POST /internal/v1/service-tokens` credential (records and listings reads) |
| `RECORDS_URL` | http://127.0.0.1:4012 | proposal snapshot: `GET /v1/offers/{id}`, `/v1/properties/{id}[/photos]` |
| `LISTINGS_URL` | http://127.0.0.1:4015 | `GET /v1/publication-settings` (MahaRERA number; "registration pending" when absent) |
| `PUBLIC_BASE_URL` | `WEB_URL` | share links are `${PUBLIC_BASE_URL}/p/{token}` (web's public route) |
| `IP_HASH_SALT` | local-only value | required outside local/test; link-open IP hashes (month mixed in) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | — | Storage REST (private bucket `STORAGE_BUCKET`, default `journeys-proposals`) |
| `LOCAL_STORAGE_DIR` | `$TMPDIR/journeys-proposals` | local development without Supabase Storage (file:// URLs) |
| `POOL_MAX` | 3 | capacity plan |
| `PORT` | 3003 | local only |

## Owned data

Schema `journeys` (owner `journeys_owner`, runtime role `journeys_svc`), migrations `0001`–`0005`:

- Projections built from events: `offer_view`, `demand_view`, `match_view` + `match_offers`, `person_state`,
  `subject_contacts`, `staff_users` (versions per kind of data; stale events ignored).
- Work state: `life_curve`, `offer_journey`, `demand_journey`, `queue_items` + `queue_counters`, `capacities`, `calls`,
  `demand_gap`, `source_quality`, `sourcing_requests`, `proposals` (+ options, links, opens), `site_visits`, `deals` +
  `deal_events`, `lease_renewals`, `notifications`, `watchlist_tasks`, `settings`.
- Technical: `outbox`, `processed_events`, `idempotency_keys`, `job_leases`, `job_runs`, `aggregate_versions`
  (strictly increasing `aggregateVersion` per produced aggregate), `merge_log`, `code_sequences`.

PII (never logged, never in events): `calls.notes`, free-text notes and reasons on SRQs, proposals, options, visits,
deals, exits, qualification and Watchlist outcomes; `staff_users.display_name`. `retention-purge` nulls free text after
24 months, deletes notifications and link opens after 90 days and proposal snapshots/PDFs after 24 months.

## Queues and events

- Event queue `q_journeys`: consumes the 25 events routed to it (records offer/demand facts, merges, people flags,
  Watchlist items, enquiries, price sheets; crm-engine matches and matching runs; listings publication; web users).
- Work queue `q_journeys_work`: proposal snapshots and PDFs (off the request path, 3 attempts → Failed).
- Publishes (transactional outbox): `offer.confirmed`, `demand.confirmed`, `lifecycle.stage_changed`,
  `offer.commercial_status_changed`, `offer.retired`, `demand.qualified`, `demand.status_changed`, `demand.exited`,
  `demand.reactivated`, `demand.sourcing_started`, `sourcing_request.created|updated`, `proposal.sent`,
  `proposal.feedback_recorded`, `site_visit.scheduled|completed`, `deal.opened|updated|closed|cancelled`,
  `lease_renewal.due`, `call.logged`, `watchlist_task.completed`, `queue.counts_changed`, `audit.recorded` (all `.v1`).
- Scheduled jobs (infra/schedules.yaml): `life-curve-nightly` (only rows with `next_change_on ≤ today`; applies new
  thresholds), `demand-gap-refresh`, `rank-refresh`, `lease-renewal-scan`, `dormant-revisit`, `follow-up-reminders`,
  `queue-counts-flush` (≤ 1 `queue.counts_changed.v1` per user per minute), `retention-purge`.

## Observability

Structured logs, traces and RED metrics per route and per consumer come from `libs/observability` (`observe()`),
including relay lag and drain results; job results are recorded in `job_runs`. No PII in logs (allow-list).

## Measured performance (local laptop, Supabase Postgres 17 in Docker)

| Target | Result |
| --- | --- |
| My queue p95 ≤ 1 s (NFR-8) | 5M subjects, agent with 200,000 open items: summary p95 15 ms, section pages p95 2–3 ms (1M / 40k items: p95 ≤ 3 ms); in-process, planner statistics from ANALYZE |
| Life-curve nightly on 5M subjects < 2 h | 5M subjects (lean seed: projections, journeys and curves for all 5M, queue items for the measured agent), 3% due today = 150,000 rows processed in 218 s (688 rows/s, stage actions and events included) ≈ 4 min |
