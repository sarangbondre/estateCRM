# ADR-0008: Phase 1a on free plans with a paid-plan gate

- Status: Accepted (Stage 3 approved 2026-09-24)
- Date: 2026-09-24

## Context
The product owner wants free plans everywhere for now (Vercel Hobby, Supabase Free, Hugging Face free credits). The free
plans can't meet the approved NFRs (PITR backups, 99.9%, 1M rows/day, 5M records), and Vercel Hobby is limited to
personal, non-commercial use.

## Decision
- Build and run a **Phase 1a pilot** on free plans with **sample or anonymised data** and internal testing only. The
  pilot limits and relaxations are in CR-005.
- Scheduling uses **Supabase pg_cron + pg_net** (every minute), not Vercel Cron (daily-only on Hobby).
- Uploads use 500-row chunks to fit the Hobby function limits.
- Nightly `pg_dump` per schema as the backup.
- A keep-alive ping stops Supabase pausing the project.
- **Paid-plan gate** before real 11 Estates data, real users, or the website going live:
  1. Vercel Pro (bom1).
  2. Supabase Pro + PITR (Mumbai).
  3. A dedicated Hugging Face endpoint.
  4. Restore the NFRs.
  5. Re-run the load test (Stage 7 final gate).

## Consequences
- Near-zero cost while building. The same code runs on paid plans; only configuration changes (chunk size, concurrency, limits).
- Until the gate is passed, the system is **not production**. Vercel's terms and the lack of backups make real
  business use a risk the product owner must not take.
