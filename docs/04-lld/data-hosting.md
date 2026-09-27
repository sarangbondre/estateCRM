# 04 — LLD: Data hosting

| | |
|---|---|
| Version | 0.1 (draft) |
| Date | 2026-09-24 |
| Based on | HLD v0.2 (§9, §10, ADR-0002/0003/0006/0008), PRD v0.6 §8 (incl. §8.4 pilot), BRD A-10 (CR-004) |

## 1. Summary
| Item | Phase 1a pilot (free plans, CR-005) | After the paid-plan gate (production) |
|---|---|---|
| Engine | Supabase-managed **PostgreSQL** (major version pinned at project creation, 15 or later) | Same |
| Region | `ap-south-1` Mumbai | `ap-south-1` Mumbai |
| Plan / instance | Supabase **Free** (shared "Nano" compute, 500 MB database, 1 GB storage) | Supabase **Pro**, compute add-on **Small** at launch → **Medium** when the capacity triggers in §6 fire |
| Availability | Single instance, best effort; the project pauses after ~7 days idle, so a keep-alive ping runs every 12 h | Single primary. **High availability (standby / failover) must be confirmed against the Supabase plan at provisioning.** If Pro doesn't include a standby, NFR-3 (99.9%) needs a higher tier, or an accepted exception via CR. See §7. |
| Backups | Nightly `pg_dump` per schema (§4) | Supabase daily backups + **PITR add-on** (RPO ≤ 5 min, NFR-17) |
| Encryption at rest | Supabase-managed disk encryption (AES-256) | Same |
| Encryption in transit | TLS enforced ("SSL enforcement" on); clients use `sslmode=require` | Same |
| Network | Public endpoint + TLS. IP allow-listing isn't possible with Vercel's dynamic egress (HLD §10.1 deviation). | Same until Vercel Secure Compute or the AWS move |
| Pooling | **Supavisor**, transaction mode (port 6543), per-role caps (§5) | Same, larger caps |
| Object storage | Supabase Storage buckets (private) in the same project | Same |
| Queues | `pgmq` extension in the same database (ADR-0003) | Same |
| Scheduler | `pg_cron` + `pg_net` in the same database | Same |

## 2. Database layout
One Supabase project per environment:

| Environment | Project | Plan |
|---|---|---|
| local | Supabase CLI (Docker) | — |
| pilot (dev, and the demo during Phase 1a) | `11e-crm-pilot` | Free |
| staging (after the gate) | `11e-crm-staging` | Pro, smallest compute |
| production (after the gate) | `11e-crm-prod` | Pro + PITR |

Free plans allow two projects per organisation, so during Phase 1a only `pilot` exists alongside local.

Schemas (ADR-0006): `web`, `intake`, `records`, `journeys`, `crm_engine`, `listings`, `insight`. Plus the extension schemas
`pgmq`, `cron` and `net`, and Supabase's own `auth` and `storage`.

**Hardening at creation:**
- Exposed schemas for the Data API (PostgREST) are set to **none** (the default `public` schema is removed from exposure).
  Services connect only with their own roles.
- `anon` and `authenticated` roles get no grants on service schemas. Supabase Auth is used only by web for sign-in.
- `public` schema: `REVOKE CREATE ON SCHEMA public FROM PUBLIC`.

## 3. Roles and credentials
| Role | Kind | Rights |
|---|---|---|
| `<svc>_owner` (e.g. `records_owner`) | NOLOGIN; owns the schema and its objects | DDL on its schema only |
| `<svc>_migrator` | LOGIN; member of `<svc>_owner` | Runs migrations in CI. Password only in the CI secret store for that service. |
| `<svc>_svc` | LOGIN; runtime | `USAGE` on its schema; `SELECT, INSERT, UPDATE, DELETE` on its tables; `USAGE` on its sequences; `EXECUTE` on `pgmq.send`, `pgmq.read`, `pgmq.archive`, `pgmq.delete` **for its own queues only** (through wrapper functions in its schema that hard-code the queue names) |
| `relay_invoker` | NOLOGIN; used by pg_cron jobs | `EXECUTE` on `net.http_post` only |

- Runtime credentials live in each Vercel project's **encrypted environment variables** (HLD §10.1 deviation from "secrets manager").
  One variable per service: `DATABASE_URL` pointing at the pooler with the `<svc>_svc` user.
- **Rotation:** every 90 days and on any suspected leak. Set a new password → update the Vercel env → redeploy → drop the
  old one. It's scripted in `infra/` (Stage 7).
- The Supabase `service_role` key is **not** given to any service. It's used only by the web app for Supabase Auth admin
  calls (invites), stored in web's Vercel env.

## 4. Backups and restore
| | Pilot | Production |
|---|---|---|
| What | `pg_dump --schema=<svc>` for each of the 7 schemas + `pgmq` queue tables, nightly 01:30 IST | Supabase daily backups + PITR |
| Where | A **private Supabase Storage bucket `backups`** in the same Mumbai project (keeps data in India, BRD A-10). The dump runs as a scheduled GitHub Actions job. Pilot data is anonymised (CR-006 Z-9), so the runner's location isn't a residency issue. | Supabase managed |
| Retention | 14 days rolling | Per plan (7 days of PITR at minimum) |
| Restore test | Monthly: restore into local and run the smoke tests | Quarterly restore drill into staging (RTO ≤ 1 h target) |

Storage buckets (files: uploads, photos, PDFs, exports) aren't covered by `pg_dump`. Uploads are reproducible from the
extractor master. Photos are backed up by a weekly bucket sync in production (Stage 5 task).

## 5. Connection pooling
- All runtime traffic goes through **Supavisor transaction mode**. Prepared statements are disabled in the DB client (a
  transaction-mode requirement).
- **Per-role caps** are enforced twice: `ALTER ROLE <svc>_svc CONNECTION LIMIT n`, plus an in-process semaphore in the DB
  adapter (a `libs/` component) so a function waits briefly instead of failing when the cap is reached.

| Role | Pilot cap | Production cap (Small) | Production cap (Medium) | Why |
|---|---|---|---|---|
| `listings_svc` | 4 | 20 | 30 | Public API, highest request rate (capacity plan §3) |
| `records_svc` | 6 | 16 | 24 | OLTP + ingest drains |
| `intake_svc` | 5 | 12 | 16 | Chunk workers (one connection per worker) |
| `crm_engine_svc` | 4 | 12 | 16 | Batch scoring |
| `journeys_svc` | 4 | 10 | 14 | Queues, life-curve job |
| `insight_svc` | 3 | 6 | 10 | Dashboards, chat plans, exports |
| `web_svc` | 3 | 6 | 8 | Users, audit sink, rate limits |
| pg_cron / pg_net, migrations, admin | 3 | 8 | 12 | Headroom |
| **Total** | **32** | **90** | **130** | Must stay under the instance's direct-connection limit, checked at provisioning |

## 6. Capacity triggers (move Small → Medium, or add a read replica)
- CPU > 70% for 15 minutes on 3 days in a week, or
- p95 of any NFR-2 route > 250 ms caused by the database (traces), or
- Database size > 70% of the plan disk, or
- Pool wait p95 > 50 ms on any role.

A read replica is considered only for `listings` and `insight` read paths, if a trigger fires and caching (capacity plan
§4) doesn't fix it.

## 7. Items to confirm at provisioning (not blocking Stage 4)
1. **Standby and failover** on the chosen Supabase plan versus NFR-3 (99.9%). If they aren't included, choose between
   upgrading the tier and a CR accepting the Supabase platform SLA for Phase 1b.
2. **Direct-connection limit** per compute size (the table in §5 assumes Small ≈ 90 and Medium ≈ 120+).
3. Whether **`pgmq`, `pg_cron` and `pg_net`** are available on the Free plan in `ap-south-1`. They're standard Supabase
   extensions, but this is verified during the Stage 7 foundation task.
4. **Hugging Face endpoint region.** Record the region actually used (CR-004 allows outside India for redacted text only).

These are recorded as Stage 5 foundation tasks with explicit checks. A failure raises a CR.

## 8. Data residency checklist (BRD A-10 as amended by CR-004)
| Data | Location |
|---|---|
| All tables, queues, files, backups (pilot and production) | Supabase `ap-south-1` Mumbai |
| Function execution | Vercel `bom1` Mumbai |
| Logs | Vercel logs may be stored outside India. **Logs contain no PII** (conventions §7). |
| AI inference | Hugging Face. **Redacted text only.** Region per §7.4. |
| Sign-in | Google (identity only, no CRM data) |
