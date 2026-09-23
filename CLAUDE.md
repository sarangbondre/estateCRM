# CLAUDE.md — Project Operating Rules

You are working on a project that must be scalable, event-driven, built as microservices,
and structured so each service can be owned by an independent developer.
Read this entire file before doing anything. These rules override your defaults.

---

## 0. PRIME DIRECTIVE: STAGE GATES (READ FIRST)

This project follows a strict 7-stage pipeline. You MUST follow these rules:

1. Work on ONE stage at a time, in order. Never skip or merge stages.
2. At the end of each stage, write the stage's documents, summarise them for the user, then STOP.
3. Do not start the next stage until the user replies with exactly: `APPROVED: Stage <N>`.
   Anything else ("looks good", "ok", "continue") is NOT approval. Ask for the exact phrase.
4. Before any action, read `docs/STATUS.md`. If it does not exist, create it and start at Stage 1.
5. After every approval, update `docs/STATUS.md` (stage, date, approved artifacts).
6. Approved documents are frozen. To change one, write a Change Request in
   `docs/change-requests/CR-<NNN>.md` (what, why, impact on later stages), and get it approved
   with `APPROVED: CR-<NNN>`. Then update the affected documents and re-seek approval of any
   later stage those changes touch.
7. NO implementation code (anything under `services/`, `infra/`, `libs/`) before Stage 7.
8. If requirements are ambiguous, ask the user. Never invent business rules silently;
   list every assumption explicitly in the stage document under "Assumptions".

### docs/STATUS.md format
```
Current stage: <N> — <name>
State: IN PROGRESS | AWAITING APPROVAL | APPROVED
| Stage | Status | Approved on | Artifacts |
Open change requests: <list>
```

---

## 1. THE PIPELINE

### Stage 1 — Business Requirements Document (BRD)
File: `docs/01-brd.md`
- Problem statement, target users, business goals
- Success metrics (measurable)
- In scope / out of scope
- Constraints (budget, timeline, compliance, regions)
- Assumptions and open questions
**Gate:** present summary → STOP → wait for `APPROVED: Stage 1`

### Stage 2 — Product Requirements Document (PRD)
File: `docs/02-prd.md`
- User roles and user stories with acceptance criteria
- Functional requirements, grouped by business area
- Non-functional requirements (defaults unless the user overrides):
  - Throughput: 1,000 requests/second sustained
  - Latency: p95 < 300 ms for synchronous APIs
  - Availability: 99.9%
  - Data: backups with point-in-time recovery, encryption at rest and in transit
- External systems the product must integrate with
- Assumptions and open questions
**Gate:** STOP → wait for `APPROVED: Stage 2`

### Stage 3 — High-Level Design (HLD)
File: `docs/03-hld.md` (+ `docs/adr/` for decisions)
Must contain:
- **Business capabilities** identified from the PRD
- **Service catalog**: for each proposed service:
  name, one-sentence responsibility, data it owns, APIs it exposes (list only),
  events it publishes, events it consumes, dependencies, owner placeholder
- **Justification for each service boundary** (see Section 2 rules)
- **Architecture diagram** (Mermaid): clients → gateway → services → data stores → event bus
- **Sequence diagrams** (Mermaid) for the 3–5 most critical flows, marking each hop sync or async
- **Data ownership map**: which service owns which data; how others obtain it
- **Consistency plan**: where eventual consistency is acceptable; sagas + compensating actions
  for multi-service workflows
- **External integrations**: provider, purpose, auth, rate limits, failure fallback
- **Deployment topology**: which services share infrastructure vs run isolated, and why
- **Hosting**: cloud, region, compute model, database engine and hosting model, event bus
- One ADR (`docs/adr/NNNN-title.md`) per significant decision (context, options, decision, consequences)
**Gate:** present the service catalog and diagrams clearly → STOP → wait for `APPROVED: Stage 3`

### Stage 4 — Low-Level Design (LLD)
Files:
- `contracts/openapi/<service>.yaml` — every sync endpoint
- `contracts/asyncapi/events.yaml` — every event
- `docs/04-lld/<service>.md` — per service: schema (tables, columns, types, keys, indexes with
  the query each index serves), PII fields, retention, internal module layout, error codes
- `docs/04-lld/data-hosting.md` — DB engine/version, instance class, Multi-AZ, backup/PITR,
  encryption, network placement, credential issuance, connection pooling
- `docs/04-lld/capacity-plan.md` — load math per service (RPS, latency, concurrency via
  Little's law), instance size and min/max count, DB connection budget, cache strategy,
  queue throughput, and the load test that will prove it

Every API endpoint must specify: method, path, auth, request schema, response schema,
error responses (RFC 7807), idempotency behaviour, pagination (for lists), rate limit, timeout.

Every event must specify: name (`<entity>.<past-tense-verb>.v<N>`), producer, consumers,
payload schema, ordering requirement, delivery guarantee.
**Gate:** present a table of all endpoints and all events → STOP → wait for `APPROVED: Stage 4`

### Stage 5 — Task Breakdown
File: `docs/05-tasks.md`
- Tasks grouped **per service**, so each service can be assigned to one developer
- Each task: ID, service, description, acceptance criteria, dependencies (task IDs), size (S/M/L)
- A shared foundation track first (repo scaffold, libs, CI, infra, local dev environment)
- Order tasks so services can be built in parallel against contract mocks
- Mark the critical path
**Gate:** STOP → wait for `APPROVED: Stage 5`

### Stage 6 — Implementation Rules Confirmation
File: `docs/06-implementation-rules.md`
- Confirm language, framework, libraries, versions, and tooling for this project
- Record any project-specific deviations from Section 3 of this file, with justification
- Definition of Done checklist (see Section 5)
**Gate:** STOP → wait for `APPROVED: Stage 6`

### Stage 7 — Execution
- Execute tasks in the order approved in Stage 5. One task at a time.
- For each task: implement → test → verify against contracts → update `docs/STATUS.md`
  with the task ID marked done.
- After each service is complete, STOP and summarise: what was built, test results,
  contract compliance. Wait for `APPROVED: <service-name>` before starting the next service.
- If implementation reveals a design flaw, STOP and raise a Change Request. Never silently
  diverge from approved contracts or schemas.
- Final gate: the load test must meet the Stage 2 NFRs on the Stage 4 instance sizes.
  Report results and wait for `APPROVED: Release`.

---

## 2. SERVICE BOUNDARY RULES (used in Stage 3)

- Split services by **business capability** (e.g. Identity, Catalogue, Ordering, Payments),
  never by database table, entity, or technical layer.
- Start coarse: propose the smallest number of services that gives clear ownership
  (typically 3–6). A split must be justified by a different business owner, a different
  rate of change, different scaling needs, or a different compliance boundary.
- If two services would always change together, merge them.
- Each service must be buildable, testable, and deployable by one developer without
  changes in any other service.
- FORBIDDEN: a service per entity; a "shared" or "common" service holding business logic;
  synchronous call chains deeper than 2 hops.

---

## 3. ENGINEERING GUARDRAILS (apply in Stage 7)

### 3.1 Code design — SOLID and Dependency Inversion
- Layering inside each service: `domain` → `application` → `adapters`.
  - `domain`: pure business logic. No framework, ORM, SDK, or I/O imports.
  - `application`: use cases. Depends only on interfaces (ports) defined in domain/application.
  - `adapters`: DB, HTTP, messaging, external APIs. Implements the ports.
- Concrete dependencies are wired only at the composition root (app startup).
- One reason to change per class. Prefer composition over inheritance. Keep functions small.
- Layer boundaries are enforced by an import linter in CI.

### 3.2 Data
- Each service owns its data exclusively: its own database (or schema) and its own DB user.
  No other service reads or writes it. No cross-service joins.
- Other services get data only via the owner's API or events.
- Migrations live inside the owning service and are backward compatible:
  expand → migrate → contract. Never rename or drop a column in a single deploy.
- Every query path has an index. No N+1 queries. No unbounded queries.
- Use connection pooling (proxy/pooler in front of the DB); pool sizes come from the capacity plan.

### 3.3 APIs
- Contract-first: update the OpenAPI spec before the code. CI fails on drift.
- Version every route (`/v1/...`). Validate all input at the edge.
- Mutating POST endpoints accept an `Idempotency-Key` header.
- List endpoints use cursor pagination with a max page size.
- Errors use RFC 7807 with a stable error code and the correlation ID.

### 3.4 Events
- Publish via the **transactional outbox** (event written in the same DB transaction as
  the state change; a relay publishes it). Never publish directly after commit.
- Every event carries: `event_id`, `event_type`, `schema_version`, `occurred_at`,
  `correlation_id`, `producer`.
- Consumers are idempotent (dedupe on `event_id`) and tolerate out-of-order delivery.
- Every consumer queue has a dead-letter queue with an alarm.
- Schema changes are additive only. Breaking change = new version, both run in parallel
  until consumers migrate.

### 3.5 Resilience
- Every outbound call: timeout (default 2 s), retry with exponential backoff + jitter
  (max 3, only for idempotent operations), circuit breaker.
- Slow work (email, file generation, calls > 500 ms) goes through a queue, never the request path.
- Each external integration has a documented fallback behaviour.

### 3.6 Scalability
- Services are stateless. Sessions, locks, files live in Redis / object storage / DB.
- Horizontal scaling only: minimum 2 instances per service, autoscale on CPU/latency.
- Cache reads where the capacity plan requires it; cache is never the source of truth.
- Use read replicas for read-heavy services where the capacity plan requires it.
- All configuration via environment variables and a secrets manager.

### 3.7 Observability
- Structured JSON logs with a correlation ID propagated through HTTP headers and events.
- Distributed tracing (OpenTelemetry) in every service.
- RED metrics (rate, errors, duration) per endpoint and per consumer; alarms on SLOs.
- `/health/live` and `/health/ready` endpoints on every service.

### 3.8 Security
- Databases and internal services in private networks. Least-privilege IAM and DB users.
- Secrets only in a secrets manager; secret scanning in CI.
- PII fields marked in the LLD and never logged.
- Auth validated at the gateway; services re-check authorization for their own resources.

### 3.9 Independent development
- Each service has its own folder, Dockerfile, test suite, CI pipeline, and version.
- A service can be deployed alone at any time without coordinating with other services.
- Each service can run locally alone, with dependencies replaced by contract-based mocks.
- `CODEOWNERS` maps each service folder to its owner.
- `libs/` contains shared infrastructure code only (logging, tracing, outbox, auth helpers).
  Never shared domain models.

### 3.10 Infrastructure
- All infrastructure as code under `infra/`. No manual console changes.
- Separate environments: local, dev, staging, production. Same artefact promoted across them.

---

## 4. REPOSITORY LAYOUT

```
CLAUDE.md
CODEOWNERS
docs/
  STATUS.md
  01-brd.md
  02-prd.md
  03-hld.md
  04-lld/<service>.md, data-hosting.md, capacity-plan.md
  05-tasks.md
  06-implementation-rules.md
  adr/
  change-requests/
  runbooks/
contracts/
  openapi/<service>.yaml
  asyncapi/events.yaml
services/<service>/
  src/domain/  src/application/  src/adapters/
  migrations/  tests/  Dockerfile  README.md
libs/
infra/
loadtests/
.github/workflows/
```

---

## 5. DEFINITION OF DONE (every task in Stage 7)

- [ ] Matches the approved contract (OpenAPI / AsyncAPI) exactly
- [ ] Unit tests (domain), integration tests (adapters), contract tests pass
- [ ] Lint, type checks, import-layer checks, secret scan pass
- [ ] Logs, traces, metrics, and health checks in place
- [ ] Migrations are backward compatible
- [ ] Service README updated (run locally, env vars, owned data, events)
- [ ] `docs/STATUS.md` updated

---

## 6. WHEN IN DOUBT
Stop and ask the user. A question costs minutes; a wrong assumption costs days.
