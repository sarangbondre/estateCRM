# records

The system of record for what exists and which records are the same (HLD §2 S2): properties, projects, offers,
demands, people and contacts, enquiries, touches, source ads and split children, sightings, second sources, merges
with column-level undo, desk items, photos, market data, the controlled vocabulary releases and the micromarket
hierarchy / launch area.

Service owner: see CODEOWNERS. Design: [docs/04-lld/records.md](../../docs/04-lld/records.md). Contract:
[contracts/openapi/records.yaml](../../contracts/openapi/records.yaml) (69 operations, all implemented). Events:
[contracts/asyncapi/events.yaml](../../contracts/asyncapi/events.yaml).

## Run locally

```bash
pnpm db:start && pnpm db:env > .env.local      # once, from the repo root
pnpm --filter @11e/records test                # applies migrations, then unit + integration + contract tests
pnpm --filter @11e/records dev                 # http://127.0.0.1:3002
pnpm mock intake web                           # intake (rows API) and web (service tokens, JWKS) as contract mocks
```

Migrations are applied by the test harness and by `pnpm --filter @11e/records migrate` with
`MIGRATOR_DATABASE_URL` set to the `records_migrator` URL (`RECORDS_MIGRATOR_DATABASE_URL` in `.env.local`).
A tenant's reference data (vocabulary v0.6, the MMR hierarchy, launch-area cities) is bootstrapped by the
`activate-vocabulary` job for `TENANT_IDS` and lazily on the tenant's first reference read.

## Layout

| Layer              | What                                                                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/domain`       | Pure rules: codes, labels (generated, never stored), record axis, dedup scoring (§4.4/§4.5), routing and offer splitting, merge/undo plan, launch area, phones and masks, scan-term tokens |
| `src/application`  | Use cases on ports (`ports.ts`, `queries.ts`): supply, demands, people, quick add, ingestion, merges, add supply, price sheets, privacy, photos, reactions, desks, reference, maintenance |
| `src/adapters`     | Kysely store/queries/unit of work + outbox, HTTP routes and presenters, event handlers, work queue, jobs, intake client, Supabase Storage, HMAC hashes                                      |
| `src/main.ts`      | Composition root                                                                                                                                                                             |

## Environment

| Variable                                | Local default                             | Notes                                                                              |
| --------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------- |
| `DATABASE_URL`                          | `RECORDS_DATABASE_URL` from `pnpm db:env` | pooler URL with the `records_svc` role                                             |
| `CRON_SECRET`                           | `RECORDS_CRON_SECRET`                     | must equal Vault `cron_secret_records`                                             |
| `WEB_URL` / `JWKS_URL`                  | http://127.0.0.1:3000                     | service tokens (R-2): JWKS for inbound, token minting for the intake call         |
| `SERVICE_CREDENTIAL`                    | —                                         | records' credential at web `POST /internal/v1/service-tokens` (ingestion needs it) |
| `INTAKE_URL`                            | http://127.0.0.1:3001                     | intake internal rows / migration-map API                                           |
| `CONTACT_HASH_SECRET`                   | local throwaway (local/test only)         | secret for phone/email/building HMACs (per-tenant keys derived from it)            |
| `SCAN_SALT` / `SCAN_SALT_VERSION`       | local throwaway / 1                       | salt shared with listings for scan terms (R-20)                                    |
| `STORAGE_URL` / `STORAGE_SERVICE_KEY`   | —                                         | Supabase Storage; without them the photo endpoints answer 503                      |
| `PHOTO_BUCKET`                          | records-photos                            | private bucket (to be provisioned)                                                 |
| `TENANT_IDS`                            | —                                         | comma list of tenants whose jobs run (tenants with data are added automatically)  |
| `POOL_MAX`                              | 3                                         | capacity plan (6 pilot / 16 paid for the role)                                     |
| `PORT`                                  | 3002                                      | local only                                                                         |
| `ENVIRONMENT_NAME`                      | local                                     | secrets are required outside local/test                                            |

## Owned data

Schema `records` (owner `records_owner`, runtime role `records_svc`), migrations `0001`–`0005`: every table of LLD §3
plus `reveal_log` (reveal audit ids and the 60/hour limit) and `note_imports` (CR-012: one `record.note_imported.v1`
per upload row with `crm_notes`, ids only; the note text stays in intake). Personal data (marked `-- PII`): person names, phones,
e-mails, other contact; unit, wing and exact floor; source-ad raw text, variants and sender; enquiry messages;
unrouted row snapshots. Uploaded `building_name` (private: staff APIs and proposals) and `floor` (parsed into
`floor_no`/`total_floors`) are stored on the property and drive the "same property" dedup branch (CR-012). It is never
logged, never in events (events carry `contactPersonIds` and an opaque
`buildingKey`), masked on read and only returned by `POST /v1/reveals` (audited) and the insight contacts batch.
Retention: `retention-purge` erases it 24 months after the last activity (NFR-18).

## Queues and events

- Event queue `q_records` consumes `rows.classified.v1`, `review_item.resolved.v1`, `offer.confirmed.v1`,
  `site_visit.completed.v1`, `call.logged.v1`, `demand.exited.v1`, `demand.reactivated.v1`, `deal.closed.v1`,
  `deal.cancelled.v1`, `offer.retired.v1`, `lease_renewal.due.v1`, `publication.changed.v1`.
- Work queue `q_records_photo_fetch`: sheet-link photos.
- Publishes (transactional outbox, UUIDv7 event ids, `aggregateVersion` = row version per event): `offer.created`,
  `offer.updated`, `offer.price_changed`, `offer.record_stage_changed`, `offer.voided`, `demand.created`,
  `demand.updated`, `demand.touch_added`, `demand.voided`, `enquiry.received`, `records.merged`,
  `records.merge_undone`, `merge_candidate.raised`, `person.flagged`, `person.flag_removed`, `project.created`,
  `project.updated`, `price_sheet.applied`, `photo.added`, `photo.removed`, `desk_item.created`, `desk_item.updated`,
  `watchlist_item.created`, `market_data.recorded` (every kind, `lost_competing` included), `record.note_imported`,
  `micromarkets.updated`, `vocabulary.released`, `audit.recorded`
  (all `.v1`) to `q_crm_engine`, `q_insight`, `q_intake`, `q_journeys`, `q_listings`, `q_web`.
- Scheduled jobs: `activate-vocabulary`, `recompute-launch-area` (on demand; a queued recompute is also advanced after
  each `q_records` drain), `resolve-pending-repeats`, `retention-purge`, `expire-idempotency-keys`,
  `reconcile-counters` (see infra/schedules.yaml).

## Observability

Structured logs, traces and RED metrics through `@11e/observability` (`observe('records')`), `/health/live` and
`/health/ready` (DB reachable and migrations at `EXPECTED_MIGRATION`).
