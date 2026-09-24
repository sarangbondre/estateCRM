Begin a new implementation phase.

After setup, **executes the plan end-to-end autonomously** — no per-group approval prompts, no "should I commit?" interruptions. The engine stops once: at the merge + release gate after the final group's verification passes. See the [Autonomous Execution Contract](#autonomous-execution-contract) below.

> **Which phase is yours (Rule 15):** the phase bound to your branch — branch
> `phase-N-shortname` ↔ `specs/phases/phase-N-shortname/`. `status.md`'s
> Active Phase table is the fallback and the cross-lane overview. Starting a
> phase while other lanes are active is normal — add your lane's row to the
> table; never replace or rewrite other lanes' rows.

## Setup Steps (run once at phase start)

1. Read current state:
   - **Founded gate** (`core/project-lifecycle.md`, ADR-0008): verify
     `specs/vision/project-charter.md` AND `specs/planning/roadmap.md`
     exist. If either is missing, the project is not founded — STOP and
     run `/start-project` first (it authors the foundation docs from your
     brainstorm and plans Phase 0). Never start a phase on an unfounded
     project.
   - Read `specs/status.md`

2. Check for blocking bugs (pre-phase bug check):
   - Scan `specs/backlog/backlog.md` for P0/P1 items
   - If P0 bugs exist → report to user, recommend fixing first
   - If only P1 → continue but note them

3. Create the phase directory if it doesn't exist:
   ```
   specs/phases/phase-N-shortname/
   ├── overview.md    ← Scope, goals, deliverables, acceptance criteria
   ├── plan.md        ← Implementation approach with group execution pattern
   ├── tasks.md       ← Granular checklist [ ] / [x]
   └── history.md     ← Append-only log
   ```
   Use `/brainstorm-phase` first if these files don't exist yet.

   Note: if running `/start-phase` without `/brainstorm-phase` first, create
   `history.md` now — an empty append-only log with the entry-types header table.

   **Swarm-member briefs (Phase 17+)**: when `/start-phase` is invoked from
   a swarm conductor (env vars `MOMENTUM_SWARM_ID` + `MOMENTUM_SWARM_WAVE`
   + `MOMENTUM_SWARM_INITIATIVE` + `MOMENTUM_SWARM_SESSION` are set),
   prepend a YAML frontmatter block to `overview.md` with these fields:
   ```yaml
   ---
   swarm: <NNNN-slug>
   wave: <integer>
   initiative: <slug>
   claimed_by_session: <uuid>
   ---
   ```
   Solo (non-swarm) briefs omit the block entirely — they remain plain
   markdown. See `core/swarm/lib/brief.js` for the canonical helper.

4. Set phase metadata (OKF bundle, ADR-0005):
   - Read the phase's `overview.md` and `tasks.md`
   - Extract key topics: technology names, services, architectural concepts
   - Add/update the frontmatter at the top of the phase's `overview.md`:
     ```yaml
     ---
     type: Phase
     status: in-progress
     tags: [topic-1, topic-2]
     ```
     (add `deps: [phase-M-name]` when this phase depends on another
     unfinished phase — `momentum waves` reads it)
   - Refresh the bundle listings: `momentum okf index`

5. Update `specs/phases/README.md`:
   - Change phase status: `Not Started` → `In Progress`

6. Update `specs/status.md`:
   - Set "Current Phase" to the new phase (with other lanes active, the most
     recently started lane; the Active Phase table is the full picture)
   - Add this phase's row to the "Active Phase" table
     (Phase | Branch | Status | Progress) — one row per active lane; touch
     ONLY your own row (Rule 15)
   - Clear/update blockers

7. For monorepo only — identify relevant architecture specs:
   - Check `specs/planning/release-plan.md` for this phase's deliverables
   - List which specs in `specs/architecture/` are relevant
   - Note them in the phase's `plan.md` under "Reference Specs"

8. If this phase requires a locked evaluator (learning/optimization loop):
   - Add "Lock [Evaluator]" as the FIRST task in `tasks.md`

9. Create git branch and initial commit:
   ```bash
   git checkout main
   # Resilient when 'main' is unborn on the remote (fresh repo — BUG-025):
   git ls-remote --heads origin main | grep -q . && git pull origin main || true
   # BUG-025 safety net: the terminal branch must ALREADY be the remote default
   # before ANY phase branch is pushed (founding normally established it). If it
   # is still not on origin, establish it FIRST so phase-N can't hijack default:
   if git remote get-url origin >/dev/null 2>&1 && ! git ls-remote --heads origin main | grep -q .; then
     touch .momentum/merge-approved && git push -u origin main && git remote set-head origin main 2>/dev/null || true
   fi
   # Optional forge repair (only when git_forge=github AND gh is on PATH;
   # non-fatal; idempotent). Fixes a repo whose default was ALREADY hijacked.
   # Agent-run recipe step — momentum ships no forge code, stays forge-neutral:
   command -v gh >/dev/null 2>&1 && gh repo edit --default-branch main 2>/dev/null || true
   git checkout -b phase-N-shortname
   git add specs/
   git commit -m "docs: start Phase N - {phase name}"
   git push -u origin phase-N-shortname
   ```

10. Update `specs/changelog/YYYY-MM.md` with phase start entry.

## After Setup: Execute the Plan Autonomously

Once steps 1–10 complete, **proceed to implement the phase** per the [Autonomous Execution Contract](#autonomous-execution-contract). For each group in `plan.md` (in declared execution order):

1. **Mark the group's first task `[/]`** in `tasks.md` (in-progress).
2. **Implement the group's tasks.** Read, write code, add tests as the group requires.
3. **Run the group's verification command** (per Rule 12 — Verify Before Claim). Read the actual output.
4. **Mark tasks `[x]`** in `tasks.md` only if verification passed.
5. **Append a history entry** to `history.md` per Rule 8 (one entry per group minimum, more if `[DECISION]`/`[DISCOVERY]` events happen).
6. **Commit the group** with the per-group commit message declared in `plan.md`.
7. **Push to the phase branch.**
8. **Proceed to the next group.** Do NOT ask "ready for Group N+1?" — the answer is always yes.

After the final group's verification passes: **STOP.** Ask the user the single hard-stop question in the contract below.

---

## Autonomous Execution Contract

Once a phase plan is approved, this command executes the plan end-to-end without per-group approvals. The contract below defines what proceeds silently and where the engine MUST stop.

### Hard stop — always

**Merge to a protected branch + release.** After the final group's
verification passes, STOP. Read the project's config
(`specs/config.md` via `core/config.js` →
`readConfig('<repo>/specs')`; returns `null` when absent → use the
defaults below) and ask the user the gate question matching the project's
`end_state`:

- **`merge-after-yes`** (default): "All groups complete and verified. Ready
  to merge `<phase-branch>` → `<branch_flow in order>` (e.g. `staging`, then
  `main`), tag `v<version>`. Approve to proceed?"
- **`staging-promotion`**: "All groups complete and verified. Ready to merge
  `<phase-branch>` → `staging`. Tag `v<version>` + release after you promote
  to `main`. Approve to proceed?"
- **`feature-branch-only`**: "All groups complete and verified. The feature
  branch `<phase-branch>` is pushed. Merge, tag, and release are yours to
  do. Review the branch?"
- **`open-pr`**: "All groups complete and verified. Ready to push
  `<phase-branch>` and open a PR for review? Merge + release happen when a
  human approves and merges the PR on the forge; then `momentum lanes
  reconcile --execute` cleans up the branch + worktree + state."

Then append: "Project-specific release/publish/deploy steps (e.g.
`npm publish`, forge release creation) run from `specs/project-rules.md` in
CLAUDE.md/AGENTS.md — consult them now if any apply."

The gate stops at the truly universal git primitives — `git merge` +
`git tag -a` + `git push origin <tag>`. Forge-specific release creation
(`gh release create`, `glab release create`, …) and registry publishes
(`npm publish`, `twine upload`, …) are NOT in this template; they live in
`specs/project-rules.md` + `specs/config.md` (`release_command`,
`publish_target`, `release_flow`).

This is the only place the engine asks. Do NOT skip it.

### Discretionary stop — rare, judgment-based

Interrupt only when continuing would cause real harm or a wrong result that's hard to undo. Examples:

- Destructive git operation not in the plan (force-push to main, `git reset --hard origin/...`, branch deletion of unmerged work)
- A discovery that invalidates the agreed plan (not just adds to it — `[DISCOVERY]` + backlog entry handles additions silently)
- A required external action the engine can't perform (paid API spend, credential setup, account configuration)
- Repeated unresolved failure on the same task (Phase 7b will codify a 3-strikes retry budget; before 7b, use judgment)

A discretionary stop is rare. The default is to proceed.

### Pre-authorized actions — proceed silently

The engine does all of these without asking:

- Create the phase feature branch
- Commit per the conventional commit style and the per-group commit message in `plan.md`
- Push the phase branch to origin
- Run tests, lint, typecheck, build commands
- Update `specs/status.md`, the phase's `overview.md` frontmatter, `specs/phases/README.md`, the active phase's `tasks.md` and `history.md`
- Append to `specs/changelog/YYYY-MM.md`
- Create ADRs from discoveries (per Rule 8 / Rule 10)
- Add backlog entries from discoveries (per Rule 3)
- Read any file in the repo

### Anti-patterns — DO NOT

| Anti-pattern | Correct behavior |
|---|---|
| Asking "should I commit Group N now?" after each group | Commit per the plan's per-group commit message. Do not ask. |
| Asking "should I push?" after the first commit | Push immediately after the first commit; thereafter on milestones. Do not ask. |
| Asking "ready for Group 1?" after Group 0 | Proceed to Group 1 immediately when Group 0 verification passes. |
| Pausing to summarize progress between groups | Update `tasks.md` and move on. Summaries are for the user when they ask. |
| Asking "ready for tests?" before Group N's verification step | Verification is part of Group N. Run it. |

### Cross-references

- **Rule 6 (Git Lifecycle)**: pre-authorizes branch creation, commits, pushes to feature branch. The autonomy contract is the execution-time application of Rule 6.
- **Rule 8 (History)**: every group ends with a history append. Do this silently.
- **Rule 12 (Verify Before Claim)**: every group's last task is verification. Run the command, read the output, mark `[x]` only if passing.
