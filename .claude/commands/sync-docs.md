Sync all relevant documents based on the active phase's history log.
Token-efficient: reads history + 2 tiny indexes first, then only targeted files.

> **Which phase is yours (Rule 15):** the phase bound to your branch — sync
> from YOUR lane's history log. `status.md` is the fallback and the
> cross-lane overview. Never sync another active lane's history from here.

## Steps

### Step 1: Load history and indexes (cheap reads)
- Resolve your phase from the current branch: a `phase-*` branch with a
  matching `specs/phases/<branch>/` directory binds to that phase; fallback =
  the `specs/status.md` Active Phase table
- Read the history log → extract all entries:
  - **Phase lane**: `specs/phases/<phase-bound-to-your-branch>/history.md`
  - **No active phase** (ad-hoc work just shipped): the relevant
    `specs/adhoc/<id>/record.md` (and `specs/adhoc/history.md` if present).
    If there is no phase and no ad-hoc record, there is nothing to sync —
    report "nothing to sync" and stop.
- Read the `tags:` frontmatter of each `specs/phases/*/overview.md` (OKF bundle)
- Read `specs/decisions/impact-map.md` (~3KB)

### Step 2: Build targeted file list
For each history entry:
  - Extract Topics list
  - Match each topic against phase `tags:` frontmatter → collect affected phase tasks.md files
  - Look up each topic in the impact-map.md table → collect affected spec files/sections
  - Deduplicate the combined list
  - For monorepo: EXCLUDE files in `specs/architecture/`
    (constitution — never auto-synced, only amended via formal process)
  - **Multi-repo: PARTITION OUT cross-repo entries.** If a history entry has an
    `Affects-specs:` path starting with `../` (or otherwise outside this repo),
    add it to a separate "cross-repo" list. NEVER edit those files — you only
    own this repo's docs.

### Step 3: Show sync plan (ALWAYS show before touching anything)
Present to user:
  "Based on phase history, I will check and potentially update:
  - [list of files]
  Proceed? (yes/no)"

**If any cross-repo entries were partitioned out in Step 2:** show them under a
"Cross-repo impact" heading, listing each `Affects-specs: ../...` path and which
member repo owns it.

**Then DELIVER them, don't just mention them (Phase 31b, ADR-0017 E6).** A chat
message dies with the session — that is why one reviewed multi-repo session's
glossary propagation never happened *despite this rule working exactly as
designed*. For each target member repo, write a structured handoff into its
inbox:

```js
const orchestration = require('<momentum-root>/core/orchestration');
await orchestration.handoff.handoff({
  fromRepo: '<this repo absolute path>',
  toRepo: '<target member absolute path>',
  summary: 'Doc sync needed: <N> entries from <this repo> phase <phase> affect your specs',
  decisions: [/* the history entries that pointed here, verbatim */],
  filesTouched: [/* the ../ paths, rewritten relative to the TARGET repo */],
  verificationCommands: [],
  openQuestions: ['Do these entries still apply after your latest changes?'],
  ecosystem: { rootPath: '<ecosystem root>', memberId: '<this repo member id>' },
});
```

The receiving session surfaces it at SessionStart and picks it up with
`/continue`.

**The ownership rule is unchanged and absolute:** you still NEVER edit a file in
another repo. You are handing the target repo's own agent a note; that agent
decides what to change. Delivery is not ownership.

Do NOT prompt for approval on cross-repo paths — writing a handoff into an
inbox is additive and reversible, and the receiving session gates the actual
edits.

If user says no → stop.

### Step 4: Read and assess (targeted reads only)
For each file in the list:
  - Read only the relevant section
  - Assess: does it need updating based on history entries?

### Step 5: Make updates (one at a time, fully visible)
For each file that needs updating:
  - Show the user what will change
  - Use the Edit tool to make the change

### Step 6: Update phase metadata if scope changed
If any [SCOPE_CHANGE] entries exist:
  - Update the active phase's `overview.md` frontmatter `tags:` list
  - Run `momentum okf index` to refresh the bundle listings

### Step 7: Commit all changes
```bash
git add <all modified spec files>
git commit -m "docs(phase-N): sync specs from phase history"
```

### Step 8: Confirm completion
"Spec sync complete. Updated N files:
- [list]
Ready to run /complete-phase."

## Safeguards
- NEVER update files not in the targeted list
- NEVER update `specs/architecture/` (monorepo only — constitution is read-only)
- NEVER update files in another repo (paths starting with `../`) — you only own this repo's docs. **Deliver** cross-repo entries as a handoff into the target member's inbox (ADR-0017 E6); the receiving repo's own agent decides what to change. Delivery is not ownership.
- ALWAYS show the plan (Step 3) before making any edits
- History entries are NEVER modified — only read
