Parallel multi-project fan-out + synthesis. One sub-agent per listed project, each tailored to the user's intent: audit (read-only) or fix (writes allowed, on a feature branch). All results synthesised into a single answer. Writes one dispatch-NNN.md artifact and one session log line.

> **Three doors, one library.** This is the slash-command door for Claude Code. The CLI door is `momentum dispatch <r1> <r2> ... --prompt "<text>"` and the natural-language inference door fires when the user describes a multi-repo audit / alignment task. All three doors call `core/orchestration/dispatch.js` so the output shape is identical.

## When to use

- "What breaks if I rename X across all repos?" — multi-project audit (sub-agents stay read-only by intent).
- "Get me the current state of A AND B so I can align a change." — pre-coordination context fetch (read-only by intent).
- "Where does Y come from across the stack?" — cross-cutting investigation (read-only by intent).
- "Fix the same typo in all three repos." — one-shot multi-project change (sub-agents write on feature branches; you review per repo).
- "Bump the lint config to v2 across the stack." — repeatable code-mod (writes allowed).

Do NOT use `/dispatch` for **sustained multi-step features that need wave ordering, contracts, or a persistent saga** — use [`/swarm`](/swarm/) instead. Do NOT use it when you want to TRANSFER control rather than fan it out — use `/handoff`. Do NOT use it for single-project tasks — use `/scout` or just work in that project directly.

## Inference guidance (read this in non-slash contexts too)

Treat ANY of these as a dispatch invocation even without an explicit `/dispatch`:

- "Audit X across repos A, B, C."
- "What's the state of A, B, and C right now?"
- "Find every place that does X across the ecosystem."

When inferring, narrate it: `▸ inferred: dispatch (multi-repo audit). Use /dispatch next time for predictable behavior.`

Do NOT use dispatch for single-repo questions — use `/scout`. Do NOT use dispatch when you want to TRANSFER control rather than just READ — use `/handoff`.

## Usage

```
/dispatch <repo1> <repo2> [repo3 ...] "<user intent>"
```

Repos are member ids from `ecosystem.json` (or relative/absolute paths).

## Steps

### Step 1 — Identify the targets + intent

Resolve each repo arg to an absolute path via the ecosystem manifest. Capture the user's high-level intent (the rest of the slash-command line).

### Step 2 — Capability-route the dispatch mode

```js
const orchestration = require('<momentum-root>/core/orchestration');
const adapter = orchestration.capabilityRouting.loadAdapter('<momentum-root>', 'claude-code');
const { mode, notes } = orchestration.capabilityRouting.chooseMode(adapter, 'dispatch');
```

Claude Code declares `parallelSubagents: true` — `mode='parallel'`, no notes. If you're on an adapter where `mode='sequential'`, narrate the note up front (`▸ <degraded-mode note>`) so the user knows what they're getting.

### Step 3 — Fan out sub-agents (parallel on Claude Code)

For EACH target repo, in a SINGLE message use the Task tool to spawn a sub-agent with:

- Sub-agent system prompt: "You are a DISPATCH SUB-AGENT for momentum's quick-verb layer. You are working in `<repo>`. The user intent below is authoritative — if it asks to audit / investigate / report, return a structured JSON result without writing files. If it asks to fix / refactor / migrate, you may write code, but commit on a feature branch per Rule 6 (Git Lifecycle) and surface the branch name in your result so the originating session can review. When in doubt about whether to write, prefer reading and surface the proposed change in `findings` instead."
- Sub-agent task prompt: user intent + the specific repo.
- If the originating session is in read-only mode (the user passed `--read-only` to the CLI floor, or the recipe was invoked with the `--read-only` flag), prepend an explicit "READ-ONLY: do not write any files" line to the sub-agent system prompt regardless of intent.
- Expected return shape (sub-agent renders as a single JSON block):

```json
{
  "repo": "<absolute path>",
  "summary": "...one-paragraph answer focused on this repo...",
  "filesRead": ["..."],
  "filesWritten": ["..."],
  "branch": "feat/short-desc",
  "findings": [
    { "kind": "discovery", "title": "...", "detail": "...", "recommendedBacklogPriority": "P2", "recommendedBacklogType": "tech-debt" }
  ]
}
```

`filesWritten` + `branch` are present only when the sub-agent actually wrote (user intent was a fix/refactor/migrate). For pure audits, omit them. `findings` apply Rule 3 thresholds.

Sub-agents run concurrently because they are dispatched in the same message — Claude Code's Task tool runs each in its own context.

### Step 4 — Wait for all sub-agents, capture failures

If any sub-agent fails or returns no result, capture the failure with `{ repo, error: { message } }` and CONTINUE. Never abort the whole dispatch on a single sub-agent failure — the synthesis still proceeds with partial results.

### Step 5 — Synthesise

Read the per-repo results IN THIS AGENT'S CONTEXT and produce a synthesis paragraph that DIRECTLY ANSWERS the user's intent. Mention any failures explicitly in the synthesis (don't let them disappear).

### Step 6 — Record the run

```js
orchestration.dispatch.record({
  repos: [/* absolute paths */],
  userIntent: '<user intent>',
  mode,
  modeNotes: notes,
  perRepoResults: [/* per-repo entries */],
  failures: [/* entries with .error */],
  synthesis: '<your synthesised paragraph>',
  originatingRepo: '<this repo absolute path>',
  ecosystem: { rootPath: '<...>', memberId: '<...>' },
  duration: <ms>,
});
```

This writes `.momentum/runs/dispatch-NNN.md` (synthesis + collapsible per-repo blocks + failure manifest) and appends one line to the ecosystem session log.

### Step 7 — Hand findings to the tracking contract

For each finding from each per-repo result, call:

```js
orchestration.tracking.proposeDiscovery({
  primitive: 'dispatch',
  finding,
  targetRepo: '<repo where the finding was identified>',
});
```

Synthesis itself gets a `[NOTE]` in the ORIGINATING repo's active phase history when it answers a meaningful coordination question; pass through:

```js
orchestration.tracking.proposeHistoryNote({
  primitive: 'dispatch',
  originatingRepo,
  message: '<one-line summary of what dispatch surfaced>',
  runArtifactRef: '<.momentum/runs/dispatch-NNN.md>',
});
```

### Step 8 — Render the result

Output to the user:

```
▸ Synthesis
<synthesis paragraph>

▸ Per-repo (expand to see detail)
  ▼ <repo1>: <one-line>
  ▼ <repo2>: <one-line>
  ...

→ logged to sessions/<today>.md
→ trace at .momentum/runs/dispatch-NNN.md
```

## Tracking contract

- **Auto every time:** session log line + dispatch-NNN.md artifact.
- **Auto only when meaningful:** per-repo `[DISCOVERY]` in each scouted repo's active phase history; `[NOTE]` in the originating repo's active phase history when the synthesis records a meaningful cross-repo state.
- **Never:** `[DISPATCH]` entry types or `backlog.md` entries without explicit user confirmation.

## Errors

- A repo arg doesn't resolve → emit a warning, skip it, continue with the rest.
- All repo args fail to resolve → abort with error.
- A sub-agent throws → captured in `failures[]`, synthesis still runs.
