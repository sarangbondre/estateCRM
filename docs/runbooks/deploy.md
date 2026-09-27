# Deploy a service

Each service is its own Vercel project (region `bom1`) and deploys alone (CLAUDE.md §3.9). The same commit is promoted
across environments (§3.10).

## Normal path (merge to main)
1. The PR is green: `ci / <service>` (lint, layers, typecheck, tests, build), `contracts` (no drift), `libs`,
   `db-platform`, `secret-scan`.
2. **Migrations first (expand).** A migration must work with the code that is currently live
   (expand → migrate → contract). Run it before the new code goes live:
   ```bash
   MIGRATOR_DATABASE_URL=… pnpm --filter @11e/<service> exec 11e-migrate --schema <schema> --dir migrations
   ```
   Use a direct (session) connection with the `<schema>_migrator` role. The runner holds a per-schema advisory lock,
   so two runs can't collide. It refuses edited or destructive files (see `libs/db/README.md`).
3. Merge the PR. Vercel builds the service's project from `services/<service>` and deploys it to production.
4. Check:
   - `GET /health/ready` returns 200 (DB reachable, migrations not behind).
   - `node infra/scripts/dlq.mjs list` shows DLQ depth 0.
   - `select * from platform.alarm_events where status = 'firing'` returns nothing new.
   - `select * from platform.invocations i join net._http_response r on r.id = i.request_id where i.service = '<service>' order by i.invoked_at desc limit 5`
     shows 2xx relay and drain calls.
5. If this deploy ships a vocabulary release (records), poke `POST /internal/v1/jobs/activate-vocabulary` (cron secret).

## Contract changes
- Additive only (new optional fields, new endpoints, new event versions). Update `contracts/` first, run
  `pnpm contracts:gen`, and commit the generated files; CI fails on drift.
- A breaking change is a new version (`/v2`, `*.v2` event). The old and new versions run side by side until every
  consumer has moved. That is a CR (CLAUDE.md §0 rule 6).

## Enabling scheduled calls for a new environment
Only after every service in the environment is deployed and `/health/ready` is 200: run
`infra/scripts/configure-environment.mjs` with `SCHEDULES=on` (provisioning.md §6).
