Ship an ad-hoc change without a full phase — a bounded `quick-task` (bugfix /
chore / audit / dependency bump) or a declared `spike` (throwaway exploration).
Preserves git discipline + tracking; a quick-task still passes the Rule 12
verification gate. For net-new features or cross-cutting work, use
`/brainstorm-phase` instead — see the Rule 14 escalation check below.

## Steps

1. **Pick the work type** (see `specs/adhoc/README.md`):
   - Default → `quick-task`. With `--spike` (or when the user says "spike" /
     "experiment") → `spike` (gate-exempt, throwaway).

2. **Rule 14 escalation check — STOP if this should be a phase.** Escalate to
   `/brainstorm-phase` instead if the change: touches more than ~5 files of
   production code, modifies anything under `specs/architecture/`, needs an
   ADR, changes a public contract/interface, or displaces a planned phase.
   When in doubt, ask the user. Do NOT smuggle a phase-sized change through
   the ad-hoc lane.

3. **Branch** (Rule 6 — never work on `main`/`staging`):
   - quick-task bugfix → `fix/BUG-NNN-short-desc`
   - quick-task chore → `chore/short-desc`
   - spike → `spike/short-desc`

4. **Open the ad-hoc record.** Choose `<id>`: the backlog id if one exists
   (e.g. `BUG-009`), else `YYYY-MM-DD-<slug>`. Then:
   ```bash
   mkdir -p specs/adhoc/<id>
   cp specs/adhoc/_TEMPLATE.md specs/adhoc/<id>/record.md
   ```
   Fill **Current / Expected / Unchanged Behavior**. The Unchanged-Behavior
   line is the blast-radius guardrail — be explicit about what must NOT change.

5. **Track it** (Rule 3): ensure the backlog has a row (`/track` if not). A
   pure chore with no backlog id is fine — note "Backlog: none" in the record.
   **Team-safe (multi-session):** when assigning a NEW backlog id
   (`BUG`/`FEAT`/`TD`/`ENH-NNN`), reserve it first with `momentum claim id <ID>`;
   if it loses (exit 2) another session already filed that number — pick the next.

6. **Do the work.** Commit with Conventional Commits (the `commit-msg` hook
   enforces this). Keep commits atomic.

7. **Verify (Rule 12) — the gate.**
   - `quick-task`: run the real verification command(s); paste fresh output
     (command + exit status) into the record's `## Verification Evidence`.
     This is REQUIRED before merge.
   - `spike`: write `spike — gate-exempt` there plus one line on what was
     learned and the follow-up (file a backlog item if the spike found work).

8. **Log the why** (Rule 8, phase-optional): append decisions/discoveries to
   `specs/adhoc/<id>/record.md` (or `specs/adhoc/history.md`) via `/log`.
   Update `specs/changelog/YYYY-MM.md` with a one-line entry.

9. **Merge + (optional) release** — needs explicit user approval (Rule 6):
   - Ask the user before merging to `main`/`staging`. After approval, authorize
     the single push with the sentinel the `pre-push` hook consumes:
     ```bash
     touch .momentum/merge-approved   # single-use; consumed on push to main
     ```
   - If this ships a version bump, add a row to the **Ad-hoc / Patch Releases**
     section of `specs/status.md` (NOT the Completed Phases table). The
     `pre-push` release-tag gate requires the record's `## Verification
     Evidence` to be non-empty — so a spike must not cut a release tag.

10. **Clean up**: after a confirmed merge, delete the branch
    (`git branch -d <branch>` + `git push origin --delete <branch>`), and set
    the record `Status:` to `shipped` (or `abandoned` for a dropped spike).
