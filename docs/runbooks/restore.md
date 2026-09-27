# Restore

## Pilot (free plan): nightly encrypted dumps
- **What's backed up:** every service schema (tables, data, owners and grants) and the pending queue messages, nightly at
  01:30 IST. Files go to the private `backups` bucket in the same Mumbai project, encrypted (AES-256, `BACKUP_PASSPHRASE`),
  kept 14 days (`.github/workflows/backup.yml`, `infra/scripts/backup.sh`).
- **Not in the dump:** Storage files (uploads can be re-created from the extractor master; photos are re-fetched), Vault
  secrets, and the scheduler config (`configure-environment.mjs` re-creates it).
- **Monthly check:** `.github/workflows/restore-check.yml` restores the latest backup into a throwaway database on the
  runner and runs the platform verifier. A failed check is treated like a failed backup: fix it within the week.

### Restore into a scratch/local database (always first)
```bash
pnpm db:start                       # throwaway local stack with the platform bootstrap
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… BACKUP_PASSPHRASE=… \
  bash infra/scripts/restore.sh latest postgresql://postgres:postgres@127.0.0.1:54322/postgres
```
Check the data (counts, a few known records) before touching a live environment.

### Restore the pilot itself (data loss or corruption)
1. Stop writes: set every service's scheduler off (`configure-environment.mjs` with `SCHEDULES=off`), and put web in
   maintenance (Vercel: promote a maintenance deployment, or pause the project).
2. Restore only the schemas that need it, from the chosen stamp:
   `bash infra/scripts/restore.sh <stamp> "$PILOT_ADMIN_DATABASE_URL" records journeys`.
   Each schema is restored in one transaction (`--clean`), and queue messages are replaced by the backup's.
3. Run `infra/scripts/verify-platform.mjs` against the pilot, bring the services back, re-enable schedules, and check
   the alarms.
4. Consumers downstream of a restored schema may hold newer projections. Run each consumer's reconcile job
   (`projection-reconcile`, `rollup-reconcile`, `reconcile-counters`) to converge.

## Production (after the paid gate)
Supabase daily backups + **PITR** (RPO ≤ 5 min). Restore through the Supabase dashboard to a new project first, verify,
then switch. Quarterly drill into staging with a target RTO ≤ 1 h (data-hosting §4).
