# crm-engine

The matching brain (service S4, HLD §2): it pairs demand with supply many-to-many, ranks the pairs, builds bundles,
records date-aware exclusions, raises flags and captures feedback for weight tuning. Matches are suggestions; nobody
is contacted automatically (BRD A-5).

Service owner: see CODEOWNERS. Design: [docs/04-lld/crm-engine.md](../../docs/04-lld/crm-engine.md). Contract:
[contracts/openapi/crm-engine.yaml](../../contracts/openapi/crm-engine.yaml) (19 operations). Events:
[contracts/asyncapi/events.yaml](../../contracts/asyncapi/events.yaml).

## Run locally

```bash
pnpm db:start && pnpm db:env > .env.local     # once, from the repo root
pnpm --filter @11e/crm-engine migrate
pnpm --filter @11e/crm-engine dev             # http://127.0.0.1:3004
pnpm mock                                     # other services as contract mocks (ports 4010–4016)
pnpm mock:event offer.created.v1 --to crm-engine   # feed an event, then POST /internal/v1/drain/q_crm_engine
pnpm --filter @11e/crm-engine test            # unit, integration, contract, perf (needs the local stack)
```

## Environment

| Variable               | Local default                                | Notes                                                            |
| ---------------------- | -------------------------------------------- | ---------------------------------------------------------------- |
| `DATABASE_URL`         | `CRM_ENGINE_DATABASE_URL` from `pnpm db:env` | pooler URL with the `crm_engine_svc` role                        |
| `CRON_SECRET`          | `CRM_ENGINE_CRON_SECRET`                     | must equal Vault `cron_secret_crm_engine`                        |
| `WEB_URL` / `JWKS_URL` | http://127.0.0.1:3000                        | service tokens (R-2): verification and minting                   |
| `SERVICE_CREDENTIAL`   | —                                            | mints tokens for records (micromarkets) and journeys (reconcile) |
| `RECORDS_URL`          | http://127.0.0.1:3002                        | `GET /v1/micromarkets` (micromarket-refresh, R-13)               |
| `JOURNEYS_URL`         | http://127.0.0.1:3003                        | `GET /internal/v1/subject-states` (projection-reconcile)         |
| `POOL_MAX`             | 3                                            | capacity plan                                                    |
| `PORT`                 | 3004                                         | local only                                                       |

## Code layout

- `src/domain` (pure): `micromarket` (hierarchy, proximity, adjacency), `filters` (hard filters 1–9 and exclusions),
  `scoring` (factors, flags), `bundles` (finder and manual rules), `engine` (one demand against offers), `lifecycle`
  (run merge, top-N, state machine), `weights`, `matchable`, `dates`.
- `src/application`: `projection` (events → projection), `pipeline` (RescoreSubject for demands and offers),
  `propagation` (life-curve, commercial, deal and merge effects), `commands`, `explain`, `jobs`, `feedback`, `ports`.
- `src/adapters`: `store` (Postgres repositories), `events` (q_crm_engine), `work` (q_crm_engine_rescore), `routes`,
  `jobs`, `records-client`, `journeys-client`. Composition root: `src/main.ts` / `src/app.ts`.

## Owned data

Schema `crm_engine` (owner `crm_engine_owner`, runtime role `crm_engine_svc`), migrations `0001`–`0002`. **No PII**:
ids, codes, controlled values, numbers and dates only; `building_key` is an opaque hash (a test fails the build on a
PII column).

| Table                                                                                                                           | Purpose                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `offer_mx`, `demand_mx`                                                                                                         | matchable projection with per-group versions (facts, price, life, commercial, status) |
| `micromarket_nodes`, `reference_state`, `vocabulary_cache`                                                                      | copy of records' hierarchy + adjacency, release cache                                 |
| `matches`, `match_offers`, `bundles`                                                                                            | suggestions (single or bundle of 2–3), their offers, bundle details                   |
| `exclusions`                                                                                                                    | date-aware / liveness exclusions with reasons (≤ 50 per demand)                       |
| `feedback`, `weights`                                                                                                           | M6 feedback (staff and proposal), versioned weights and tunables                      |
| `matching_runs`, `rescore_pending`                                                                                              | runs (inventory check, re-runs) and the dirty-subject dedupe                          |
| `deals`                                                                                                                         | deals seen through events (reject guard, close propagation, compensation)             |
| `aggregate_versions`, `job_runs`, `merge_log`, `outbox`, `processed_events`, `idempotency_keys`, `job_leases`, `code_sequences` | technical                                                                             |

Candidate queries use a `match_keys text[]` column (`<tenant>|<segment>|<deal_type>|<micromarket node>`) with a GIN
index instead of the LLD's btree_gin composite index (the owner role cannot install extensions); the tenant stays the
first key component.

Retention (projection-reconcile, weekly): Rejected/Closed matches and feedback 24 months, exclusions 90 days, runs 30
days, merged projection rows 30 days, published outbox 7 days, processed events 30 days, expired idempotency keys.

## Events

- Consumes (q_crm_engine): `offer.created|updated|price_changed|voided.v1`, `price_sheet.applied.v1`,
  `demand.created|updated|voided.v1`, `records.merged|merge_undone.v1`, `vocabulary.released.v1`,
  `micromarkets.updated.v1` (records); `lifecycle.stage_changed.v1`, `offer.confirmed|commercial_status_changed|retired.v1`,
  `demand.confirmed|qualified|status_changed|exited|reactivated.v1`, `proposal.sent|feedback_recorded.v1`,
  `site_visit.completed.v1`, `deal.opened|closed|cancelled.v1` (journeys).
- Publishes: `match.suggested|confirmed|rejected|closed|flagged|reopened.v1`, `demand.matching_completed.v1`
  (→ q_journeys, q_insight, q_listings for confirmed) and `audit.recorded.v1` (weights, → q_web).
- Work queue `q_crm_engine_rescore`: dirty subjects (deduped by `rescore_pending`) and job continuations.
- Scheduled jobs: `full-rescore` (03:00 IST), `micromarket-refresh` (01:30 IST + on releases), `projection-reconcile`
  (Sunday 04:00 IST). Each call has a 50 s budget and continues through the work queue.

## Matching rules (summary)

Hard filters in order (LLD §4.1): launch area → liveness (Closed/voided/merged offers skipped; Expired/Inactive offers
and a Stale demand's new pairs become exclusions) → deal type → market (Sale; demand Any/blank matches both; blank offer
market → `market_unknown`) → segment + property type + residential BHK within ±1 of the demand (CR-011) → stated deal tags → micromarket overlap (hierarchy) → possession
window (`available_too_late`). Scoring: micromarket 0.25, price 0.25, area 0.20, bhk 0.10, timing 0.10, furnishing
0.10 over the applicable factors, minimum 40, top 20 open suggestions per demand. Bundles: Commercial/Industrial, 2–3
offers too small alone, same building / micromarket / adjacent micromarkets, combined area and price within the demand.

### Decisions where the documents were silent (see the service report)

1. A single match needs its area within tolerance (area value > 0); from LLD §4.3 "an offer that meets the area alone
   is a single match". Engine bundles use only offers that cannot be single matches. Confirmed by CR-011 item 1.
2. Timing when the availability month straddles `move_in_by`: 0.4.
3. A Suggested pair that stops qualifying closes `superseded`; Confirmed pairs close only for offer/demand causes.
4. Demands Expired / Paused by their life curve close their matches `demand_expired` / `demand_paused` (CR-012); an
   exit (including Dormant, which also sets Paused) closes them `demand_exited`. All three reopen as
   `demand_reactivated`. Matches closed `demand_exited` before CR-012 keep that reason.
5. `match.suggested.v1` on re-rank is emitted for Suggested matches only (not Confirmed).
6. A same-named locality under another micromarket is disambiguated by the offer's micromarket; zones never overlap.
7. Manual bundles score (and flag) an over-budget or over-area combination instead of rejecting it (no error code).
8. `projection-reconcile` repairs journeys-owned axes only; records facts rely on at-least-once events and the DLQ.
9. A journeys event for a subject that is not projected yet is retried by the drain (projection gap).
10. Residential BHK band (CR-011): the offer's BHK range must come within 1 BHK of the demand's range (a "2 or 3 BHK"
    demand is the range 2–3, so 1–4 BHK pass; 1 RK = 0.5). A blank BHK on either side is never filtered and the bhk
    factor is then not applicable (no flag: the contract's flag list has none for BHK). A failure is reported under the
    `property_type` check (the contract has no BHK filter name) and, like a property type mismatch, is skipped, not
    recorded as an exclusion (the exclusion reasons are date/liveness reasons only). Within the band, bhk scores
    exact 1.0, ½ BHK away 0.6, 1 BHK away 0.3.
11. A `maybe` proposal verdict (CR-012) is neutral: no feedback row is written.

## Performance (local stack, ENG-07)

`tests/perf/matching.perf.test.ts` on one dense cell: demand-side run p95 55 ms with 3,000 candidates and 149 ms with
6,000 offers (5,000 cap + price narrowing), target ≤ 500 ms (LLD §8); offer-side run p95 35–200 ms (across runs; re-run after CR-011: demand-side p95 56–60 ms at 3,000 and 146 ms at 6,000 offers); `GET
/v1/demands/{id}/matches` p95 3 ms and explanation p95 2 ms, target < 300 ms (NFR-2).
