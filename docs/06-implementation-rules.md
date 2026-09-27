# 06 — Implementation Rules

| | |
|---|---|
| Version | 0.1 (draft) |
| Date | 2026-09-27 |
| Based on | CLAUDE.md §3 and §5; BRD v0.6.1, PRD v0.6, HLD v0.2, LLD v0.1, Tasks v0.1 (all approved) |
| Status | AWAITING APPROVAL (questionnaire answered 2026-09-27; see `docs/06-questionnaire.md`) |

This document confirms **what we build with** and **the few places we deviate from CLAUDE.md §3**, with reasons.
Everything not listed here follows CLAUDE.md §3 as written. Versions were checked against the npm registry on 2026-09-27. The
lockfile (`pnpm-lock.yaml`) pins exact versions, and upgrades go through normal PRs with CI green.

## 1. Stack

### 1.1 Runtime and repository
| Item | Choice | Version | Why |
|---|---|---|---|
| Language | **TypeScript** (strict mode) | **6.0.x** | One language for the UI and the 6 services. **Not 7.0**: typescript-eslint supports TypeScript < 6.1, and the lint and layer rules depend on it. We move to 7 when the linter supports it. |
| Runtime | **Node.js LTS** | **24.x** ("Krypton") | Current LTS, required by Vitest 5. The local machine has Node 20.13 and must be upgraded (§5). |
| Package manager | **pnpm** workspaces | 12.x | Fast, strict dependency isolation per service |
| Monorepo build | **Turborepo** | 2.11.x | Builds, tests and deploys only what changed. Each service stays independent (CLAUDE.md §3.9). |

### 1.2 Front end (`services/web`)
| Item | Choice | Version |
|---|---|---|
| Framework | **Next.js** (App Router) + **React** | 16.3.x / 19.3.x |
| Styling | **Tailwind CSS**, with design tokens carried over from the approved prototype | 4.3.x |
| Auth | **Supabase Auth** (Google provider) via `@supabase/supabase-js` + `@supabase/ssr` | 2.117.x / 0.12.x |
| Streaming chat | Server-Sent Events from insight, rendered incrementally | — |
| UI tests | **Playwright** | 1.63.x |

### 1.3 Back-end services (`intake`, `records`, `journeys`, `crm-engine`, `listings`, `insight`)
| Item | Choice | Version | Notes |
|---|---|---|---|
| HTTP layer | **Hono**, deployed as Vercel Node functions | 4.13.x | One Hono app per service, built by the `libs/http` factory (task F-10) |
| Database access | **Kysely** (typed SQL query builder) + **node-postgres** (`pg`) | 0.29.x / 8.23.x | No ORM: queries stay explicit so every one maps to an index in the LLD. Connects through the Supavisor pooler with prepared statements off. |
| Migrations | Plain **SQL files** in `services/<svc>/migrations`, run by the `libs/db` runner | — | Forward-only, expand → migrate → contract (CLAUDE.md §3.2) |
| Validation | **Zod** | 4.6.x | Request and event validation at the edge |
| Contract types | **openapi-typescript** (types generated from `contracts/openapi`) | 7.13.x | Drift check in CI (F-04) |
| JWT / JWKS | **jose** | 6.2.x | Service tokens (R-2) |
| IDs | **uuidv7** | 1.2.x | Conventions §2 |
| Excel read/write | **exceljs** (streaming reader and writer) | 4.4.x | Intake parsing and insight exports |
| PDF | **@react-pdf/renderer** | 4.9.x | Proposal PDFs (journeys) |
| AI | **@huggingface/inference** | 4.13.x | Hugging Face Inference Providers (pilot) → dedicated endpoint (paid). Always behind `libs/redaction`. |
| Supabase Storage | `@supabase/supabase-js` (Storage client only; the DB goes through Kysely) | 2.117.x | Signed URLs |

### 1.4 Data and platform (confirmed in HLD/LLD; restated)
| Item | Choice |
|---|---|
| Database | Supabase **PostgreSQL** (Mumbai), a schema and roles per service, **Supavisor** pooling |
| Events and queues | Outbox + **pgmq** (ADR-0003) |
| Scheduler | **pg_cron + pg_net** |
| Files | **Supabase Storage** (private buckets; listings' public renditions bucket) |
| Hosting | **Vercel**, region `bom1`, 7 projects |
| Infrastructure as code | **Terraform** with the Vercel and Supabase providers (provider versions pinned in F-07) |

### 1.5 Quality, testing and operations
| Item | Choice | Version |
|---|---|---|
| Unit and integration tests | **Vitest** (integration against the Supabase local stack) | 5.0.x |
| HTTP mocks in tests | **MSW** | 2.15.x |
| Contract mocks for parallel work | **Prism** (from OpenAPI) + an event fixture publisher (from AsyncAPI) | 5.16.x |
| Contract linting | **Redocly CLI** (OpenAPI), **AsyncAPI CLI** | 2.54.x / 6.2.x |
| Lint | **ESLint** + **typescript-eslint** | 10.11.x / 8.70.x |
| Layer enforcement | **dependency-cruiser** (domain ↛ application/adapters; application ↛ adapters) | 18.4.x |
| Secret scanning | **gitleaks** (GitHub Action + pre-commit) | pinned in F-02 |
| Logging | **pino** (JSON) with a PII allow-list serializer | 10.3.x |
| Tracing and metrics | **OpenTelemetry** (`@opentelemetry/api` 1.9.x, SDK 0.222.x, `@vercel/otel` 2.1.x) | as listed |
| Load tests | **k6** (binary, pinned in REL-02) | — |
| CI/CD | **GitHub Actions**: one workflow per service (path filters), Vercel deploy on merge | — |
| Supabase / Vercel CLIs | `supabase` 2.118.x, `vercel` 60.x (devDependencies, run through pnpm) | — |

## 2. Project conventions (in addition to docs/04-lld/conventions.md)
1. **Layout per service:** `src/domain` (pure TypeScript, with no imports of Hono, Kysely, pg, Supabase, Hugging Face or Node I/O),
   `src/application` (use cases and port interfaces), `src/adapters` (http, db, queue, storage, ai), and
   `src/main.ts` as the only composition root. dependency-cruiser enforces this in CI.
2. **`libs/`** (infrastructure only, never domain models): `db`, `outbox`, `http`, `auth`, `observability`, `vocabulary`,
   `redaction`, `testing`. Each is versioned inside the workspace, and a change to a lib runs the CI of every service that uses it.
3. **Errors:** domain errors are typed classes mapped to RFC 7807 codes in the http adapter only.
4. **No PII in logs, traces, metric labels or event payloads.** The logger serializer drops non-allow-listed fields, and a
   test in every service asserts it.
5. **Every query is tenant-scoped** through the `libs/db` helper. A tenant-isolation test per service is mandatory (NFR-15).
6. **Money** is integer INR, **areas** are numbers in sq ft, **dates** are ISO 8601 (conventions §4).
7. **Commits:** Conventional Commits (the repo's commit-msg hook enforces them). One task = one PR = one branch
   `task/<ID>-<slug>`. The PR description links the task ID and ends with the attribution lines.
8. **Contract first:** a change to an API or event starts with the contract (`contracts/`, `tools/gen_events.py`). CI fails
   on drift. A breaking change needs a Change Request.

## 3. Environments and promotion
| Environment | Now (Phase 1a pilot) | After the paid-plan gate |
|---|---|---|
| local | Supabase CLI (Docker via OrbStack) + `vercel dev` / `pnpm dev` | same |
| pilot (also dev) | Supabase Free `11e-crm-pilot` + Vercel Hobby, preview deployments per PR | becomes `dev` |
| staging | — | Supabase Pro (small) + Vercel Pro |
| production | — | Supabase Pro + PITR + Vercel Pro |

The same build artifact (the Vercel deployment of a commit) is promoted between environments. Only environment variables differ.

## 4. Deviations from CLAUDE.md §3 (and §1 Stage 7)
| # | CLAUDE.md rule | Deviation | Justification | Mitigation / end date |
|---|---|---|---|---|
| D-1 | §3.8 Databases and internal services in **private networks** | Vercel ↔ Supabase and service ↔ service run over the public internet with TLS | Vercel has no private networking below Enterprise (Secure Compute). Product-owner hosting choice (H-1, H-7). | Short-lived service JWTs, SSL enforced, per-service DB roles, rotated secrets. Ends at the AWS move or with Vercel Secure Compute. |
| D-2 | §3.8 Secrets **only in a secrets manager** | Vercel encrypted environment variables | No separate secrets manager on this platform in the pilot | Least scope per project, gitleaks in CI and pre-commit, 90-day rotation (data-hosting §3). Ends at the AWS move (Secrets Manager). |
| D-3 | §3.6 **Minimum 2 instances**, autoscale on CPU/latency | Serverless functions: no fixed instances | Platform autoscales per request across zones | The DB pool caps act as the concurrency limit (capacity plan §2) |
| D-4 | §3.9 and §4 **Dockerfile per service** | Vercel builds from source (`vercel.json` + Turborepo). No Dockerfile in Phase 1. | Vercel doesn't run containers | Each service still builds, tests and deploys alone. A Dockerfile per service is added as part of the AWS move. |
| D-5 | §3.10 **Four environments** (local, dev, staging, production) | Phase 1a runs local + pilot only | Supabase Free allows 2 projects. The pilot uses anonymised data only (CR-005). | Staging and production are created at the paid-plan gate (REL-01) |
| D-6 | §3.6 Sessions and locks in **Redis** / object storage / DB | No Redis: sessions via Supabase Auth, locks and rate limits in Postgres | The rule allows DB-backed state. Removes one vendor. | Revisit only if capacity triggers fire |
| D-7 | §3.10 **No manual console changes** | A few settings the Terraform providers can't manage (e.g. Data API schema exposure, extension enabling) are applied by versioned scripts (`infra/scripts/`) or migrations, with a checklist in the runbook | Provider gaps | Every such setting is scripted or documented. None is set by hand without the script. |
| D-8 | Versions (§1 Stage 6: "confirm versions") | TypeScript 6.0 instead of the newest 7.0 | typescript-eslint peer range is < 6.1 | Upgrade when supported |
| D-9 | §3.5 Timeouts: default 2 s | Declared exceptions: intake `/v1/parse` 4 s; chat streaming (first token 3 s, total 15 s); PDFs and exports are async | Per NFR-7 and conventions R-5 | Declared in `x-timeout-ms` |
| D-10 | §1 Stage 7: **one task at a time** | **Decided (product owner, 2026-09-27): (b) service tracks run in parallel** with Claude agents per service, and work continues to delivery without stopping for questions (rules in `docs/06-questionnaire.md` §B) | Contract mocks (F-05) make services independent. You still approve each service with `APPROVED: <service>`, and each task still meets the full Definition of Done. | If (b): at most 3 service tracks in flight at once. The Foundation track is always done first and sequentially. |

## 5. Local prerequisites (checked on this machine, 2026-09-27)
| Tool | Needed | Found | Action |
|---|---|---|---|
| Node.js | 24.x LTS | 20.13.1 | **Upgrade** (e.g. `fnm install 24` or nvm). Task F-01 adds `.nvmrc` / `engines`. |
| pnpm | 12.x | not installed | `corepack enable` then `corepack prepare pnpm@12 --activate` |
| Docker | Any (for the Supabase local stack) | OrbStack ✔ | — |
| Supabase CLI | 2.118.x | not installed | Installed as a devDependency by F-06 |
| Vercel CLI | 60.x | not installed | Installed as a devDependency by F-07 |
| Terraform | 1.x | not installed | Install before F-07 (e.g. `brew install terraform`) |
| Git + GitHub remote | — | No remote yet | Create a private GitHub repo before F-03 (CI needs it) |

## 6. Definition of Done (every task in Stage 7)
From CLAUDE.md §5, with the project additions in *italics*:
- [ ] Matches the approved contract (OpenAPI / AsyncAPI) exactly. *CI drift check green.*
- [ ] Unit tests (domain), integration tests (adapters, against the Supabase local stack) and contract tests pass.
- [ ] Lint, type checks, import-layer checks (dependency-cruiser) and secret scan (gitleaks) pass.
- [ ] Logs, traces, metrics and health checks in place. *The PII-not-logged test passes.*
- [ ] *The tenant-isolation test passes (every service that touches tenant data).*
- [ ] Migrations are backward compatible (expand → migrate → contract).
- [ ] Service README updated (run locally, env vars, owned data, events).
- [ ] `docs/STATUS.md` updated with the task ID marked done.
- [ ] *The PR follows Conventional Commits and links the task ID.*
