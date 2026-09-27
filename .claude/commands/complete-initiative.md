Verify and close a cross-repo initiative.

The ecosystem-tier mirror of `/complete-phase`. Run this when every member's
contribution has landed — it is the only cross-repo Rule 12 gate momentum has.

## Why this gate exists

Across five reviewed multi-repo sessions, two shipped defects to production
while **every individual repo's suite was green**: an alembic multiple-heads
state created by running `upgrade head` before rather than after a cross-repo
conflict merge, and a message-less evidence turn. "Each repo is green" and "the
system works" are different claims. Nothing in momentum checked the second one
until this command existed.

## Steps

1. **Confirm every member has landed.** For each contribution, the member's own
   `/complete-phase` (or `/hotfix` close-out) should already have run in that
   repo — this gate reads the evidence those rituals produce; it does not
   replace them.

2. **Run the gate:**
   ```bash
   momentum ecosystem initiative complete <slug> --dry-run
   ```
   Read the output. It reports, per member:
   - `phase` → `specs/phases/<ref>/retrospective.md` must carry a non-empty
     `## Verification Evidence` section
   - `adhoc` → `specs/adhoc/<ref>/record.md` must exist and be non-empty

   Graded by the same parser `momentum lanes land` uses, so a contribution
   cannot pass one gate and fail the other.

3. **If it refuses**, it names the member and the reason. Fix the cause in that
   member repo — do not work around the gate. A missing retrospective means the
   phase was not actually completed there.

4. **Read the integration-verification line carefully.**
   - **Declared and passing** → the members were verified working together.
   - **Declared and failing** → the close is blocked. This is the case that
     catches "each repo is green but the system is broken."
   - **NOT DECLARED** → the gate says so explicitly and still allows the close.
     Nothing has verified the members work together. Treat this as a real gap:
     offer to add `config.integration_verify_command` to `ecosystem.json`.
     momentum is forge-neutral and ships no CI, so it can never invent this
     check for you (ADR-0016 D6).

5. **Close for real:**
   ```bash
   momentum ecosystem initiative complete <slug>
   ```
   This populates `## Deploy chronology` from the recorded git events,
   writes `## Close` with the evidence as it stood, sets `status: closed` +
   `closed: <date>`, and clears the active initiative.

6. **Write the human half.** The gate records that evidence *existed*; only you
   can say what it *meant*. Under `## Close`, add what shipped, what was
   deferred, and what was learned — the cross-repo equivalent of a phase
   retrospective.

7. **Commit the ecosystem root:**
   ```bash
   git add initiatives/ ecosystem.json
   git commit -m "docs(initiative): close <slug>"
   ```

## What this gate does NOT claim

It does not verify evidence was produced *in this session* — nothing portable
can. It reports each evidence file's last-commit date so a stale retrospective
is visible to you, and relies on the integration verification for a genuinely
run-now signal. Do not describe it as a freshness check.

It also does not verify a member you have no local checkout of. Such a member
**blocks** rather than passing — an initiative that cannot be verified on this
machine is not verified. Clone the member, or complete from a machine that has it.

## Red flags

| If you find yourself thinking… | …STOP |
|---|---|
| "The gate is blocking on a missing retrospective, I'll just write a stub" | A stub retrospective is a lie with a passing gate. Complete the phase in that member. |
| "`--skip-verify` will get me past this" | It refuses to close anyway, by design. |
| "Integration verify isn't declared, so we're fine" | Nothing checked that the members work together. That is the exact hole two production defects came through. |
| "I'll close it now and write the Close section later" | Later is after the context is gone. The gate writes the evidence; you write the meaning, now. |
