# 04 — Low-Level Design (Stage 4): index

| | |
|---|---|
| Version | 0.1 |
| Date | 2026-09-24 |
| Based on | BRD v0.6.1, PRD v0.6, HLD v0.2 (all approved) |
| Status | AWAITING APPROVAL |

## Contents
| Deliverable | File |
|---|---|
| Shared conventions and reconciliation decisions R-1…R-22 | [conventions.md](conventions.md) |
| Event contract: 68 events (AsyncAPI 3.0, generated) | [../../contracts/asyncapi/events.yaml](../../contracts/asyncapi/events.yaml) · table: [events-table.md](events-table.md) · generator: `tools/gen_events.py` |
| API contracts: 240 operations (OpenAPI 3.1) | `contracts/openapi/{web,intake,records,journeys,crm-engine,listings,insight}.yaml` + `_common.yaml` · table: [endpoints-table.md](endpoints-table.md) · generator: `tools/gen_gate_tables.py` |
| Per-service LLDs (schema, indexes with their queries, rules, events, errors, PII, retention, module layout) | [web](web.md) · [intake](intake.md) · [records](records.md) · [journeys](journeys.md) · [crm-engine](crm-engine.md) · [listings](listings.md) · [insight](insight.md) |
| Data hosting | [data-hosting.md](data-hosting.md) |
| Capacity plan and load test | [capacity-plan.md](capacity-plan.md) |

## Verification done
- All 8 OpenAPI files and the AsyncAPI file parse. The OpenAPI files pass OpenAPI 3.1 validation (checked by the drafting agents).
- All **240 operations** declare security, roles, rate limit, timeout, idempotency, emitted events and RFC 7807 errors. Lists
  use cursor pagination (max 100; 50 on the public Listings API).
- Every emitted or consumed event exists in the catalogue. Every event appears in its producer's and each consumer's LLD.
- Every table index is listed with the query it serves (LLD §3 of each service).

## Decisions taken during Stage 4 (for your awareness)
The conventions (§10) record R-1…R-22. The ones that touch product behaviour:
- **R-8:** a photo with text on it is a warning, not a block (as the PRD says).
- **R-9:** records from an unknown city count as Mumbai when the ad came from a Mumbai edition. Otherwise they go to review.
- **R-10:** extractor rows start at "Enriched". Quick add starts at "Captured", or "Contacted" if entered during a call.
- **R-11:** controlled values are matched ignoring case and spaces. Inverted ranges (min > max) are rejected.
- **R-12:** a demand open to several deal types ages on the shortest life curve. A retired offer can be revived by a confirmed call.
- **R-14:** an unknown area basis gets ±25% tolerance and a flag, with no conversion between carpet and built-up.
- **R-16:** exports are capped at 20,000 rows in the pilot and 100,000 in production.
- **R-17:** chat conversations are private to their author. Actions taken through chat are audit-logged.
- Contact details are **masked by default** in the app. Showing a full phone number or unit is an explicit, audit-logged
  "reveal" (records `POST /v1/reveals`, 60 per hour per user).
- **Staff edits win:** a later extractor upload never overwrites a field someone changed by hand.
- A split record keeps its CRM work on the first child when the extractor re-splits an ad.

## Questions for the product owner
| # | Question | Default if you don't mind |
|---|---|---|
| Q4-1 | **2-step sign-in:** should staff use Google Workspace accounts (so 2-step verification can be enforced), or personal Gmail with 2-step as a policy only? | Google Workspace for 11 Estates staff |
| Q4-2 | May **Data operators** export contact columns? | No (Admins, Managers and agents only) |
| Q4-3 | Proposal feedback options: liked / rejected / visit requested. Add "maybe"? | Add "maybe" |
| Q4-4 | Fake phone format for the pilot anonymiser: `+91 00000 xxxxx` (never a real number) | As proposed |

## Items to verify at provisioning (Stage 5 foundation tasks, from data-hosting §7)
- Supabase standby/failover versus the 99.9% target (may need a CR).
- The connection limit per compute size.
- pgmq, pg_cron and pg_net on the Free plan in Mumbai.
- The Hugging Face endpoint region.

## Minor open items (don't block approval; resolved during implementation)
- A person-purge event for retention (`person.purged.v1`, journeys G-6).
- The developer name on public projects is now in `project.*` events.
- Digi (lead-form) exports in mapping mode need extra optional fields (campaign/listing refs, photo URLs): intake Q-I3.
- The keys for demand must-haves (`parking`, `amenity:<name>`): crm-engine C-10.
- `publicDescriptionSource` is not used in Phase 1. Public descriptions are generated from fields (listings OQ-L4).
