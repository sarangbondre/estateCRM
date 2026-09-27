Verify, finalize, and release a completed phase.

> **Which phase is yours (Rule 15):** the phase bound to your branch — that
> is the phase this command completes. `status.md`'s Active Phase table is
> the fallback and the cross-lane overview. When other lanes are in flight,
> landing follows the Rule 6 **Landing Order**: one lane at a time, full
> suite green on updated `main` between landings, remaining lanes rebase.

## Steps

### Verify

1. Read the phase's acceptance criteria:
   - Read `specs/phases/phase-N-*/overview.md`

2. Verify all tasks are done:
   - Read `specs/phases/phase-N-*/tasks.md`
   - If any `[ ]` unchecked items remain → report to user, do NOT proceed

3. **Run project-specific validation and capture fresh evidence** (per Rule 12 — Verify Before Claim):
   - Read `specs/config.md` (`core/config.js` → `readConfig('specs')`)
     for `test_command` and `build_command`. When the file is absent or a
     value is missing, fall back to `npm test` / no build (the historical
     defaults). Run `test_command` always; run `build_command` when it is not
     `none`.
   - Run all defined validation commands: tests, linting, type checks, build, smoke tests
   - Capture each command's stdout/stderr (e.g., redirect to a temp file with `tee`)
   - Note exit codes
   - If any command fails → STOP, report failure to user, do NOT proceed to Finalize
   - If a command can't run in the current environment, say so explicitly — do not silently skip

   **Refuse to advance to Finalize without fresh, captured evidence.** Memory of "tests passed earlier this phase" is not evidence — re-run them now.

4. If this phase built a learning loop, verify:
   - Locked evaluator exists in `tests/benchmarks/`
   - Convergence measurement logged (scalar improved)
   - If not → report to user, do NOT proceed

5. Check for new bugs discovered during the phase:
   - Grep `specs/backlog/backlog.md` for items tagged to this phase

### Finalize

**Step F0: Sync docs from phase history (run BEFORE other finalize steps)**
- Run `/sync-docs` to propagate all history-recorded changes to relevant documents
- If /sync-docs finds nothing to update, proceed directly

6. Create retrospective:
   - `specs/phases/phase-N-*/retrospective.md`
   - What went well, what didn't, lessons learned
   - **Append a `## Verification Evidence` section** with the captured output from Step 3:
     - For each validation command: command line, exit code, last 50 lines of output (or full output if shorter)
     - Format as fenced code blocks with the command as the heading
     - This is the durable record that Rule 12 was honored — it must exist before the release section runs

7. Update all tracking (this happens BEFORE the release — see the Release
   gate below; the release must never precede tracking):
   - `specs/phases/README.md` → mark `Complete`
   - `specs/status.md` → (a) header **`Latest Release`** = this version + name;
     (b) add the phase's row to the **Completed Phases** table; (c) remove this
     lane's row from the Active Phase table (leave other lanes' rows untouched —
     Rule 15); (d) update Current Phase
   - `specs/planning/roadmap.md` → update phase status → Complete (+ version)
   - `specs/changelog/YYYY-MM.md` → add release entry

### Release

> **Gate A (Rule 12):** Do NOT enter Release if `retrospective.md` lacks a `## Verification Evidence` section. If evidence is missing, return to Step 3 and capture it.
>
> **Gate B (tracking-before-release):** Do NOT merge, tag, or release until ALL
> tracking that reflects this release (Step 7 — `status.md` `Latest Release` +
> Completed Phases row, `specs/phases/README.md`, `roadmap.md`, the changelog)
> is written AND committed on the phase branch (Step 8). The release must never
> precede tracking — otherwise `status.md` says "in progress" while the tag is
> already public. Confirm the working tree is clean of tracking edits (Step 8
> committed them) before Step 9's approval and Step 10's merge/tag.

8. Commit all remaining changes (retrospective + ALL Step-7 tracking) and push.
   This commit MUST land before the merge/tag — it is Gate B:
   ```bash
   git add -A
   git commit -m "docs: complete Phase N - {phase name}"
   git status --porcelain   # expect empty — tracking is committed (Gate B satisfied)
   git push origin phase-N-shortname
   ```

9. Ask the user ONCE for approval to release — present the full plan, walking
   the project's `branch_flow` (from `specs/config.md`; default
   `[staging, main]`) in order. The plan stops at the universal git primitives
   (`git merge` + `git tag -a` + `git push origin <tag>`); forge-specific
   release creation and registry publishes are NOT listed here — they run
   from `specs/project-rules.md` + `specs/config.md` (`release_command`,
   `publish_target`, `release_flow`) after the tag is pushed.

   **Reserve the version first (team-safe — ENH-057):** before tagging, run
   `momentum claim version vX.Y.Z`. If another session already reserved that
   version the claim loses (exit 2) — re-read the intended version and re-pick,
   so two concurrent releases can never burn a version number.
   ```
   Ready to release vX.Y.Z. This will:
     1. Merge phase-N-shortname → <branch_flow[0]> (e.g. staging)
     2. …promote through <branch_flow[1..]> (e.g. main)
     3. Tag vX.Y.Z and push the tag

   Project-specific release/publish/deploy (forge release, npm publish, …)
   run from specs/project-rules.md + specs/config.md after the tag lands.

   Proceed?
   ```
   Wait for a single "yes" before running any of the following steps.

10. On approval, execute the merge sequence + tag in order.

    **Landing Order (Rule 6/15):** if another lane landed on `main` since
    this branch last rebased, rebase this branch onto updated `main` and
    re-run the suite BEFORE merging. Never land two lanes back-to-back
    without the suite passing in between.

    Walk `branch_flow` (default `[staging, main]`) hop by hop — one merge per
    protected branch in order, approval covered by the single "yes" above:
    ```bash
    # step 1 — phase branch → branch_flow[0]
    git checkout <branch_flow[0]> && git pull origin <branch_flow[0]>
    git merge --no-ff phase-N-shortname -m "merge: phase-N-shortname → <branch_flow[0]> (vX.Y.Z)"
    git push origin <branch_flow[0]>

    # step 2.. — promote through each remaining branch_flow entry
    #   (e.g. staging → main)
    git checkout <branch_flow[1]> && git pull origin <branch_flow[1]>
    git merge --no-ff <branch_flow[0]> -m "merge: <branch_flow[0]> → <branch_flow[1]> (vX.Y.Z — Phase N: {phase name})"
    git push origin <branch_flow[1]>

    # final step — tag + push the tag (universal git; forge release + publish
    # are project-specific — run them from specs/project-rules.md now)
    git tag -a vX.Y.Z -m "Phase N: {phase name}"
    git push origin vX.Y.Z
    ```
    **`end_state` variants** (config; the sequence above is the
    `merge-after-yes` default):
    - `feature-branch-only` — SKIP the merge/tag; the branch is pushed, the
      human owns merge + release.
    - `staging-promotion` — merge to `branch_flow[0]` only, then STOP; the human
      promotes to `main` and tags.
    - `open-pr` — do NOT merge; push the branch and open a PR for review
      (config-gated, agent-run — `git_forge=github`: `gh pr create`; GitLab:
      `glab mr create`), then STOP. Merge happens on the forge on human approval.

    **Human handshake → verify → clean** (every non-`merge-after-yes`
    end_state). Step-13 auto-cleanup only fires when the AGENT did the terminal
    merge. When a human/forge does it, NEVER clean on trust: ask the user to
    confirm once they have merged/promoted, then verify + clean in one step —
    ```bash
    momentum lanes reconcile            # is the branch a verified ancestor of the terminal branch yet?
    momentum lanes reconcile --execute  # only once it shows 'landed' — cleans worktree + branch + state
    ```
    `reconcile` refuses to clean a lane whose branch is not yet contained in the
    terminal branch — a "yes, I merged it" is never taken on trust (Rule 12).

12. Report summary to user:
    - What was delivered
    - Tag URL (`git push origin vX.Y.Z` output) — forge release/publish
      status from `specs/project-rules.md` if any ran
    - What's next

13. Clean up the spent phase branch (ENH-042 / BUG-026 — now that merge → main
    + release are confirmed; do NOT skip, or stale branches/worktrees/state
    accumulate). One command removes ALL of it, default-branch-safe:
    ```bash
    # worktree (if the phase ran in a lane) + local branch + remote branch
    # (skipped when it is the forge default — BUG-025 guard) + lane state.
    momentum lanes cleanup phase-N-shortname
    #   --lane <id>   if this phase ran as a registered `momentum lanes` lane
    #   --force       only to override an unmerged-branch refusal AFTER you have
    #                 verified the branch actually landed
    ```
    If cleanup reports `blocked` on the remote branch because it is the forge
    DEFAULT, STOP — that is the BUG-025 hijack. Reassign the default to the
    terminal branch first (e.g. `git_forge=github`: `gh repo edit
    --default-branch main`), then rerun. `-d` (not `-D`) refuses an unmerged
    branch by design — investigate rather than force.

14. Branch-hygiene self-audit (ENH-042) — confirm no released phase left a
    dangling branch or worktree:
    ```bash
    git branch -r | grep -E 'origin/(phase-|chore/|audit/)' || echo "✓ clean — no stale branches"
    git worktree list                                        # no leftover lane worktrees for landed work
    ```
    For each stale match, verify it is fully merged into `main`
    (`git branch -r --merged main`) and clean it per step 13. Leave any
    *unmerged* branch alone and surface it to the user.
