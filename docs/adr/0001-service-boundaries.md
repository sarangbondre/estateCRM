# ADR-0001: Six capability services plus an edge BFF

- Status: Accepted (Stage 3 approved 2026-09-24)
- Date: 2026-09-24

## Context
CLAUDE.md requires microservices split by business capability (3–6), each buildable and deployable alone. PRD v0.5 has
six capabilities: intake, records, journeys, matching, publishing, insight.
The matching service is named **CRM Engine** (`crm-engine`), the brain of the CRM (product owner, 2026-09-24). There is a single builder (Sarang + Claude).

## Options
1. **Six services** (intake, records, journeys, crm-engine, listings, insight) + web BFF.
2. Five: merge crm-engine into journeys.
3. Four: also merge intake into records.
4. A modular monolith. Rejected: it breaks CLAUDE.md and BRD §12 ("event driven microservices").

## Decision
Option 1, **confirmed by the product owner (all six)**, with options 2 and 3 as pre-agreed merge paths if running six services is a burden. Each merge keeps
module boundaries, so it can be split again.

## Consequences
- Clear ownership, and separate scaling for batch intake, the CPU-heavy CRM Engine and public listings.
- Seven deployables and CI pipelines to maintain. This is manageable on Vercel (no idle cost) with shared `libs/` for
  outbox, auth and logging.
- The event contracts (Stage 4) become the main integration surface and must be designed carefully.
