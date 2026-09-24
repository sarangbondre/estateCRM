Brainstorm a cross-repo initiative before starting it.

The ecosystem-tier mirror of `/brainstorm-phase`. Run this **before** any
cross-repo implementation work, then `momentum ecosystem initiative start`.

## When this applies

Work is cross-repo when it touches more than one member of the ecosystem —
a feature spanning a backend and a client, a contract change, a coordinated
migration, a fleet-wide dependency bump.

When you notice that, **stop and run this command.** Do not plan the work
inside one member's `specs/`, and do not start editing a second member repo
with no initiative covering the work.

This mirrors Rule 1's unfounded-project route (ADR-0008): when a project has
no charter, momentum does not block or warn — it routes to `/start-project` to
author the missing foundational record. Cross-repo work with no initiative is
the same situation one tier up, and gets the same treatment.

> **Honesty note (ADR-0016 D8).** In this release the routing is
> **agent convention**, not enforcement. Nothing mechanically detects that a
> session has touched a second member repo — that detection ships in Phase 31b.
> Momentum has overstated enforcement before (BUG-009, where Rule 6 claimed
> "(Automatic)" over prose no mechanism backed), so this says plainly what is
> and is not enforced today.

## Steps

0. **Enter the brainstorm gate** — at the **ecosystem root**:
   ```bash
   mkdir -p .momentum && touch .momentum/brainstorm-active
   ```
   From here until Step 6, write **nothing** to disk. The draft lives in the
   conversation.

1. **Orient across the fleet.** Do not plan blind:
   ```bash
   momentum ecosystem status
   momentum ecosystem sessions          # what has been happening
   ls initiatives/                      # is one already open for this?
   ```
   For every member you expect to touch, read its `specs/status.md` and scan
   its `specs/backlog/backlog.md` for open P0/P1 items — a bug already filed
   against the code you are about to change changes the plan. (`/scout <repo>`
   does this for you.)

   If an initiative already covers this work, **stop** — use it rather than
   opening a second one.

2. **Define the objective with the user, one question at a time:**
   - What is the objective? What becomes possible when it ships?
   - Which members does it touch, and what does each contribute?
   - What are the dependency edges between them — who must land first, and
     what kind of dependency is it (`api-contract`, `library`, `deploy`,
     `build-time`, `other`)?
   - What is explicitly a non-goal?
   - **What must be true to call this done?** These become the completion
     criteria the evidence gate checks later, so make them checkable.

3. **Decide each member's work type** (Rule 14 — pick the lightest that fits):
   - `phase` — net-new feature work, architectural or cross-cutting change
   - `adhoc` — a bounded bugfix, chore, or dependency bump

   Name the intended record for each, e.g. `backend:phase:phase-12-attachments`
   or `frontend:adhoc:fix-BUG-031-upload`.

4. **Check for an integration verification.** Read `ecosystem.json` for
   `config.integration_verify_command`. If none is declared, say so now and ask
   whether one should be — this is the check that catches "each repo is green
   but together they are broken", and `initiative complete` will report its
   absence as a gap rather than passing silently (ADR-0016 D6).

5. **Present the full draft in the conversation** — objective, per-member
   contributions, edges, non-goals, completion criteria. Iterate there.
   Ask: "Does this look right? Any changes before I create the initiative?"

6. **On approval — exit the gate and write:**
   ```bash
   rm .momentum/brainstorm-active

   momentum ecosystem initiative create <slug> \
     --why "<objective>" --repos <m1>,<m2> --owner <who>

   momentum ecosystem initiative start <slug> \
     --contribute <member>:<kind>:<ref> \
     --contribute <member>:<kind>:<ref> \
     --edge <from>:<to>:<kind>
   ```
   `start` writes the `Per-repo contributions` table, registers the dependency
   edges in `ecosystem.json`, and sets the initiative active.

7. **Route to each member's own lifecycle.** `start` prints the next command
   per member. Run each member's own ritual there — `/start-phase` or
   `/hotfix`. Momentum never writes another repo's `specs/` from the outside;
   each member owns its own records, which is the same boundary `/sync-docs`
   enforces.

8. Commit the ecosystem root:
   ```bash
   git add initiatives/ ecosystem.json
   git commit -m "docs(initiative): brainstorm <slug>"
   ```

## Brainstorm Gate Contract

Identical in force to `/brainstorm-phase`'s: while
`<ecosystem-root>/.momentum/brainstorm-active` exists, the draft stays in the
conversation. Nothing is written until the user explicitly approves.

| If you find yourself thinking… | …STOP and stay in conversation |
|---|---|
| "I'll create the initiative now and fill it in as we talk" | The conversation IS the draft. An initiative created before the objective is settled is a record of confusion. |
| "The user will obviously approve" | Approval changes the draft. Don't pre-commit to text they may still revise. |
| "This only touches two repos, it's not really cross-repo" | Two repos IS cross-repo. That's the whole trigger. |
| "I'll open the initiative after the code works" | Then the plan is a retrofit of whatever got built, which is how five reviewed sessions produced no initiative at all. |

## Key principles

- **One question at a time** — don't overwhelm.
- **An initiative is a coordination record, not a design doc.** Per-member
  design lives in each member's own phase.
- **Never plan cross-repo work inside one member's `specs/`.** If you are
  reaching for a phase directory to describe work in another repo, you are in
  the wrong layer.
- **Completion criteria must be checkable.** "Attachments work" is not a
  criterion; "upload → retrieve round-trips through the real storage backend
  in both members' suites" is.
