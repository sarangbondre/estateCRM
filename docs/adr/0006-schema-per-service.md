# ADR-0006: One Postgres cluster, a schema and role per service

- Status: Accepted (Stage 3 approved 2026-09-24)
- Date: 2026-09-24

## Context
CLAUDE.md §3.2 requires each service to own its data exclusively (its own database or schema, and its own DB user). The
budget is balanced (H-4) and hosting is Supabase.

## Options
1. **One Supabase Postgres per environment, a schema + login role per service, grants only on its own schema.**
2. One Supabase project per service. Seven times the cost and ops.

## Decision
Option 1.
- Roles have no access to other schemas.
- Migrations live in each service (`services/<svc>/migrations`) and follow expand → migrate → contract.
- The public `pgmq` schema is reachable only through queue functions, with per-queue grants.
- Supabase's auto-generated REST API (PostgREST) is **disabled** for service schemas.

## Consequences
- Low cost, simple operations, and clear ownership enforced by the database.
- There's a noisy-neighbour risk (intake bursts). This is mitigated by the chunk concurrency cap and pooler limits per
  role, set in the Stage 4 capacity plan.
- A schema can move to its own cluster or RDS later without code changes (only the connection string changes).
