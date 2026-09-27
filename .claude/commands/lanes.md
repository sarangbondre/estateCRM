Work with lanes — concurrent workstreams in one repo (Rule 15 mechanism).

> **Which phase is yours (Rule 15):** the phase bound to your branch;
> `momentum lanes` shows every lane in flight. The board is the
> cross-lane overview — your branch is still the binding.

## When to use

- The user asks "what's running?", "what else is in flight?", or wants to
  start a second workstream without abandoning the first.
- You are about to start work that should NOT live on the current branch.
- A finished lane needs to be landed in order.

## Subcommands

All state lives at `<git-common-dir>/momentum/lanes` — shared by every
worktree, untracked, no daemon. Run from anywhere inside the repo.

### See the board

```bash
momentum lanes            # every lane: plan node, grade, status, age, ✉ unread, ⚠ overlaps
momentum lanes queue      # landing order (FIFO of done lanes) + freshness flags
```

The board footer always shows **queue pressure** (done-but-unlanded lanes
+ oldest wait). Rising pressure means landings — the human-attention step
— are the bottleneck; surface it to the user rather than opening more lanes.

### Plan waves first (N ideas → N lanes)

```bash
momentum waves            # phase-scale waves from overview.md frontmatter "deps"
momentum waves --tasks    # group waves for the phase bound to your branch
```

Dependencies are annotations in the plans themselves (`(deps: G0, G1)`
group-heading suffix; `deps:` frontmatter on each phase's overview.md —
OKF bundle, ADR-0005; legacy `specs/phases/index.json` still read as a
fallback until the project runs `momentum upgrade`).
Wave-1 nodes are safe to open as lanes NOW; later waves unblock as their
dependencies land.

### Open a lane

```bash
momentum lanes open <branch> [--grade phase|quick-task|spike] \
  [--touches core/**,docs/] [--path <dir>] [--from <ref>] [--no-worktree]
```

- Creates a git worktree at `../<repo>.lanes/<id>` by default (reuses an
  existing checkout of the branch; `--no-worktree` for GitButler-style
  virtual branches).
- The plan node and grade are inferred from the branch name (Rule 15:
  `phase-*` ↔ phase directory; `fix/* chore/* feat/*` → ad-hoc
  quick-task); spikes must be declared with `--grade spike`.
- Declare `--touches` honestly — overlap warnings (advisory) are how
  parallel lanes avoid semantic collisions before any agent runs.
- Heed preflight warnings (non-executable committed scripts, node
  version) — they are the fresh-worktree traps.

### Signal another lane's session

```bash
momentum lanes signal <id> <pause|resume|redirect|kill|message> [text]
momentum lanes inbox <id> [--ack <seq>|--ack-all]
```

Check YOUR lane's inbox at natural checkpoints (group boundaries, before
landing) and ack what you've acted on.

### Mark done and land

```bash
momentum lanes done <id>          # enter the landing queue
momentum lanes land <id>          # validate: turn, freshness, graded gate
momentum lanes land <id> --execute# merge --no-ff into the CURRENT branch
momentum lanes close <id> [--rm-worktree]   # retire: full cleanup (branch + state)
```

Landing follows the Rule 6 **Landing Order**: one lane at a time, run the
suite on the updated integration branch before the next landing,
remaining lanes rebase (they get an advisory inbox nudge automatically).
Gates are graded per Rule 14: a `spike` lands gate-exempt; a `quick-task`
needs its `specs/adhoc/<id>/record.md`; a `phase` needs a retrospective
with a non-empty `## Verification Evidence` section (Rule 12).
`land` never pushes — pushes to protected branches keep their own
approval gate.

### Cleanup — a landed lane is spent (BUG-026)

```bash
momentum lanes reconcile             # report lanes now merged out-of-band (human/forge)
momentum lanes reconcile --execute   # clean them: worktree + branch + state
momentum lanes cleanup <branch> [--worktree P] [--dry-run]   # one branch, manually
```

When the AGENT lands on the terminal branch (`branch_flow` last entry),
`land --execute` **auto-cleans** the worktree + branch + lane state
(default-branch-safe; `--keep` opts out). When a HUMAN or the FORGE does
the terminal merge (`end_state` `staging-promotion` / `feature-branch-only`
/ `open-pr`), cleanup is deferred: run `momentum lanes reconcile` — it
cleans only lanes whose branch is a **verified ancestor** of the terminal
branch (a "yes, I merged it" is never trusted, Rule 12). Cleanup never
deletes a branch that is the forge default (the BUG-025 guard).

## Tracking

Opening/closing lanes is not itself phase history; the WORK inside a lane
follows the normal rules (Rule 2 tracking, Rule 8 history in the lane's
own phase, Rule 15 own-row/append-only discipline for shared files).
