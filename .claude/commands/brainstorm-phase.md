Brainstorm the next phase before creating it.

Run AFTER `/complete-phase` and BEFORE `/start-phase`.

## Two modes: interview (cold) and derive (inside an epic)

**Interview — the default, and everything below.** A cold phase whose decisions
have not been made yet. Ask the questions; nothing is on record.

**Derive — `/brainstorm-phase --derive --epic <slug>`.** A phase that belongs to
an epic. Its decisions were settled once when the epic was brainstormed, so
asking again would be re-litigating a closed conversation:

```bash
momentum run derive <phase-dir> --epic <slug> [--deps a,b] --write
```

This generates `overview.md` / `plan.md` / `tasks.md` from the epic record plus
every forward-only amendment made since, **with no interview**. What it produces
is a skeleton: the epic knows the objective, the inherited decisions, the deps
and the run policy; it cannot know this phase's group breakdown, which depends
on code that exists now and did not when the epic was written. Author the groups;
everything above them is derived.

> **Why derivation rather than writing all the specs upfront.** Specs authored
> before their phase begins are hypotheses about a codebase earlier phases have
> not changed yet — and worse, every operator amendment mid-epic then becomes a
> merge conflict against a spec already written and tasks already checked `[x]`.
> Derived just-in-time, an amendment is simply an input. **Decisions are
> durable; plans are perishable.**

Skip the rest of this file when deriving — the gate contract below still applies
to any hand-authoring you do afterwards.

---

## Important: No Separate Design Document

All output goes directly into the phase directory as standard phase files.
The brainstorm output IS the phase files — there is no intermediate design doc.

**But — and this is the whole point of this command — those phase files MUST NOT exist on disk until the user has explicitly approved the draft.** See the [Brainstorm Gate Contract](#brainstorm-gate-contract) below.

## Steps

0. **Enter the brainstorm gate**:
   ```bash
   mkdir -p .momentum && touch .momentum/brainstorm-active
   ```
   From this point until Step 8, do NOT call any write-class tool on any path under `specs/`. The PreToolUse hook (`core/scripts/brainstorm-gate.sh`, wired by Claude Code + Codex + Antigravity) will block such calls; this step makes the intent explicit.

1. Review current state:
   - **Founded gate first** (`core/project-lifecycle.md`, ADR-0008): verify
     `specs/vision/project-charter.md` AND `specs/planning/roadmap.md` exist.
     If either is missing, the project is NOT founded — STOP: remove the
     sentinel (`rm .momentum/brainstorm-active`) and route to
     `/start-project`, offering to draft the foundation docs with the user
     from the context already in this conversation (best-effort content
     marked for refinement beats absent docs). Re-run this command once
     founded. Never plan a phase on an unfounded project.
   - Read `specs/status.md` — what phase just completed?
   - Read the completed phase's `history.md` — what was learned?
   - Read `specs/backlog/backlog.md` — any P0/P1 items to address first?

2. Check the roadmap:
   - Read `specs/planning/roadmap.md` — what's the next planned phase?
   - Is the planned phase still the right next step given what was learned?

2b. Read verification defaults from config:
    - Read `specs/config.md` (`core/config.js` → `readConfig('specs')`)
      for `test_command` and `build_command`. When absent, default to
      `npm test` / no build. Use these as the default verification commands in
      the phase's deliverables table (overview.md) unless the phase needs
      something different — call out any deviation explicitly.

3. Define scope with the user (one question at a time):
   - What is the goal of this phase?
   - What are the key deliverables?
   - What are the acceptance criteria?
   - What are the non-goals (explicitly out of scope)?

4. For monorepo — identify reference specs:
   - Which architecture docs in `specs/architecture/` are relevant?
   - Are there any spec gaps that need to be filled first?
   - If gaps exist, propose an ADR or addendum before proceeding.

5. Gap analysis (monorepo only):
   - Cross-reference brainstormed design against architecture specs
   - Verify interface counts, field names, error codes match exactly
   - Record findings and resolutions

6. **Draft phase files in conversation only** — do NOT call `Write`/`Edit`/`MultiEdit`:
   - `overview.md` — goal, key decisions table, scope (in/out), deliverables with verification commands, acceptance criteria
   - `plan.md` — full implementation plan using the Group Execution Pattern (see below)
   - `tasks.md` — granular checklist mirroring plan.md tasks
   - `history.md` — initial entries logging all decisions from this brainstorm session

   Show the user the full draft in the chat. Iterate on revisions in the chat. Nothing on disk yet.

7. Present for user approval:
   - Show key sections of overview.md and plan.md
   - Ask: "Does this look right? Any changes before I write the phase files?"

8. **On approval — exit the gate and write**:
   ```bash
   rm .momentum/brainstorm-active
   ```
   **Reserve the phase number first (team-safe — multi-session):** run
   `momentum claim phase <N>`. If a concurrent session already grabbed that
   number the claim loses (exit 2) — pick the next free number before writing,
   so two people brainstorming at once can't both create "Phase N".

   Then write all four files to `specs/phases/phase-N-shortname/` and commit:
   ```bash
   git add specs/phases/phase-N-shortname/
   git commit -m "docs: brainstorm Phase N — {phase name}"
   ```

9. Prompt: "Phase N is planned. Run `/start-phase` when ready to begin."

---

## Brainstorm Gate Contract

This command runs in two phases: **brainstorm** (conversational, no disk writes) and **commit** (writes files to disk on explicit approval).

### Sentinel-driven enforcement

A file `.momentum/brainstorm-active` exists for the lifetime of the brainstorm phase. While it exists, the `brainstorm-gate.sh` PreToolUse hook (shared across Claude Code, Codex, and Antigravity) blocks any write-class tool call whose target lives under `specs/`. The hook is the safety net; the discipline below is the primary contract.

### Sequence

1. **Enter brainstorm** — `mkdir -p .momentum && touch .momentum/brainstorm-active`
2. **Draft in conversation only** — all overview/plan/tasks/history content lives in the chat. NEVER call `Write`/`Edit`/`MultiEdit` on `specs/` paths during this phase. The hook will block such calls; the contract makes the intent visible.
3. **Present for approval** — show the user the full draft. Ask: "Does this look right? Any changes before I write the phase files?"
4. **Exit brainstorm on approval** — `rm .momentum/brainstorm-active`, then write all files in one batch and commit.

### Red flags — STOP and stay in conversation

| If you find yourself thinking… | …STOP and stay in conversation |
|---|---|
| "I'll just write a quick draft to disk so I can see it" | The conversation IS the draft. The hook will block this. |
| "The user will approve, no point waiting" | Approval changes the conversation. Don't pre-commit to text the user might still revise. |
| "I'll create the directory now to save a step later" | Don't. Wait for approval. |
| "The brainstorm session was interrupted; I'll just remove the sentinel" | Only remove it when you have explicit approval AND are about to write. Premature removal recreates the failure mode. |

### Anti-rationalization counters

- "Drafting to disk is faster than drafting in chat" — false: revisions in chat are free; revisions on disk require re-edits.
- "Only writing scratch files, not the real specs" — the hook can't tell scratch from real; keep both in conversation.
- "It's fine, the user said proceed" — proceed only AFTER the explicit approval step, not before.

---

## Group Execution Pattern for plan.md

Declare the execution order at the top of every plan.md:

```
# Sequential:  Group 0 → Group 1 → Group 2
# Parallel:    (Groups 0 + 1 + 2 in parallel) → Group 3
# Mixed:       Group 0 → (Groups 1 + 2 in parallel) → Group 3
```

Every group header declares:
- `**Sequential.**` or `**Parallel with Groups X and Y.**`
- External dependencies (libraries, services, running processes)
- Commit message for the group

Standard layout:
- **Group 0** — contracts, types, migrations (sequential, blocks everything)
- **Middle groups** — independent feature areas (parallel candidates)
- **Second-to-last** — wiring and integration (sequential)
- **Last** — verification: tests, benchmarks, smoke tests (sequential)

## Key Principles
- One question at a time — don't overwhelm
- Each phase should be completable in a focused sprint
- If scope is too large, suggest splitting into sub-phases
- Record any discoveries in history.md
- **Brainstorm Gate**: see the contract above. No writes until approval.
