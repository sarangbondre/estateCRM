# listings

Publishing and the Listings API (S5). It decides what the market may see and serves it to the 11 Estates website and
project microsites. Service owner: see CODEOWNERS. Design: [docs/04-lld/listings.md](../../docs/04-lld/listings.md).
Contract: [contracts/openapi/listings.yaml](../../contracts/openapi/listings.yaml) (25 operations, all implemented).

## Run locally

```bash
pnpm db:start && pnpm db:env > .env.local     # once, from the repo root
pnpm --filter @11e/listings migrate
pnpm --filter @11e/listings dev                 # http://127.0.0.1:3005
pnpm mock records                               # records contract mock on :4012 (scan terms, micromarkets, photo URLs)
pnpm --filter @11e/listings test                # unit, integration, contract, M8 scan and perf (local DB)
```

Other services are never called on a user request. records is read from the work queue only: scan terms (R-20),
the micromarket hierarchy (R-13) and signed photo URLs (L-2), each with a web-issued service token (R-2).

## Environment

| Variable                              | Local default                              | Notes                                                             |
| ------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------- |
| `DATABASE_URL`                        | `LISTINGS_DATABASE_URL` from `pnpm db:env` | pooler URL with the `listings_svc` role                           |
| `CRON_SECRET`                         | `LISTINGS_CRON_SECRET`                     | must equal Vault `cron_secret_listings`                           |
| `WEB_URL` / `JWKS_URL`                | http://127.0.0.1:3000                      | service tokens (R-2)                                              |
| `SERVICE_CREDENTIAL`                  | —                                          | enables the records reads (unset: the work items are skipped)     |
| `RECORDS_URL`                         | http://127.0.0.1:4012                      | records (contract mock locally)                                   |
| `SCAN_SALT`                           | `local-scan-salt` (local/test only)        | secret shared with records for scan-term hashes (R-20)            |
| `STORAGE_URL` / `STORAGE_SERVICE_KEY` | —                                          | Supabase Storage; unset: photos stay `pending`                    |
| `PRIVATE_BUCKET` / `PUBLIC_BUCKET`    | `listings-photos` / `listings-public`      | buckets (created by infra)                                        |
| `ENVIRONMENT_NAME`                    | `local`                                    | `production` makes the MahaRERA agent number mandatory (BRD §4.6) |
| `FEED_SETTLE_MS`                      | 5000                                       | change-feed rows younger than this are held back (late commits)   |
| `API_KEY_CACHE_TTL_MS`                | 30000                                      | positive API-key cache per instance (revocation delay)            |
| `POOL_MAX`                            | 3                                          | capacity plan                                                     |
| `PORT`                                | 3005                                       | local only                                                        |

## Owned data (schema `listings`, runtime role `listings_svc`)

- Inputs projected from events: `offer_input`, `project_input`, `demand_input`.
- Publication state: `publication` (level, ceiling, reasons, public id, staff description marked PII-possible).
- Scan data: `privacy_scan` (findings are kinds and offsets only) and `private_term` (salted hashes from records, never plain names).
- Public output: `public_item` (the only table the public API reads) and `change_feed` (kept 30 days).
- Photos: `photo`.
- Website access and settings: `settings` (MahaRERA agent number), `api_key` (hash only), `rate_limit_bucket`.
- Plumbing: `merge_log`, `vocabulary_release` (plus the micromarket hierarchy), `job_checkpoint`, and the technical tables `outbox`, `processed_events`, `idempotency_keys`, `job_leases`.

No contact PII is stored. PII is never logged; the logger's allow-list drops it.

## Queues and events

- Consumes 26 events on `q_listings` (`src/application/ingest.ts`; a test keeps the list equal to `event-topology.json`).
  - records: `offer.*`, `demand.*`, `project.*`, `photo.*`, `records.merged` / `merge_undone`, `vocabulary.released`, `micromarkets.updated`.
  - journeys: lifecycle, commercial status, deals, retire, demand status / exit / sourcing.
  - crm-engine: `match.confirmed`.
- Publishes `publication.changed.v1` (to records, journeys and insight) and `audit.recorded.v1` (to web), through the outbox.
- Work queue `q_listings_photos`: photo renditions, public copies, scan-term refresh, micromarket refresh, projection-refresh batches.
- Jobs (`infra/schedules.yaml`):
  - `ceiling-sweep`: 04:30 IST, plus the nightly M8 output audit.
  - `projection-refresh`: on demand.
  - `change-feed-prune`: also prunes scans after 90 days.
  - `idempotency-prune`: also processed events and the published outbox.
  - `rate-limit-prune`.
  - `api-key-expire`.

## Rules in code

- **Ceiling** (`src/domain/ceiling.ts`, LLD §4.1). Auto-downgrade runs in the consumer transaction and never auto-raises; merge undo restores the prior level, capped at the ceiling.
- **Privacy scan** (`src/domain/privacy.ts`, rules `ps-1`). It blocks:
  - phones, including number words, Hinglish and look-alike characters;
  - emails, URLs and social handles;
  - wing/unit, exact floor and street/plot references;
  - building, wing and unit terms matched by salted hash across the whole tenant.

  Photo text is only a warning (R-8).

- **Projection** (`src/domain/projection.ts`). Explicit key allow-lists per PRD §8.3, with labels generated by `@11e/vocabulary`. In the pilot, a missing agent number shows "MahaRERA registration pending" (questionnaire A7). In production it is mandatory.
- **Public API**:
  - filters on stored values;
  - cursors are bound to the query, max 50 per page;
  - `Cache-Control: public, s-maxage=20, stale-while-revalidate=10` and `Vary: X-Api-Key` (the change feed uses `s-maxage=5`);
  - per-key Postgres token bucket with 10-token leases (R-1).

## Quality gates

- **Contract tests:** every operation is exercised for success and one error path, with response validation (`tests/contract`).
- **M8 = 0 test:** `tests/m8/pii-scan.test.ts`, over synthetic ads from `@11e/testing`. Each ad's raw text, contacts included, is offered as a Public description. Then the whole API output is crawled and checked for phones, e-mails, names, building names, the §4.4 patterns and non-allow-listed keys.
- **Perf:** `tests/perf` measures the miss path over 5,000 items. Local p95 is about 3 ms for lists and 1 ms for detail, against targets of ≤ 60 ms DB and ≤ 120 ms function.
