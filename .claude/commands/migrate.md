Onboard an existing project with a manual or outdated momentum-like structure into proper momentum format.

This command fills gaps without overwriting anything the project already has.

## Steps

1. **Detect existing structure** — scan for what momentum expects vs what is present:

   | Item | Expected path | Present? |
   |------|--------------|---------|
   | Spec root | `specs/` | |
   | Status file | `specs/status.md` | |
   | Backlog | `specs/backlog/backlog.md` | |
   | Bundle root | `specs/index.md` (OKF, `okf_version`) | |
   | Decisions dir | `specs/decisions/` | |
   | Planning dir | `specs/planning/` | |
   | Changelog dir | `specs/changelog/` | |
   | Hook script | `scripts/check-history-reminder.sh` | |
   | Claude commands | `.claude/commands/` | |

   For `.claude/commands/`, list which of the standard momentum commands are missing:
   `brainstorm-idea`, `brainstorm-phase`, `start-project`, `start-phase`, `complete-phase`,
   `log`, `sync-docs`, `track`, `migrate`, `validate`

   **Foundation docs are NOT migration gaps** (`core/project-lifecycle.md`,
   ADR-0008): `specs/vision/*` and `specs/planning/roadmap.md` are authored
   via `/start-project`, never copied from templates. If they're missing,
   report "not founded — run `/start-project`" in the result; do NOT create
   them here.

2. **Report gap summary** — present findings before making any changes:
   ```
   Found: 8 / Missing: 4 items
   Will add:
     - specs/backlog/details/ (.gitkeep)
     - specs/index.md (OKF bundle root)
     - .claude/commands/validate.md
     - .claude/commands/migrate.md
   Will skip (already exist):
     - specs/status.md
     - specs/backlog/backlog.md
   ```
   Ask the user to confirm before proceeding.

3. **Fill gaps (skip-if-exists for all files)**:
   - Copy any missing momentum template files from `specs-templates/` — never overwrite
     files the project already has
   - Add any missing momentum commands to `.claude/commands/` — skip ones already present
   - Add `scripts/check-history-reminder.sh` if absent (and chmod +x)

4. **Phase metadata reconciliation** (OKF bundle, ADR-0005):
   - Run `momentum upgrade` — it migrates any legacy `specs/phases/index.json`
     / `specs/decisions/impact-map.json` into frontmatter + `impact-map.md`,
     sweeps `type:` frontmatter across `specs/**/*.md`, and generates the
     bundle indexes
   - For any `phase-*` directory whose `overview.md` still lacks `status:`
     frontmatter, add:
     ```yaml
     ---
     type: Phase
     status: unknown
     ---
     ```
   - Inform the user: "N phases marked status 'unknown' — update the
     frontmatter manually to match actual state"
   - Finish with `momentum okf check` and report any remaining violations

5. **Report result**:
   ```
   ✓ Migration complete.
   Added: 4 items
   Skipped: 6 items (already existed — not overwritten)
   Founded: no — charter/roadmap missing; run /start-project to author them
   Needs manual attention:
     - 3 phases marked status 'unknown' in overview.md frontmatter — verify manually
     - specs/status.md: already exists — verify Current Phase matches the phase frontmatter
   ```
