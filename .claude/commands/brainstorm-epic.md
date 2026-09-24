Brainstorm a multi-phase epic before starting it.

The in-repo mirror of `/brainstorm-initiative`, one tier down. Run this **once**,
before any phase of a feature that will take more than one phase — then never
re-answer these questions again.

## When this applies

Work is an epic when it takes **more than one phase in one repo**. A feature
needing a schema migration, then an API, then a UI. A refactor that must land in
stages. A migration with a compatibility window.

Momentum has been running epics for years under a letter-suffix convention
(`21a/b/c`, `30a/b/c/d/e`, `31a/b/c`) held together by operator memory. This
command gives that convention a record.

| Tier | Record | Command |
|---|---|---|
| cross-repo | `initiatives/NNNN-<slug>.md` | `/brainstorm-initiative` |
| **multi-phase, one repo** | **`specs/epics/NNNN-<slug>.md`** | **`/brainstorm-epic`** |
| one phase | `specs/phases/phase-N-<slug>/` | `/brainstorm-phase` |

Cross-repo AND multi-phase? Open the initiative first; each member's
contribution can then be an epic.

## The point of this command

> **Decisions are durable. Plans are perishable.**

Everything settled here is settled **once**. Each phase's specs are then
*derived* from this record (`/brainstorm-phase --derive`) rather than
re-interviewed — so the operator answers "which storage backend?" exactly once,
not once per phase.

What belongs here: the objective, the decisions, which phases exist and what
depends on what, the completion criteria, the run policy.

What does **not** belong here: any phase's group breakdown or task list. Those
depend on code that does not exist yet, and writing them now guarantees they are
stale by the time they are read. That is the whole reason for derivation.

## Steps

0. **Enter the brainstorm gate:**
   ```bash
   mkdir -p .momentum && touch .momentum/brainstorm-active
   ```
   Until step 7, write **nothing** to disk. The draft lives in the conversation.

1. **Orient.** Read `specs/status.md`, the last phase's `retrospective.md`
   (what did it defer?), and scan `specs/backlog/backlog.md` for P0/P1 items.
   Run `momentum epic list` — if an epic already covers this, **stop** and use it.

2. **Define the objective with the user, one question at a time:**
   - What becomes possible when this ships?
   - What are the phases, and what does each contribute?
   - What depends on what? (These become each phase's `deps:` — the ordering is
     computed from them, never from the order you list the phases in.)
   - What is explicitly a non-goal?
   - **What must be true to call this done?** These become the completion
     criteria, so make them checkable. "Attachments work" is not a criterion;
     "upload → retrieve round-trips through the real storage backend in the
     suite" is.

3. **Surface the decisions.** This is the step that pays for the command. Walk
   the design and write down every decision that will hold across ALL the
   phases — libraries, contracts, storage, protocols, trade-offs consciously
   accepted. Each gets a row and a rationale.

   Ask yourself: *what would a later phase otherwise stop and ask about?* Every
   such question answered here is an interruption that never happens.

4. **Choose the run policy** (`momentum config validate` enforces the rules):
   - `release: per-phase` — a gate at each phase's end (default)
   - `release: per-feature` — commit and push throughout, **one** merge + release
     at the end of the epic. Requires `tdd: strict`: one approval covering
     several phases of diff is not a review anybody performs, so gate frequency
     is traded away only by buying verification rigor.

   If `per-feature`, say plainly that this means one approval will cover code
   the operator has not read yet (ADR-0020), and that the grant is scoped,
   expiring and revocable.

5. **Present the full draft** — objective, decisions, phases + deps, non-goals,
   completion criteria, policy. Iterate in the conversation.
   Ask: "Does this look right? Any changes before I create the epic?"

6. **On approval — exit the gate and write:**
   ```bash
   rm .momentum/brainstorm-active
   momentum epic create <slug> --why "<objective>" --owner "<who>" \
     --phases phase-N-a,phase-N-b --release per-phase|per-feature
   ```
   Then fill the Decisions and Completion-criteria sections of the created
   record from the approved draft, and commit:
   ```bash
   git add specs/epics/ && git commit -m "docs(epic): brainstorm <slug>"
   ```

7. **Start the first phase — derived, not re-interviewed:**
   ```bash
   momentum run derive <first-phase> --epic <slug> --deps "" --write
   ```
   Then `/start-phase`. The operator is asked nothing they answered here.

## Brainstorm Gate Contract

Identical in force to `/brainstorm-phase`'s. While
`.momentum/brainstorm-active` exists, the `brainstorm-gate.sh` PreToolUse hook
blocks write-class tool calls under `specs/`.

| If you find yourself thinking… | …STOP and stay in conversation |
|---|---|
| "I'll create the epic now and fill it in as we talk" | An epic created before the objective is settled is a record of confusion. |
| "I'll write all the phase specs while I'm here" | That is the mistake this tier exists to prevent. Phase 3's spec written today is a hypothesis about code phases 1–2 have not changed yet — and every later operator correction becomes a merge conflict against it. |
| "Two phases isn't really an epic" | Two phases IS the trigger. That is the whole rung. |
| "I'll record the decisions later from the transcript" | The transcript is not a record. Unrecorded decisions get re-asked, which is the problem. |

## Key principles

- **One question at a time.** Don't overwhelm.
- **An epic is a decision record, not a design doc.** Per-phase design lives in
  the phase, derived when it starts.
- **Ordering comes from `deps:`, not from the phase list.** The `phases` array
  is membership; execution order is computed by `core/waves` from each phase's
  own frontmatter. One topological sort in the codebase (ADR-0003).
- **Completion criteria must be checkable.**
- **Never write a later phase's plan.** If you are reaching for a group
  breakdown, you are in the wrong layer.
