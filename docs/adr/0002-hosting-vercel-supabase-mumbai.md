# ADR-0002: Phase 1 on Vercel + Supabase (Mumbai), AWS later

- Status: Accepted (Stage 3 approved 2026-09-24)
- Date: 2026-09-24

## Context
The product owner wants Phase 1 on Vercel and a later move to AWS. BRD A-10 requires data in India. The PRD needs
30-minute bulk jobs, per-minute schedules, 1,000 rps and PITR backups.

## Options
1. Vercel for the UI + AWS for the backend. Rejected by the product owner for Phase 1.
2. **Vercel (bom1) + Supabase (ap-south-1)** for Postgres, Storage, Auth and pgmq queues.
3. Vercel + other serverless vendors (Neon, Upstash). Rejected: Mumbai region availability is uncertain, and it means more vendors.

## Decision
Option 2. Every service is a Vercel project in `bom1`. All state lives in one Supabase project per environment in Mumbai.

## Consequences
- Low cost, fast start, data at rest in India.
- **Deviations from CLAUDE.md** (HLD §10.1): no private network, secrets in Vercel env, serverless instead of min 2
  instances. They are mitigated and are revisited in Stage 6.
- Vercel logs may be stored outside India. The **never-log-PII** rule (CLAUDE.md §3.8) makes this acceptable.
- **Migration path:**
  - Schemas move to RDS/Aurora per service (pg_dump by schema).
  - pgmq is replaced by SQS/SNS behind the same outbox relay interface in `libs/`.
  - Storage moves to S3.
  - Functions move to Fargate/Lambda.
  - Event contracts and APIs are unchanged, so services migrate one at a time.
