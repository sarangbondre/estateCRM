Current stage: 7 — Execution
State: IN PROGRESS (service tracks in parallel; local-first, cloud provisioning deferred)

| Stage | Status | Approved on | Artifacts |
|---|---|---|---|
| 1 — BRD | APPROVED (v0.6.1: v0.6 via CR-003 + CR-004) | 2026-09-24 | docs/01-brd.md, docs/01-brd.pdf |
| 2 — PRD | APPROVED (v0.6 incl. CR-005, CR-006) | 2026-09-24 | docs/02-prd.md, docs/02-prd.pdf, docs/prototype/11estate-crm-prototype.html |
| 3 — HLD | APPROVED (v0.2) | 2026-09-24 | docs/03-hld.md, docs/03-hld.pdf, docs/adr/0001–0008 |
| 4 — LLD | APPROVED (v0.1; Q4-1…Q4-4 defaults applied) | 2026-09-27 | contracts/openapi/*.yaml (240 ops), contracts/asyncapi/events.yaml (68 events), docs/04-lld/ (7 service LLDs, conventions, data-hosting, capacity-plan, stage4-summary.pdf) |
| 5 — Task Breakdown | APPROVED (v0.1; execution mode decided in Stage 6) | 2026-09-27 | docs/05-tasks.md, docs/05-tasks.pdf (87 tasks) |
| 6 — Implementation Rules | APPROVED (v0.1; dictated "approved stage six") | 2026-09-27 | docs/06-implementation-rules.md, docs/06-questionnaire.md, docs/runbooks/provisioning.md |
| 7 — Execution | IN PROGRESS | — | tasks per docs/05-tasks.md |

Inputs: docs/inputs/extractor-master-profile.md (PII-free profile of crm_master.xlsx; file not stored), docs/inputs/CRM-01-brd-v0.5.pdf, docs/inputs/CRM-01-brd-v0.6.pdf (client BRDs by Vinit), docs/inputs/vinit-journeys-artifact.md

Environments:
- Supabase pilot project ref: `xzizchbnejzxkhemmpie` (Mumbai, Free). Linking, bootstrap and deploy happen in the provisioning session (docs/runbooks/provisioning.md).

Stage 7 task progress:
- [x] F-01 Monorepo scaffold (2026-09-27)
- [x] F-02 Code quality baseline: TS 6 strict, ESLint (no-console), dependency-cruiser layer rules (proven with a probe), gitleaks clean (2026-09-27)
- [x] F-03 CI: reusable per-service workflow (lint, layers, typecheck, tests, build) × 7 with path filters + repo workflow (gitleaks, libs) (2026-09-27)
- [x] F-04 Contract tooling: Redocly lint (baseline ignore file), AsyncAPI parser validation, TS types in `@11e/contracts` (7 services + 68 events), drift check, CI `contracts` job (2026-09-27)
- [x] F-05 Contract mocks: Prism per OpenAPI spec (`pnpm mock`, ports 4010–4016), 68 schema-valid event fixtures, `pnpm mock:event` pgmq publisher, CI smoke test (2026-09-27)
- [x] F-06 Local database stack: Supabase CLI (Postgres 17) under `infra/`, generated platform bootstrap (7 schemas, owner/migrator/svc roles with pilot caps, pgmq/pg_cron/pg_net, 14 queues, SECURITY DEFINER queue wrappers derived from AsyncAPI), Data API exposure none, `pnpm db:*` + `pnpm dev`, 61-check platform verifier (CI `db-platform` job; reused for F-07) (2026-09-27)
- [x] F-08 libs/db: Kysely + pg pool with role-cap wait (53300 backoff), tenantScope, withTransaction (statement timeout, retry), idempotency keys (R-3), forward-only migrator + `11e-migrate` CLI with checksum/lock/backward-compat lint, readiness check; 31 tests incl. integration on local stack (2026-09-27)
- [x] Lib template (tsconfig/build/Vitest) for all libs (2026-09-27)
- [x] F-13 libs/vocabulary: release v0.6 data + types, R-11 validators (issue codes = intake RowError codes), For/Wants label generator (65 combinations tested), legacy translation, release document; 228 tests; assumptions in libs/vocabulary/README.md (2026-09-27, PR #10)
- [x] F-09 libs/outbox: typed transactional outbox write, relay (SKIP LOCKED, atomic fan-out to pgmq), event drains (processed_events dedupe in the handler transaction, backoff via visibility timeout, DLQ after 5), work drains, DLQ replay, retention purges; platform bootstrap extended with private work queues (32 queues) + queue-argument wrappers; `contracts/generated/event-topology.json`; 9 integration tests on real pgmq (2026-09-27)
- [x] F-10 libs/http: contract-driven Hono service factory (Ajv validation against bundled OpenAPI, CR-007 auto-approved technical), RFC 7807 errors, correlation ID, health, response contract checks, Idempotency-Key helper (+ stale-claim takeover in libs/db), If-Match, cursor pagination, outbound client with timeout/retry/circuit breaker; 22 tests (2026-09-27)
- in progress (parallel agent): F-14 libs/redaction
- [x] F-11 libs/auth: contract-driven authenticate middleware (staff JWT + header/claim match + x-roles, service tokens + x-callers, cron secret, website API key hook), principals, tenant/role re-checks (other tenant → 404), service-token client with caching; libs/http gains per-operation middleware + effective security; 11 tests (2026-09-27)
- in progress (parallel agents): F-12 libs/observability, F-17 synthetic data
- [x] F-14 libs/redaction: redact/restore/detect with PHONE/EMAIL/URL/NAME/UNIT/ID, placeholder maps kept in memory only, residual-risk post-check; 0 leaks on 171 annotated synthetic ads, 50 hard negatives untouched (2026-09-27, PR #12)
- [x] F-15 Schedules and alarms: `infra/schedules.yaml` catalogue (checked against every contract jobs enum) → generated pg_cron jobs (60 scheduler calls + alarms + prune), `platform.invoke` via pg_net with Vault cron secrets, in-DB alarms (DLQ depth, relay/queue lag, failed jobs/calls) + optional webhook (CR-008 auto-approved technical); `configure-environment.mjs` for the provisioning session; verifier 73/73 incl. a real pg_cron→HTTP call (2026-09-27)
- next: F-16 runbooks + backups

Change requests:
- CR-001: WITHDRAWN 2026-09-24 (superseded by CR-002)
- CR-002: APPROVED 2026-09-24 (BRD v0.5 adopted; recommendations X-1…X-8 accepted)
- CR-003: APPROVED 2026-09-24 (BRD v0.6 adopted; recommendations Y-1…Y-9 accepted)
- CR-004: APPROVED 2026-09-24 (BRD A-10 clarified)
- CR-005: APPROVED 2026-09-24 (PRD §8.4 pilot on free plans + paid-plan gate)
- CR-006: APPROVED 2026-09-24 (PRD aligned with the extractor master file; Z-1…Z-10 accepted)
- CR-007: APPROVED 2026-09-27, auto-approved (technical, B3): edge validation with Ajv against the contract schemas instead of Zod
- CR-008: APPROVED 2026-09-27, auto-approved (technical, B3): alarm destination = in-DB alarm events + optional webhook; HTTP SLO alarms wired at provisioning

Open change requests: none
