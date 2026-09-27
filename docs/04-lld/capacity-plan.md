# 04 — LLD: Capacity plan

| | |
|---|---|
| Version | 0.1 (draft) |
| Date | 2026-09-24 |
| Based on | PRD v0.6 §8 (NFR-1…19, §8.4 pilot), HLD v0.2 §9–10, data-hosting.md |

Two sizings are given everywhere: **Pilot** (free plans, CR-005 limits) and **Production** (after the paid-plan gate, the
approved NFRs). Latency figures are service-side budgets. Little's law is used for concurrency: **L = λ × W**
(concurrent requests = arrival rate × time in system).

## 1. Demand assumptions
| Driver | Pilot | Production | Source |
|---|---|---|---|
| Staff users | ≤ 5 | 10–25 (demand + supply teams, managers) | BRD §2 |
| Staff sync requests | ≤ 5 rps peak | 50 rps peak (25 users × ~2 rps while working a queue) | Estimate |
| Listings public API | Demo only, ≤ 5 rps | Sized to **1,000 rps sustained** (NFR-1): the website, microsites and the CDN miss path | NFR-1 |
| Uploads | ≤ 3 files/day, ≤ 20k rows | 10 files/day × 100k rows (~1M rows/day) | NFR-5, §8.4 |
| Records held | ≤ ~200k | 5M offers/demands, 20M sightings, 1M people (year 1) | NFR-11, §8.4 |
| Chat | ≤ 2 concurrent | 5 concurrent, 30 msgs/min per user | NFR-7 |
| Events | ~10k/day | ~300k domain events/day → ~1.2M queue messages/day (4 consumers average); bursts 500 msg/s during uploads | Derived |

The real extractor master today is 2,155 records (docs/inputs), so the pilot limits are generous for current data.

## 2. Per-service sizing (production)
Serverless functions (Vercel) scale with λ, so there's no fixed instance count. **CLAUDE.md "min 2 / autoscale"** is met
by the platform (HLD §10.1). The effective limit is the **database pool cap**, so every service's concurrency is checked
against it: DB connections needed = λ × (time holding a connection).

| Service | Peak λ (sync) | Target p95 | Avg W (request) | Concurrency L = λ×W | DB hold per request | DB conns needed | Pool cap (Small / Medium) | Headroom |
|---|---|---|---|---|---|---|---|---|
| listings (public, origin) | 1,000 rps worst case (no CDN); **~150 rps expected** with CDN | 300 ms | 80 ms | 80 (worst) / 12 | 15 ms | 15 (worst) / 2.3 | 20 / 30 | OK even with no CDN |
| records | 30 rps staff + ingest drains | 300 ms | 120 ms | 3.6 | 30 ms | ~1 + drains 8 | 16 / 24 | OK |
| journeys | 20 rps (queues, cards) | 300 ms (My queue ≤ 1 s) | 150 ms | 3 | 40 ms | ~1 + jobs 4 | 10 / 14 | OK |
| crm-engine | 10 rps reads + scoring workers | 300 ms reads | 100 ms | 1 | 25 ms | ~1 + workers 8 | 12 / 16 | OK |
| intake | 2 rps (upload UI) + chunk workers | 300 ms (sync) | 100 ms | 0.2 | — | workers 12 (paid) | 12 / 16 | OK |
| insight | 5 rps (dashboards) + chat 5 concurrent | dashboards 2 s, chat first token 3 s | 400 ms | 2 + 5 streams | 60 ms | ~3 | 6 / 10 | OK |
| web (BFF) | 50 rps staff + auth | +30 ms overhead | 40 ms own work | 2 | 5 ms | ~1 | 6 / 8 | OK |
| **Total sync** | **≈ 1,100 rps worst case** (≥ 1,000 rps NFR-1) | | | | | | 90 / 130 | |

**Pilot:** everything is at most 1/20 of these rates. Pool caps from data-hosting §5 (total 32) cover it with ≥ 3× headroom.

### Function settings
| Service | Memory | Max duration | Concurrency guard |
|---|---|---|---|
| listings, records, journeys, web | 1 GB | 10 s (sync), 60 s (drains) | DB semaphore = pool cap |
| crm-engine | 1 GB | 60 s (Hobby) / 300 s (Pro) for scoring batches | 8 workers |
| intake chunk worker | 2 GB (Pro) / Hobby default | Hobby limit → 500-row chunks. Pro: 300 s → 2,000-row chunks | 5 (pilot) / 12–16 (paid) workers = intake pool cap (R-22) |
| insight chat | 1 GB | 60 s (streaming) | 5 concurrent streams |

## 3. Bulk upload throughput (NFR-5 / M2)
Per chunk (rows R): parse and validate ~2 ms/row; rules and normalisation ~3 ms/row; AI only for unresolved rows (~5%, in
batches of 20 at ~2 s per call); write raw rows in batch inserts ~1 ms/row.

| | Pilot (20k rows) | Production (100k rows) |
|---|---|---|
| Chunk size | 500 | 2,000 |
| Chunks | 40 | 50 |
| Time per chunk | 500×6 ms + 2 AI calls (25 rows) ≈ 3 s + 4 s = **7 s** | 2,000×6 ms + 5 AI calls (100 rows) ≈ 12 s + 10 s = **22 s** |
| Parallel workers | 5 | 12 (Small) / 16 (Medium) (R-22) |
| Intake stage | 40/5 × 7 s ≈ **56 s** | 50/12 × 22 s ≈ **5 waves ≈ 110 s** (Small) |
| records ingest (`rows.classified.v1`, 500 rows/event, ~10 ms/row incl. dedup lookup) | 40 events × 5 s ÷ 3 drainers ≈ **67 s** | 200 events × 5 s ÷ 8 drainers ≈ **125 s** |
| crm-engine incremental matching (new records only, ~5–10% of rows) | < 1 min | ~2–3 min |
| **End-to-end** | **≈ 3 min** | **≈ 6–9 min** (target ≤ 30 min, > 3× headroom) |

AI budget: pilot ≈ 5% of 60k rows/day → ~150 calls/day, which fits typical free monthly credits only for light use. When
the credits run out, rows fall back to needs_review (ADR-0004). Production ≈ 50k unresolved rows/day → ~2,500 calls/day
on a dedicated endpoint.

## 4. Caching strategy
| What | Where | TTL / invalidation | Why |
|---|---|---|---|
| Listings public GETs (list, detail, projects, demand posts) | Vercel edge cache via `Cache-Control: public, s-maxage=60, stale-while-revalidate=60` | ≤ 60 s. Freshness NFR-10 (≤ 1 min) holds. | Cuts origin load by ~85% (expected 1,000 → ~150 rps) |
| Listings change feed | Not cached | — | Must be exact |
| Vocabulary release | In-memory per function instance | 5 min, or immediately on `vocabulary.released.v1` | Validation on every write |
| Micromarket hierarchy | In-memory per instance | 1 h, or on release | Matching and normalisation |
| Dashboards | Pre-aggregated tables in the insight read model, updated by events | Near real time | NFR-8 ≤ 2 s without heavy queries |
| My queue | Materialised `queue_items` table in journeys, updated by events and jobs | Real time | NFR-8 ≤ 1 s |

The cache is never the source of truth. There's no Redis in Phase 1: Postgres with the right indexes plus edge caching meets
the targets.

## 5. Queue throughput
- pgmq on this instance handles thousands of messages per second. The peak need is ~500 msg/s (upload bursts).
- Relay: every minute plus a poke after each commit. Each relay run moves up to 5,000 outbox rows (batch `INSERT … SELECT`
  into the consumer queues). Lag target < 60 s, with an alarm at > 5 min.
- Drains: every minute plus a poke. Each drain invocation reads up to 100 messages and processes them within 50 s, then
  re-pokes itself while its queue is non-empty (with bounded concurrency per consumer: records 8, crm-engine 8, others 3).
- DLQ: after 5 attempts. Alarm on depth > 0.

## 6. Scheduled jobs
| Job | Owner | Schedule (IST) | Size (production) | Budget |
|---|---|---|---|---|
| Life curve nightly | journeys | 02:00 | 5M subjects. Only rows whose stage can change **today** are touched (index on `next_stage_at`), ≈ 1–3% of rows | Done by 04:00 (NFR-9): ~150k updates in batches of 1,000 ≈ 5–10 min |
| Dormant revisits, lease renewals | journeys | 02:30 | Small | < 1 min |
| Full re-score sweep | crm-engine | 03:00 | Only demands changed in the last 24 h plus a rolling 1/7 of the rest | < 30 min |
| Backups (pilot) | GitHub Actions | 01:30 | ≤ 500 MB | < 5 min |
| Retention purge (NFR-18) | each service | Sunday 04:00 | Small | < 15 min |

## 7. Storage estimate (production, year 1)
| Data | Rows | Avg size | Size |
|---|---|---|---|
| records: offers, demands, properties, people | 5M + 1M | ~1.5 KB | ~9 GB |
| records: sightings / source ads | 20M | ~0.4 KB | ~8 GB |
| intake: raw rows (retained 24 months) | 20M | ~1 KB | ~20 GB |
| crm-engine: projection + matches (top 20 per demand) | ~10M | ~0.3 KB | ~3 GB |
| Other schemas, indexes (~40%) | | | ~15 GB |
| **Total** | | | **~55 GB** → Pro disk autoscale. Revisit at 70% (data-hosting §6). |

Pilot: ≤ 200k records ≈ 300–400 MB, which fits the 500 MB Free limit. Raw-row retention in the pilot is **30 days** to stay inside it.

## 8. Load test that proves it (Stage 7 final gate)
Tool: **k6** (scripts under `loadtests/`), run from an India region against **production-sized paid plans** (the pilot gets
a smoke version).

| Scenario | Load | Duration | Pass criteria |
|---|---|---|---|
| L1 Listings public API (mix: 60% list with filters, 30% detail, 10% projects) | **1,000 rps constant arrival**, with the CDN bypassed (worst case) | 15 min + 5 min ramp | p95 < 300 ms, errors < 0.1%, no pool waits > 50 ms |
| L2 Staff mix via web (queues, records, cards, matches) | 50 rps | 15 min, concurrent with L1 | p95 < 300 ms; My queue p95 < 1 s |
| L3 Bulk upload | 100k-row extractor-format file, then a second file in parallel | Until done | Both done ≤ 30 min, no DLQ messages, report counts correct |
| L4 Life curve | 5M-subject synthetic dataset, nightly job | Single run | Done < 2 h (by 04:00 when started at 02:00); stage actions visible in listings ≤ 5 min |
| L5 Chat | 5 concurrent conversations, Appendix A questions | 10 min | First token p95 ≤ 3 s, answer p95 ≤ 15 s, 0 PII in outbound AI requests (checked by an intercepting mock) |
| L6 Soak | L1 at 30% + L2 | 2 h | No memory growth, no relay lag > 60 s |
| **Pilot smoke** | L1 at 50 rps, L2 at 5 rps, L3 with 20k rows | 10 min | Same latency targets, best effort |

Synthetic data is generated from the vocabulary with fake contacts. It never uses real personal data.

## 9. Risks and levers
| Risk | Lever |
|---|---|
| Free-plan limits hit in the pilot (DB 500 MB, AI credits) | 30-day raw retention, AI fallback, pass the paid gate earlier |
| Pool exhaustion during a large upload | Worker caps below the pool caps; drains back off on pool wait |
| Listings spike beyond 1,000 rps | Edge cache absorbs repeat reads; `rate-limited` per API key |
| Life-curve job overrun | `next_stage_at` index limits the work to rows due today; batch size is tunable |
