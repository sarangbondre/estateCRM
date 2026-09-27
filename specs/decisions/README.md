---
type: Guide
---

# Architecture Decision Records

> Lightweight ADRs — one file per decision, append-only once accepted.
>
> **This project keeps its ADRs in `docs/adr/`** (CLAUDE.md §4). The index below links there, and they are not duplicated here.

## Index

| ID | Title | Status | Date |
|----|-------|--------|------|
| [0000](0000-template.md) | ADR Template | template | — |
| [0001](../../docs/adr/0001-service-boundaries.md) | Six capability services plus an edge BFF (CRM Engine) | accepted | 2026-09-24 |
| [0002](../../docs/adr/0002-hosting-vercel-supabase-mumbai.md) | Phase 1 on Vercel + Supabase (Mumbai), AWS later | accepted | 2026-09-24 |
| [0003](../../docs/adr/0003-event-bus-outbox-pgmq.md) | Transactional outbox + pgmq as the event bus | accepted | 2026-09-24 |
| [0004](../../docs/adr/0004-ai-rules-first-redaction.md) | AI: rules first, redaction, Hugging Face models; the model plans, the service executes | accepted | 2026-09-24 |
| [0005](../../docs/adr/0005-bulk-upload-chunked-fanout.md) | Large uploads: direct-to-storage + chunked fan-out | accepted | 2026-09-24 |
| [0006](../../docs/adr/0006-schema-per-service.md) | One Postgres cluster, a schema and role per service | accepted | 2026-09-24 |
| [0007](../../docs/adr/0007-chat-first-bff.md) | Chat-first web app as BFF; actions via owning services | accepted | 2026-09-24 |
| [0008](../../docs/adr/0008-free-tier-pilot.md) | Phase 1a on free plans with a paid-plan gate | accepted | 2026-09-24 |

## Process

1. Copy `0000-template.md` → `NNNN-short-title.md`
2. Fill in context, options, and decision
3. Add a row to the index above
4. Add affected topics to the `impact-map.md` table

## Status Values

| Status | Meaning |
|--------|---------|
| `proposed` | Under discussion |
| `accepted` | Decided, in effect |
| `superseded` | Replaced by a later ADR |
| `deprecated` | No longer applicable |
