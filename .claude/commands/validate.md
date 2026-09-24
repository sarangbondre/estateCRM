Check the spec structure health of the current momentum project.

Run with no arguments for a fast index-first check, or pass `--deep` for a full scan.

> **Which phase is yours (Rule 15):** the phase bound to your branch;
> `status.md` is the fallback and the cross-lane overview. Validation checks
> the whole board, not just your lane.

## Default Mode (index-first)

1. Read `specs/status.md` — verify required fields are present:
   - `Last Updated`, `Current Phase`, `Latest Release`, `Health`
   - Active Phase table exists. **"No active phase" is a VALID state** — a
     single row reading `_(none)_` / `no active phase` (e.g. between phases, or
     during ad-hoc `/hotfix` work) is NOT a failure. **Multiple rows are also
     valid** — one row per active lane (Rule 15, concurrent workstreams). Only
     flag a structurally missing/empty table.
   - Report any missing fields as failures

2. Read `specs/backlog/backlog.md` — verify all 4 section tables present:
   - Bugs, Features, Tech Debt, Enhancements
   - Report any missing table as a failure

2b. Founded state (`core/project-lifecycle.md`, ADR-0008):
   - founded ⟺ `specs/vision/project-charter.md` AND
     `specs/planning/roadmap.md` both exist
   - Phase directories exist under `specs/phases/` while NOT founded →
     FAILURE: "phase work exists but the project is not founded — run
     `/start-project` to author the foundation docs"
   - Not founded with no phase directories is the VALID Installed state —
     report informationally ("not founded yet — `/start-project` when
     ready"), never as a failure
   - founded AND no `specs/project-rules.md` (ADR-0010) → WARNING: "project
     rules surface missing — run `momentum upgrade` to create it; every agent
     instruction file's `## Project Extensions` pointer expects it"

2c. Config (ADR-0009) — WARNING, never a failure (recipes fall back to
    npm/GitHub defaults when absent):
    - founded AND no `specs/config.md` → WARNING: "config not set
      — recipes will use npm/GitHub defaults; run `momentum upgrade` to
      infer them, or author at `/start-project`"
    - `specs/config.md` exists → drift check: compare the
      machine-inferable fields (`language`, `framework`, `publish_target`,
      `git_forge`) against the manifests + `git remote get-url origin`
      (`core/config.js` → `inferConfig('.')` vs
      `readConfig('specs')`); on mismatch → WARNING: "config
      drifted from manifests on: <fields> — edit by hand or delete the file
      + re-run `momentum upgrade`"
    - Not founded → skip (config author at founding)

3. For each phase directory under `specs/phases/` (OKF bundle, ADR-0005):
   - Verify all 4 files present: `overview.md`, `plan.md`, `tasks.md`, `history.md`
   - Verify `overview.md` frontmatter carries `type: Phase` and a `status:`
     (legacy projects may still have `specs/phases/index.json` instead —
     recommend `momentum upgrade` to migrate)
   - Report missing files or missing status frontmatter as failures

4. Cross-check active phase consistency:
   - If an active phase is named, its directory must exist and its
     `overview.md` frontmatter must say `status: in-progress` — report
     mismatch as a failure. With multiple active lanes (Rule 15), check EVERY
     row: each row's branch must bind to an existing phase directory.
   - If `Current Phase` is "none" / no active phase, **skip this check** (valid
     between-phases state).

4b. OKF conformance (delegates to the CLI):
   - Run `momentum okf check` — report its violations as failures verbatim
   - Run `momentum okf index` if listings are stale (safe — regenerates only
     `specs/index.md`, `specs/phases/index.md`, `specs/decisions/index.md`)

5. Check `.claude/commands/` for standard momentum commands:
   - Required: `brainstorm-idea`, `brainstorm-phase`, `start-project`, `start-phase`,
     `complete-phase`, `log`, `sync-docs`, `track`, `migrate`, `validate`, `hotfix`
   - Report any missing commands as warnings (not failures — project may predate them)

6. Report results:
   ```
   ✓ N checks passed
   ✗ N issues found:
     - specs/phases/phase-3-gap-fixes/overview.md: missing `status:` frontmatter
     - specs/status.md: missing field "Latest Release"
   ```

## `--deep` Flag (full scan)

Run all default mode checks, then additionally:

7. Walk ALL directories under `specs/phases/` — flag any directory whose
   `overview.md` lacks `status:` frontmatter as an untracked phase

8. For each phase directory, read `tasks.md`:
   - Extract all backlog ID references: `BUG-NNN`, `FEAT-NNN`, `TD-NNN`, `ENH-NNN`
   - Verify each ID exists as a row in `specs/backlog/backlog.md`
   - Report unresolved IDs as failures

9. For each phase directory, read `history.md`:
   - Verify each entry has all required fields: type tag `[TYPE]`, date in `YYYY-MM-DD`
     format, `Topics:`, `Affects-phases:`, `Affects-specs:`, `Detail:`
   - Report malformed entries (missing fields) as warnings

10. Check `specs/changelog/` — for each phase whose `overview.md` frontmatter
    says `status: complete`, verify at least one changelog file exists under
    `specs/changelog/`
    - Report completely absent changelog as a warning

11. Swarm member integrity (Phase 17+, only when ecosystem context exists):
    - For each `<ecosystem-root>/swarms/<id>/manifest.json`:
      - Validate against `core/swarm/schema/manifest.schema.json` (load + structural check)
      - Every `manifest.repos.<id>` must reference a real `ecosystem.json` member
      - Each repo's `phase_slug` must point at an existing phase directory
        in that member repo
    - For every phase brief that carries swarm frontmatter (parsed via
      `core/swarm/lib/brief.js`):
      - `swarm:` must resolve to a real swarm manifest at the ecosystem root
      - `wave:` must match the wave that swarm has assigned this repo
      - `initiative:` must match the swarm manifest's `initiative` field
      - Report mismatch as a failure
    - For every swarm with `status: complete`, verify the initiative's
      `Per-repo contributions` section lists all swarm members.
    - Report unresolved swarm references as failures; report orphaned
      brief frontmatter (swarm: refers to non-existent swarm) as failures.

12. Append deep-scan results to the report before printing.
