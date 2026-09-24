Found the project from a clear idea.

**Founding is about content, not structure** (see `core/project-lifecycle.md`,
ADR-0008): this command authors the foundation docs — project charter,
principles, success criteria, roadmap — plus the `status.md` Summary, and
plans Phase 0. It works on ANY repo state: freshly `momentum init`-ed,
brand-new/empty, or full of existing code. Structure (directories, commands,
hooks, tracking skeleton) is owned by `momentum init`, not by this command.

momentum ships **no placeholder foundation docs** — these files do not exist
until this command writes them. Their absence is the "not founded" signal
that `/brainstorm-phase`, `/start-phase`, and `/validate` check.

If you're still exploring the idea, run `/brainstorm-idea` first.
**Authoring happens only after you explicitly approve the draft.** See the
[Brainstorm Gate Contract](#brainstorm-gate-contract) below.

## When to use

- `momentum init` has run and `specs/status.md` says "Not founded"
- You just finished `/brainstorm-idea` and the idea is settled
- An existing codebase adopted momentum and needs its foundation docs written

## Steps

0. **Check machinery, then enter the brainstorm gate**:
   - If there is no momentum scaffold (no `.momentum/`, no `specs/status.md`),
     stop and run `momentum init` first — init owns structure; this command
     owns content.
   ```bash
   mkdir -p .momentum && touch .momentum/brainstorm-active
   ```
   From here until Step 6, do NOT call `Write`/`Edit`/`MultiEdit` on any path
   under `specs/`. The PreToolUse hook will block such calls.

1. Confirm the idea is clear — ask if needed (one question at a time):
   - What does this project build or do? For whom?
   - What type of repository? (monorepo with architecture specs / standard library or package)
   - What is the primary tech stack / language?
   - Any hard constraints (performance, compliance, dependencies)?

2. Determine repo type from answers:
   - Monorepo → also author an architecture constitution in `specs/architecture/`
   - Standard → foundation docs + phases only

3. **Draft the foundation in conversation only** — no file writes yet:
   - Charter: problem, solution, stakeholders, scope in/out, success
   - Principles: 3–6 project-specific principles that resolve trade-offs
   - Success criteria: measurable targets with how-to-measure
   - Roadmap: natural phases with key deliverables and rough version targets
   - `status.md` Summary paragraph (what this project is)
   - For monorepo: first-pass architecture sketch (core abstractions, interfaces)
   - Phase 0 contents using the [Group Execution Pattern](#group-execution-pattern)
   - **Config** (`specs/config.md`, ADR-0009): the project-shape
     settings recipe templates read at execution time (forge, publish target,
     branch flow, verification commands — see the [Config Format](#config-format)).
     Carry the values settled during `/brainstorm-idea`; when `momentum init`
     already inferred them, confirm the inferred file. `protected_branches`
     is derived from `branch_flow`.
   - Use the [Foundation Doc Formats](#foundation-doc-formats) below; author
     real content from the brainstorm — never emit `_(TBD)_` placeholders.
     Where understanding is genuinely thin, write the best-effort version,
     mark the specific line `<!-- refine: ... -->`, and ask the user.

4. Present the founding draft for approval:
   - Show the charter, roadmap, config table, and key Phase 0 sections in chat
   - List every file that will be created (including `specs/config.md`)
   - Ask: "Ready to found the project? This will write N files. Approve to proceed."

5. **On approval — exit the gate**:
   ```bash
   rm .momentum/brainstorm-active
   ```

6. Write the foundation in one batch:
   - `specs/vision/project-charter.md`
   - `specs/vision/principles.md`
   - `specs/vision/success-criteria.md`
   - `specs/planning/roadmap.md`
   - `specs/config.md` (from the config table above; overwrite the
     `momentum init`-inferred file if present — founding owns the content)
   - `specs/project-rules.md` (project-specific prose rules; each instruction
     file's `## Project Extensions` points here — ADR-0010)
   - Update `specs/status.md`: Summary, Current Phase (Phase 0 `not started`),
     Upcoming Phases, Next Actions
   - For monorepo: `specs/architecture/` first-pass doc(s)
   - `specs/phases/phase-0-shortname/{overview,plan,tasks,history}.md`
     (log the founding decisions from this conversation in `history.md`)
   - Refresh derived cache (`writeConfigCache`) + `momentum okf index`

7. Commit the founding:
    ```bash
    git add specs/
    git commit -m "docs: found {project name} — vision, roadmap, Phase 0"
    ```
    (On a brand-new repo this may be the first content commit on the default
    branch — the bootstrap exception to Rule 6. On a repo with existing code,
    normal branch discipline applies. Founding pushes nothing; `/start-phase`
    establishes the terminal branch as the remote default before it pushes the
    first phase branch — BUG-025.)

8. Report to user:
   - Summary of what was founded
   - Phase 0 goal and key deliverables
   - Prompt: "Project founded. Run `/start-phase` to begin Phase 0."

---

## Foundation Doc Formats

Author real content into these shapes (frontmatter included). These formats
live here — momentum ships no copyable placeholder versions.

### `specs/vision/project-charter.md`

```markdown
---
type: Vision
---

# Project Charter

> **Project**: {name}
> **Created**: {today}

## Problem Statement
{Who has what problem; why it matters}

## Solution
{What this project builds; how it solves the problem}

## Stakeholders
| Role | Name / Team | Responsibility |
|------|-------------|----------------|
| Owner | {…} | Final decisions |
| Users | {…} | Primary audience |

## Scope
### In
- {…}
### Out
- {…}

## Success
{How you'll know it worked — point at success-criteria.md targets}
```

### `specs/vision/principles.md`

```markdown
---
type: Vision
---

# Principles

> Guiding decisions throughout the project. When trade-offs arise, these resolve them.

## Core Principles
1. **{Name}** — {one-line rule of decision}
2. …
```

(Good defaults to adapt: simplicity first; ship incrementally; defer scope,
not quality; document decisions. Replace or extend to match THIS project.)

### `specs/vision/success-criteria.md`

```markdown
---
type: Vision
---

# Success Criteria

> Measurable targets. When all are met, the project has achieved its goals.

## Phase 0 Targets
| Criterion | Target | How to Measure |
|-----------|--------|----------------|
| {…} | {…} | {command / metric} |

## Long-Term Targets
| Criterion | Target | How to Measure |
|-----------|--------|----------------|
| {…} | {…} | {…} |
```

### `specs/planning/roadmap.md`

```markdown
---
type: Roadmap
---

# Roadmap

> **Start Date**: {today}

## Vision
{One sentence: what this project becomes at full maturity}

## Timeline
| Phase | Name | Status | Key Deliverables |
|-------|------|--------|------------------|
| 0 | {Bootstrap/…} | Not Started (target v0.1.0) | {…} |
| 1 | {…} | Not Started | {…} |

## Guiding Principles
1. Ship working software in every phase
2. Each phase leaves the project in a releasable state
3. Defer scope, not quality
```

---

## Config Format

Author `specs/config.md` in this shape (`type: Config` → OKF bundle).
Lists (`branch_flow`, `protected_branches`) are comma-separated;
`protected_branches` is derived from `branch_flow`. The trust layer (human
authorization for protected-branch pushes) is invariant, NOT a preference
(ADR-0009); bypass only via `MOMENTUM_SKIP_HOOKS=1`.

```markdown
---
type: Config
---

# Project Config

> Recipes read these at execution time; missing values fall back to npm/GitHub
> defaults. Edit freely.

| Key | Value |
|-----|-------|
| language | node |
| framework | nextjs |
| test_command | npm test |
| build_command | npm run build |
| publish_target | npm |
| git_forge | github |
| release_command | gh release create |
| release_flow | tag-and-publish |
| end_state | merge-after-yes |
| branch_flow | staging, main |
| protected_branches | staging, main |
```

---

## Brainstorm Gate Contract

This command runs in two phases: **brainstorm** (conversational, no disk writes) and **commit** (writes files to disk on explicit approval).

### Sentinel-driven enforcement

A file `.momentum/brainstorm-active` exists for the lifetime of the brainstorm phase. While it exists, the `brainstorm-gate.sh` PreToolUse hook blocks any `Write`/`Edit`/`MultiEdit` call whose target lives under `specs/`. The hook is the safety net; the discipline below is the primary contract.

### Sequence

1. **Enter brainstorm** — `mkdir -p .momentum && touch .momentum/brainstorm-active`
2. **Draft in conversation only** — charter, principles, success criteria, roadmap, architecture sketch, Phase 0 plan all live in chat. NEVER call `Write`/`Edit`/`MultiEdit` on `specs/` paths during this phase.
3. **Present for approval** — show the user the full draft including the list of files founding will create. Ask: "Ready to found the project? Approve to proceed."
4. **Exit brainstorm on approval** — `rm .momentum/brainstorm-active`, then write all files in one batch and commit.

### Red flags — STOP and stay in conversation

| If you find yourself thinking… | …STOP and stay in conversation |
|---|---|
| "The scaffold already exists, so founding must already be done" | Structure ≠ content. If charter/roadmap don't exist, the project is NOT founded — that's exactly what this command fixes. |
| "The user said the project name; I'll start writing files" | Project name ≠ approval. Show the full draft, then ask. |
| "I'll write the charter first while we figure out the rest" | All-or-nothing: every file goes in one batch on approval. Otherwise the project ends up half-founded if the user changes their mind. |
| "I'll fill what I know and leave `_(TBD)_` for the rest" | TBD placeholders are the failure mode this command exists to prevent. Draft best-effort content, mark `<!-- refine: -->`, ask the user. |
| "This is a big codebase, founding doesn't apply" | Existing code makes founding MORE valuable — the charter records what the code is for. |

### Anti-rationalization counters

- "Faster to write files incrementally as we decide each piece" — no: incremental writes make "undo" expensive. Batch on approval.
- "The user obviously wants this, they ran the command" — they want the project founded; they have not yet seen the proposed content.
- "A generic roadmap is better than none, I'll write it now" — even a generic roadmap is a commitment; show it first.

---

## Group Execution Pattern

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
- Idea should already be clear before running this — use `/brainstorm-idea` to get there
- Founding = content; `momentum init` = structure. Never scaffold placeholder docs.
- Phase 0 scope should be achievable in a focused sprint
- Architecture sketch is a starting point, not a commitment
- Record all key decisions from the dialogue in Phase 0's `history.md`
- **Brainstorm Gate**: see the contract above. Writing only after explicit approval.
