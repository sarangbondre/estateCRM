Run a multi-perspective code review of the pending changes on the current branch.

> **This command is Claude-Code-specific.** It uses the Task tool to dispatch
> role-based subagents in parallel. Equivalent functionality for other agents
> would live in their respective `adapters/<agent>/commands/` overlay (e.g.,
> Cursor would ship a prompt-based variant). Do not generalize this into
> `core/commands/` — generalization would lose the parallel-subagent value.

## When to use

- Before `/sync-docs` and `/complete-phase` at the end of a phase
- After a non-trivial commit on a feature branch, before opening a PR
- Whenever you want a fresh, independent read on what was just built

This command does NOT modify code. It produces a consolidated review and asks
you which findings to act on.

## Steps

### Step 1 — Determine review scope

Default scope: the diff between the current branch and `main`. Run:
```bash
git diff main...HEAD --stat
git diff main...HEAD
```

If the user passed an argument, honor it:
- `staged` → `git diff --cached`
- `working` → `git diff` (unstaged changes)
- `<commit-sha>` → `git diff <commit-sha>...HEAD`
- `<file-path>` → restrict review to that path within the default scope

If no diff exists, report "no changes to review" and stop.

### Step 2 — Read the rules of the project

Before dispatching reviewers, read:
- `CLAUDE.md` (rules and constraints — the complete rulebook)
- `specs/status.md` (current phase context)

This ensures every reviewer scores the diff against THIS project's rules,
not generic best practices alone.

### Step 3 — Dispatch reviewers in parallel

Use the Task tool to spawn three subagents in **a single message with three
parallel tool calls** (do NOT serialize). Each subagent gets the same diff
and the same rules context, but a different role.

#### Reviewer A — Security (OWASP / STRIDE)

Prompt template:
> You are reviewing a code diff for **security only**. Use the OWASP Top 10
> and STRIDE threat categories as your lens.
>
> Diff:
> ```
> <paste the diff from Step 1>
> ```
>
> Project rules excerpt:
> ```
> <paste the relevant constraints from CLAUDE.md — especially "No secrets in code">
> ```
>
> Return findings in this exact format:
>
> ```
> ## Security review
>
> ### Critical
> - [finding] (file:line) — [why it's critical]
>
> ### Important
> - [finding] (file:line) — [explanation]
>
> ### Minor
> - [finding] (file:line) — [explanation]
> ```
>
> If no findings at a severity level, write "(none)". Do NOT speculate beyond
> what the diff shows. Do NOT propose code fixes — only flag the issue.

#### Reviewer B — QA (test coverage, edge cases, regressions)

Prompt template:
> You are reviewing a code diff for **test coverage and edge cases only**.
>
> Diff:
> ```
> <paste the diff from Step 1>
> ```
>
> Project rules excerpt:
> ```
> <paste Rule 12 (Verify Before Claim) from CLAUDE.md>
> ```
>
> For each meaningful behavior change in the diff, ask:
> - Is there a test that exercises it?
> - What edge cases are uncovered (empty input, large input, concurrent
>   access, error paths)?
> - Could this break an existing test or production path?
>
> Return findings in the same Critical/Important/Minor format as the security
> reviewer. "(none)" when applicable.

#### Reviewer C — Architecture (rule compliance, pattern consistency)

Prompt template:
> You are reviewing a code diff for **architectural fit and rule compliance**.
>
> Diff:
> ```
> <paste the diff from Step 1>
> ```
>
> Full rules:
> ```
> <paste CLAUDE.md (rules section)>
> ```
>
> For each change, ask:
> - Does it violate any of the 12 autonomous rules?
> - Does it match the patterns established elsewhere in the codebase?
>   (Check 2-3 nearby files for convention.)
> - Does it create a hidden coupling, a leaky abstraction, or an
>   adapter/contract violation?
> - Is it documented where rules say it should be (history.md, ADR, etc.)?
>
> Return findings in the Critical/Important/Minor format. "(none)" when
> applicable.

### Step 4 — Consolidate

Once all three subagents return:

1. Merge findings into a single report ordered:
   ```
   ## Code Review

   ### Critical (N)
   - [security] finding (file:line)
   - [arch] finding (file:line)

   ### Important (N)
   - [qa] finding (file:line)
   - [security] finding (file:line)

   ### Minor (N)
   - [arch] finding (file:line)
   ```
2. Tag each finding with its reviewer (`[security]`, `[qa]`, `[arch]`).
3. De-duplicate findings that multiple reviewers raised — combine into one
   line and tag with all reviewers (`[security][arch]`).
4. If a finding is at Critical and conflicts with a Minor finding from a
   different reviewer, surface BOTH and note the disagreement.

### Step 5 — Present to user, ask what to act on

Show the consolidated report. Then ask:
> "Which findings should I act on now? Options:
>   1. All Critical
>   2. All Critical + Important
>   3. Specific items (list IDs)
>   4. None — log all findings to backlog only
>   5. Cancel"

For findings the user wants to act on now: implement them as separate commits
on the current branch (each commit ≤ one finding).

For findings the user wants to defer: add each as a backlog item via the
`/track` flow with appropriate priority (Critical → P0/P1, Important → P1/P2,
Minor → P2/P3).

### Step 6 — Honor Rule 12 on any fixes

If you implement any fix in Step 5, run the relevant verification (test,
lint, typecheck) BEFORE marking it done — per Rule 12 (Verify Before Claim).

## Constraints

- Subagents are **read-only**: they MUST NOT edit files, run code-modifying
  commands, or commit. They return findings as text only.
- Dispatch all three subagents in a **single message with parallel tool
  calls** — do not sequence them.
- The review NEVER auto-fixes findings. The user always decides what to act
  on (Step 5).
- Findings tied to specific lines should include `file:line` so the user can
  navigate quickly.
- If a reviewer's output is malformed (missing severity headers), re-dispatch
  that single reviewer with a stricter format reminder. Do not silently
  reformat — that hides reviewer mistakes.
