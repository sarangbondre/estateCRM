Track a backlog item — bug, feature, tech debt, or enhancement.

## Steps

1. Read `specs/backlog/backlog.md` to find next available ID

2. Determine item type:
   - Bug → `BUG-NNN`
   - Feature → `FEAT-NNN`
   - Tech Debt → `TD-NNN`
   - Enhancement → `ENH-NNN`

3. Add row to appropriate table in `specs/backlog/backlog.md`:
   - Priority: infer from urgency (default P2)
   - Status: `open`
   - Phase: target phase or `unscheduled`
   - Detail: `—` for one-liners, `[→](details/{ID}.md)` if a detail file is created

4. Decide: one-liner or detail file?

   **One-liner (no detail file needed):**
   - Clear, self-contained issue (< 2 sentences to describe)
   - No design choices to make
   - Single file or single function affected
   - Fix is obvious from the description

   **Detail file required (`specs/backlog/details/{ID}.md`):**
   - Requires design or multiple options to evaluate
   - Touches multiple files, commands, or systems
   - Has a non-obvious implementation path
   - Cross-cutting impact (affects other phases or specs)
   - Estimated > 30 min of work

   If a detail file is needed, create it now with: context, options considered, open questions.

5. If P0, also update Critical Items table in `specs/status.md`

6. Commit:
   ```bash
   git add specs/backlog/
   git commit -m "docs(backlog): add {ID} - {short title}"
   ```

## Cross-repo backlog items

`/track` operates on the current repo's `specs/backlog/`. The ecosystem
layer (Phase 9) does NOT aggregate backlogs across member repos in
Tier 1 — each repo's backlog stays authoritative for its own work. If
an item's scope genuinely spans repos, file it in the repo that owns
the most surface area and add a one-line cross-link from the others.

For cross-repo features as a whole (vs. individual backlog items), use
`/initiative create <slug>` — see the `/ecosystem` and `/initiative`
command recipes.
