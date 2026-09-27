"""Generates docs/05-tasks.md from one task catalogue (Stage 5). Checks dependencies and computes the critical path."""
import pathlib, collections
SZ = {'S': 0.5, 'M': 2, 'L': 4}   # working days, one builder pairing with Claude
T = []  # (id, track, title, acceptance, deps, size)
def t(i, tr, title, ac, deps, sz): T.append((i, tr, title, ac, deps, sz))

# ---------------- Foundation
F='Foundation'
t('F-01',F,'Monorepo scaffold','`services/<svc>` ×7 (incl. web), `libs/`, `contracts/`, `infra/`, `loadtests/`, `tools/`, `.github/workflows/`; pnpm workspaces + Turborepo; CODEOWNERS maps every service folder to Sarang; each service has README, Dockerfile-equivalent build config, `src/{domain,application,adapters}`, `migrations/`, `tests/`',[], 'S')
t('F-02',F,'Code quality baseline','Shared TS config, ESLint, formatter; dependency-cruiser rules forbid domain → application/adapters and application → adapters imports (CLAUDE.md §3.1); gitleaks config; all pass on the empty scaffold',['F-01'],'S')
t('F-03',F,'CI pipeline per service','GitHub Actions per service with path filters: lint, typecheck, layer check, unit, integration (Supabase local), contract tests, secret scan, build; a failing check blocks merge',['F-02'],'M')
t('F-04',F,'Contract tooling','OpenAPI lint + AsyncAPI validation in CI; TS types generated from `contracts/`; **CI fails on drift** between code and contract (CLAUDE.md §3.3); `tools/gen_*` outputs checked in CI',['F-03'],'M')
t('F-05',F,'Contract mocks for parallel work','Mock server per OpenAPI spec (examples-based) + event fixture publisher from AsyncAPI, runnable locally; any service can run alone with its dependencies mocked (CLAUDE.md §3.9)',['F-04'],'M')
t('F-06',F,'Local database stack','Supabase CLI local stack; bootstrap SQL creates 7 schemas, `<svc>_owner/_migrator/_svc` roles, grants, pgmq/pg_cron/pg_net, PostgREST exposure off (data-hosting §2–3); `pnpm dev` starts everything',['F-01'],'M')
t('F-07',F,'Provision pilot + verify platform','Supabase Free project in `ap-south-1` and 7 Vercel Hobby projects in `bom1` via Terraform in `infra/`; **verified**: pgmq, pg_cron, pg_net available; direct-connection limit recorded; Data API exposure none. Any failure → STOP and raise a CR (data-hosting §7)',['F-06'],'M')
t('F-08',F,'libs/db','Pooled client through Supavisor (transaction mode, no prepared statements), per-role semaphore, tenant-scoped query helper, migration runner (forward-only), `idempotency_keys` helper (R-3); integration-tested on local stack',['F-06','F-02'],'M')
t('F-09',F,'libs/outbox and queue consumer','Outbox write in the same transaction; relay handler (SKIP LOCKED, fan-out to per-consumer pgmq queues from the AsyncAPI subscriptions); drain handler with `processed_events` dedupe, aggregateVersion ordering, backoff, DLQ after 5 attempts; tests prove at-least-once + idempotency',['F-08','F-04'],'L')
t('F-10',F,'libs/http','Hono app factory: correlation ID, RFC 7807 errors, input validation from generated schemas, Idempotency-Key middleware, If-Match, cursor pagination, health endpoints, outbound client (2 s timeout, retries with jitter on idempotent calls, circuit breaker)',['F-04','F-08'],'M')
t('F-11',F,'libs/auth','Service-token verification against web JWKS (cached), staff header parsing, role + tenant re-check helpers, cron-secret and client-secret checks; unit-tested',['F-10'],'S')
t('F-12',F,'libs/observability','JSON logger with a PII allow-list (test proves phones/emails never logged), OpenTelemetry tracing across HTTP and events (traceparent in envelope), RED metrics per route and consumer',['F-10'],'M')
t('F-13',F,'libs/vocabulary','Vocabulary release v0.6 files (BRD §4.2), runtime validators (R-11 trim/case-fold), generated display labels (For/Wants table), legacy-term translation table; exhaustive unit tests of the label table',['F-02'],'M')
t('F-14',F,'libs/redaction','Redaction of Indian phones, emails, names near contact phrases, unit/wing numbers; test set from anonymised real ad patterns; 0 leaks on the test set',['F-02'],'M')
t('F-15',F,'Schedules and alarms','pg_cron + pg_net job template (relay/drain every minute, service jobs) installed by migrations with per-service secrets; alarms: DLQ depth > 0, relay lag > 5 min, 5xx > 2%, p95 breach',['F-09','F-07'],'S')
t('F-16',F,'Backups and runbooks','Nightly per-schema `pg_dump` to private Mumbai bucket (pilot) + monthly restore check; runbooks: deploy, rollback, rotate secrets, DLQ replay, restore',['F-07'],'S')
t('F-17',F,'Synthetic data generator','Vocabulary-driven generator of properties/offers/demands/people with fake contacts at pilot and production scale (5M) for tests and load tests; never uses real personal data',['F-13'],'M')

# ---------------- records
R='records'
t('REC-01',R,'Schema and migrations','All tables/indexes of the records LLD §3 (incl. code sequences, source ads, sightings, merges + undo log, desks, market data, photos, vocabulary releases, micromarkets + adjacency, outbox, processed_events, idempotency_keys); PII columns marked; tenant-first indexes',['F-08'],'L')
t('REC-02',R,'Reference data','Vocabulary release load + `GET /v1/vocabulary*` + `vocabulary.released.v1`; micromarkets CRUD with MMR seed + adjacency + `micromarkets.updated.v1`; launch-area settings (R-9)',['REC-01','F-13','F-09','F-10'],'M')
t('REC-03',R,'Supply records API','Properties, projects, offers CRUD/list/search with stored-field filters, cursor pagination, If-Match; `offer.*`, `project.*` events; codes issued per tenant',['REC-02'],'L')
t('REC-04',R,'Demand, people and quick add','Demands, touches, people CRUD/search; quick-add lookup by phone hash (POST, R-10 stages); `demand.*`, `person.*` events; contacts masked by default',['REC-02'],'L')
t('REC-05',R,'Ingest from intake','Consumer of `rows.classified.v1`: fetch PII via intake internal API (service token), apply migration map first, upsert by externalRef + content hash, source ads + split children, sightings, extractor-dedup trust, route non-Property scopes to desks, staff edits win, outside-launch-area flag',['REC-03','REC-04','F-11'],'L')
t('REC-06',R,'Dedup and merges','Property-level supply dedup, demand touches (first touch credit), `possible_repeat_of` → merge candidates, price gaps; merge + column-level undo; `records.merged/merge_undone`, `merge_candidate.raised`',['REC-05'],'L')
t('REC-07',R,'Add supply and price sheets','`POST /v1/demands/{id}/add-supply` (dedup first, Sourced-for tag, Contacted); project price sheets → `price_sheet.applied.v1`',['REC-03','REC-04'],'M')
t('REC-08',R,'Contact privacy','`POST /v1/reveals` (audited, 60/h), `POST /internal/v1/contacts:batch` (R-21), `GET /internal/v1/properties/{id}/scan-terms` (R-20), `audit.recorded.v1`',['REC-04','F-11'],'M')
t('REC-09',R,'Photos','Signed upload, attach/remove, internal signed-URL read; `photo.added/removed`',['REC-03'],'M')
t('REC-10',R,'Journey-driven consumers','Consume `deal.closed`, `offer.retired` (market data + `market_data.recorded`), `call.logged` (unreachable flag), `demand.exited/reactivated`, `lease_renewal.due` (Upcoming offer), `offer.confirmed`, `site_visit.completed`, `publication.changed`, `review_item.resolved` (reclassify / `*.voided`)',['REC-05','F-09'],'M')
t('REC-11',R,'Desks','Desk lists + desk item patch; `desk_item.*`, `watchlist_item.created`',['REC-05'],'S')
t('REC-12',R,'records: definition of done','Contract tests pass on all 69 operations; tenant-isolation test; README (run locally, env vars, owned data, events); metrics/traces/health; STATUS updated',['REC-06','REC-07','REC-08','REC-09','REC-10','REC-11'],'M')

# ---------------- intake
I='intake'
t('INT-01',I,'Schema and migrations','Tables/indexes of the intake LLD §3 (uploads, chunks, templates, raw_rows, row_errors, review items, outbox…)',['F-08'],'M')
t('INT-02',I,'Upload API','Create (signed URL), get/list, progress, cancel, rejected-rows download; 5 uploads/h per user',['INT-01','F-10'],'M')
t('INT-03',I,'Inspect, modes and templates','Header inspection; strict mode only on exact 89-column match; mapping mode + templates CRUD; identical-file detection',['INT-02','F-13'],'M')
t('INT-04',I,'Split job','Streaming xlsx/csv → chunks (500 pilot / 2,000 paid), `migration_map` sheet parsed, chunk messages idempotent',['INT-03','F-09'],'L')
t('INT-05',I,'Chunk worker: rules','Strict validation (R-11, range-inverted), legacy translation, normalisation (units, localities via records micromarkets, BHK), reason codes (8), content hash + unchanged detection, raw rows written',['INT-04','REC-02'],'L')
t('INT-06',I,'Chunk worker: AI for leftovers','Redaction → Hugging Face call (batch 20) → vocabulary validation → needs_review on low confidence; fallback `model_unavailable`; no PII leaves (test with intercepting mock)',['INT-05','F-14'],'M')
t('INT-07',I,'Pilot anonymiser','Anonymise-on-import switch (CR-006 Z-9): consistent fake values, original file deleted after split',['INT-04'],'S')
t('INT-08',I,'Events and internal rows API','`rows.classified` (≤500), `upload.*`, `review_item.created`; `GET /internal/v1/uploads/{id}/rows?batch=` for records',['INT-05','F-11'],'M')
t('INT-09',I,'Review queue','List/summary/resolve/bulk-resolve grouped by reason code; `review_item.resolved.v1`',['INT-08'],'M')
t('INT-10',I,'Parse for quick add','`POST /v1/parse` (4 s), redaction before AI',['INT-06'],'S')
t('INT-11',I,'intake: definition of done','Contract tests (30 ops); 20k-row pilot file processed ≤ 5 min locally; retention job (30 d pilot); README; metrics; STATUS',['INT-07','INT-09','INT-10'],'M')

# ---------------- crm-engine
E='crm-engine'
t('ENG-01',E,'Schema and projection','Matchable PII-free projection of offers/demands from events (facts, lifecycle, commercial status, voids, merges, micromarkets, price sheets)',['F-08','F-09'],'M')
t('ENG-02',E,'Matching core','Hard filters and scoring (PRD §4.5), unknown basis ±25% + flag, unknown market, Stale reconfirm flag, date exclusions with reasons, outside-launch-area exclusion, top 20; unit tests from BRD §7 and Appendix B',['ENG-01','F-13'],'L')
t('ENG-03',E,'Bundles','2–3 offers by buildingKey or adjacent micromarket (R-13), commercial/industrial only, combined area/price',['ENG-02'],'M')
t('ENG-04',E,'Triggers and propagation','Incremental matching on events; price-change flags; close/reopen/superseded; `demand.matching_completed.v1`; `match.*` events',['ENG-02'],'M')
t('ENG-05',E,'Match APIs','Matches by demand/offer, detail + explanation, confirm/reject, exclusions, re-run, weights',['ENG-04','F-10'],'M')
t('ENG-06',E,'Jobs and feedback','Nightly re-score sweep, projection reconcile, proposal feedback captured for M6 weight tuning',['ENG-04'],'S')
t('ENG-07',E,'crm-engine: definition of done','Contract tests (19 ops); matching precision checks on Appendix B scenarios; README; metrics; STATUS',['ENG-03','ENG-05','ENG-06'],'M')

# ---------------- journeys
J='journeys'
t('JOU-01',J,'Schema and projections','Tables/indexes of the journeys LLD §3 incl. local projections from records/crm-engine/listings/web events',['F-08','F-09'],'M')
t('JOU-02',J,'Life curve engine','Thresholds per category (BRD §4.5 + D-12 + R-12), `next_stage_at`, nightly job 02:00 IST, confirmation resets, stage actions, `lifecycle.stage_changed`, `offer/demand.confirmed`',['JOU-01'],'L')
t('JOU-03',J,'Queues','Must/Should call ranking, demand queue sections, capacity (default 40), today list, reassign, `queue.counts_changed` flush (≤1/min/user); My queue p95 ≤ 1 s',['JOU-02'],'L')
t('JOU-04',J,'Calls and offer retirement','Call outcomes, 3-attempt rule, `call.logged`, retire/reactivate (R-12), commercial axis for offers',['JOU-03'],'M')
t('JOU-05',J,'Demand journey','Qualify, exits Lost/Dormant/Invalid (competing terms, person flag), reactivate, dormant revisits, commercial axis derivation',['JOU-03'],'M')
t('JOU-06',J,'Sourcing','Sourcing requests, anonymous demand post signal, needs-sourcing from `demand.matching_completed`',['JOU-05','ENG-04'],'M')
t('JOU-07',J,'Proposals','Snapshot from records, PDF (async) with MahaRERA number from listings, share link (14 d) + public page, mark sent, feedback (incl. "maybe")',['JOU-05'],'L')
t('JOU-08',J,'Site visits and deals','Visits (reset both life curves), deals with mandatory next action/follow-up, close (`deal.closed`, unitsBooked), cancel compensation, lease renewal at month 10',['JOU-07'],'L')
t('JOU-09',J,'Work notifications and Watchlist tasks','Match/SRQ/handoff/follow-up notifications; Watchlist follow-up tasks for supply',['JOU-03'],'S')
t('JOU-10',J,'Settings APIs','Life-curve thresholds, queue weights, capacities (Manager)',['JOU-03'],'S')
t('JOU-11',J,'journeys: definition of done','Contract tests (60 ops); life-curve job on 5M synthetic subjects < 2 h; README; metrics; STATUS',['JOU-04','JOU-06','JOU-08','JOU-09','JOU-10','F-17'],'M')

# ---------------- listings
L='listings'
t('LIS-01',L,'Schema and projections','Publication state, offers/projects/demand-post projections, change feed, API keys (hashed)',['F-08','F-09'],'M')
t('LIS-02',L,'Publication ceiling','Ceiling computation, level set, auto-downgrade on Stale/Expired/Closed/Inactive/voided/merged, `publication.changed`',['LIS-01','F-13'],'M')
t('LIS-03',L,'Privacy scan','Blocking patterns (phones, emails, URLs, handles, units, exact floors, street) + building-name hashes via records scan-terms; photo text = warning (R-8)',['LIS-02','REC-08'],'M')
t('LIS-04',L,'Public projection','Generated labels, PRD §8.3 fields (anonymous vs public), photo renditions via records signed URL into public bucket, MahaRERA + project RERA',['LIS-03','REC-09'],'M')
t('LIS-05',L,'Public API','Listings/projects/demand posts/detail + change feed; cursor ≤ 50; edge cache headers; per-key rate limits (R-1); withdrawal ≤ 1 min',['LIS-04'],'M')
t('LIS-06',L,'Admin','API keys create/rotate/revoke; publication settings (MahaRERA number), readable by journeys service token',['LIS-01','F-11'],'S')
t('LIS-07',L,'listings: definition of done','Contract tests (25 ops); automated "0 PII in API output" scan (M8); README; metrics; STATUS',['LIS-05','LIS-06'],'M')

# ---------------- insight
N='insight'
t('INS-01',N,'Schema and read model','Analytics tables fed by all subscribed events (63), conversations (redacted text only), plan catalogue, exports',['F-08','F-09'],'L')
t('INS-02',N,'Dashboards','Demand, supply, other scopes, data quality (classification grids, side checks, queue tiles from `queue.counts_changed`); ≤ 2 s p95',['INS-01','F-13'],'M')
t('INS-03',N,'Query plans','Allowed query-plan catalogue + executor on the read model + "How I got this"',['INS-01'],'M')
t('INS-04',N,'Chat','Redaction → Hugging Face plan → validation → template answers (no model-written facts), SSE streaming, keyword fallback, out-of-scope refusal, action cards referencing owning-service operations',['INS-03','F-14'],'L')
t('INS-05',N,'Exports','Async Excel (20k pilot / 100k prod), contacts via records batch for allowed roles (not Data operators), 24 h link, audit, `export.*`',['INS-03','REC-08'],'M')
t('INS-06',N,'Chat benchmark','PRD Appendix A (13 questions) automated; M7 ≥ 85%; outbound AI requests checked PII-free',['INS-04'],'S')
t('INS-07',N,'insight: definition of done','Contract tests (20 ops); README; metrics; STATUS',['INS-02','INS-05','INS-06'],'M')

# ---------------- web
W='web'
t('WEB-01',W,'App shell','Next.js chat-first layout from the prototype: sidebar, home tiles, composer with "/" actions, side panel, card framework, light/dark',['F-01','F-02'],'M')
t('WEB-02',W,'Sign-in and service tokens','Supabase Auth Google (Workspace, invited only), session, `/v1/me`, service-token issuer + JWKS (R-2), client-secret auth for services',['WEB-01','F-07','F-11'],'M')
t('WEB-03',W,'Gateway','Routing table (`x-routes`) to services, auth + tenant check, token-bucket rate limits, correlation IDs, pass-through Idempotency-Key',['WEB-02','F-10'],'M')
t('WEB-04',W,'Users, audit and notifications','Users/invitations/roles + `user.changed.v1`; audit sink + audit log; upload/export/user notifications merged with journeys',['WEB-03','F-09'],'M')
t('WEB-05',W,'Cards: intake and records','Upload (attach → mapping → progress → report), review queue, quick add (classification order), add supply, record panels, reveal, desks',['WEB-03','INT-11','REC-12'],'L')
t('WEB-06',W,'Cards: engine and journeys','My queue panel, call outcome, qualify, matches + bundles, sourcing, proposal, site visit, deal, exit, close/retire',['WEB-05','ENG-07','JOU-11'],'L')
t('WEB-07',W,'Cards: listings and insight','Publication card, chat with streaming + action cards + "How I got this", dashboards panel, exports',['WEB-06','LIS-07','INS-07'],'L')
t('WEB-08',W,'Settings page','Users, capacities, thresholds, weights, micromarkets, vocabulary (read-only), MahaRERA, API keys, audit log',['WEB-07'],'M')
t('WEB-09',W,'web: definition of done','Playwright E2E for the core cards; accessibility checks (WCAG 2.1 AA core flows); README; metrics; STATUS',['WEB-08'],'M')

# ---------------- QA & release
Q='Test & release'
t('QA-01',Q,'End-to-end acceptance scenarios','PRD Appendix B AS-D1…D4 and AS-S1…S6 pass across all services on the local stack',['WEB-09'],'L')
t('QA-02',Q,'Pilot deployment','All 7 deploy to the pilot; anonymised import of the real extractor master (2,155 rows); smoke tests; demo to 11 Estates',['QA-01','F-15','F-16'],'M')
t('QA-03',Q,'Pilot benchmarks','M3 dedup precision, M4 repost recall, M5 categorisation, M6 match relevance collected on pilot data; pilot load smoke (capacity plan §8)',['QA-02'],'M')
t('REL-01',Q,'Paid-plan gate','Vercel Pro + Supabase Pro + PITR (Mumbai) + dedicated Hugging Face endpoint provisioned; standby/failover checked vs NFR-3 (CR if needed); real data enabled only now',['QA-03'],'M')
t('REL-02',Q,'Production load test','k6 scenarios L1–L6 (1,000 rps listings, staff mix, 100k upload ≤ 30 min, 5M life curve, chat, 2 h soak) pass on production sizes',['REL-01','F-17'],'M')
t('REL-03',Q,'Release','Alarms fired in a drill, restore drill ≤ 1 h, runbooks complete; results reported → `APPROVED: Release`',['REL-02'],'S')

# ---------------- checks, critical path
ids = {x[0]: x for x in T}
for x in T:
    for d in x[4]: assert d in ids, (x[0], d)
memo = {}
def ef(i):  # earliest finish (days) along longest path
    if i in memo: return memo[i]
    x = ids[i]; st = max([ef(d) for d in x[4]] or [0]); memo[i] = st + SZ[x[5]]; return memo[i]
end = max(T, key=lambda x: ef(x[0]))[0]
cp = []; cur = end
while cur:
    cp.append(cur); x = ids[cur]
    cur = max(x[4], key=ef) if x[4] else None
cp = cp[::-1]; cpset = set(cp)
tracks = ['Foundation', 'records', 'intake', 'crm-engine', 'journeys', 'listings', 'insight', 'web', 'Test & release']
tot = collections.Counter(); cnt = collections.Counter()
for x in T: tot[x[1]] += SZ[x[5]]; cnt[x[1]] += 1
seq = []; seen = set()
order_tracks = ['Foundation', 'records', 'intake', 'crm-engine', 'journeys', 'listings', 'insight', 'web', 'Test & release']
def visit(i):
    if i in seen: return
    for d in ids[i][4]: visit(d)
    seen.add(i); seq.append(i)
for tr in order_tracks:
    for x in T:
        if x[1] == tr: visit(x[0])

o = []
o += ['# 05 — Task Breakdown', '', '| | |', '|---|---|', '| Version | 0.1 (draft) |', '| Date | 2026-09-27 |',
      '| Based on | BRD v0.6.1, PRD v0.6, HLD v0.2, LLD v0.1 (all approved); stack as proposed for Stage 6 (TypeScript, Next.js, Hono, Kysely, Supabase, Vercel) |',
      '| Status | AWAITING APPROVAL |', '| Generated by | `tools/gen_tasks.py` (dependency check + critical path) |', '']
o += ['## 1. How to read this', '',
      '- **Tracks:** a shared **Foundation** track first, then one track per service (each assignable to one developer — here, Sarang with Claude), then **Test & release**.',
      '- **Size:** S ≈ ½ day, M ≈ 2 days, L ≈ 4 days of focused work with Claude writing the code. Estimates, not commitments.',
      '- **Parallel against mocks:** after the Foundation, every service track depends only on `libs/`, its own schema and **contract mocks** (F-05) — never on another service being built. Cross-service dependencies listed below are the few places where a real service replaces a mock (e.g. intake needs records\' micromarkets).',
      '- **Definition of Done** (CLAUDE.md §5) applies to every task; the last task of each service track is its explicit DoD check and ends with a stop for `APPROVED: <service>`.',
      '- **★ = on the critical path.**', '']
o += ['## 2. Summary', '', '| Track | Tasks | Effort (days) |', '|---|---|---|'] + [f'| {tr} | {cnt[tr]} | {tot[tr]:g} |' for tr in tracks] + [f'| **Total** | **{len(T)}** | **{sum(tot.values()):g}** |', '']
pilot = sum(SZ[ids[i][5]] for i in ids if i not in ('QA-03','REL-01','REL-02','REL-03'))
o += [f'**Critical path:** ' + ' → '.join(cp) + f' = **{ef(end):g} working days**. This is the shortest possible elapsed time, reachable only if the service tracks run in parallel.', '',
      '**Elapsed time depends on how tasks run:**', '',
      '| Mode | Pilot ready (QA-02) | Release (REL-03) |', '|---|---|---|',
      f'| One task at a time (CLAUDE.md Stage 7 as written) | ≈ {pilot:g} working days | ≈ {sum(tot.values()):g} working days |',
      f'| Service tracks in parallel (Claude agents per service, you still approve each service) | ≈ {ef("QA-02"):g}–{ef("QA-02")*1.4:.0f} working days | ≈ {ef(end):g}–{ef(end)*1.4:.0f} working days |', '',
      'Sizes are deliberately conservative. Actual pace is measured after the Foundation track and this table is re-estimated then.', '']
o += ['## 3. Stage 7 execution order', '',
      'Service approval gates in this order (each ends with `APPROVED: <service>`): **records → intake → crm-engine → journeys → listings → insight → web**, then the pilot, then the paid-plan gate and `APPROVED: Release`. Records goes first because every other service consumes its events; web goes last because it integrates all cards (its shell and sign-in are built early inside its track once the Foundation is done).', '',
      'Full task sequence (dependency-respecting): ' + ', '.join(seq), '']
o += ['## 4. Tasks', '']
for tr in tracks:
    o += [f'### {tr}', '', '| ID | Task | Acceptance criteria | Depends on | Size | CP |', '|---|---|---|---|---|---|']
    for x in T:
        if x[1] == tr:
            o.append(f'| {x[0]} | {x[2]} | {x[3]} | {", ".join(x[4]) or "—"} | {x[5]} | {"★" if x[0] in cpset else ""} |')
    o.append('')
o += ['## 5. Risks to the plan', '',
      '| Risk | Effect | Mitigation |', '|---|---|---|',
      '| Free-plan limits (pgmq/pg_cron missing, function time limits) | Foundation blocked | F-07 verifies first; stop and raise a CR on failure |',
      '| Hugging Face free credits too small for testing | AI tasks slowed | Rules first; intercepting mock for tests; small paid top-up is a PO decision |',
      '| Dedup thresholds need real samples | M3/M4 targets missed | Tunable thresholds; QA-03 measures on the real (anonymised) master |',
      '| Contract changes discovered during build | Rework | Change Request per CLAUDE.md; contracts regenerated by tools; drift fails CI |',
      '| Single builder | Long elapsed time | Strict order; mocks let Claude work on one service without waiting for others |', '']
o += ['## 6. Assumptions', '',
      '- The Stage 6 stack is as proposed; if Stage 6 changes it, tasks keep their scope and only tooling words change.',
      '- Vinit keeps producing extractor files in the approved 89-column schema (PRD Appendix C).',
      '- A sample WhatsApp extractor file arrives before INT-11 (PRD OQ-P11) to confirm sender fields.', '']
pathlib.Path(__file__).resolve().parent.parent.joinpath('docs/05-tasks.md').write_text('\n'.join(o) + '\n')
print(len(T), 'tasks;', sum(tot.values()), 'days; CP', ef(end), 'days:', ' → '.join(cp))
