Cross-session control transfer with a structured context block. Writes `<toRepo>/.momentum/inbox/handoff-NNN.md` so a fresh agent session in that repo can pick up where you left off, and emits a `[DECISION]` in this repo's active phase history.

> **Three doors, one library.** This is the slash-command door for Claude Code. The CLI door is `momentum handoff <repo> [flags]` and the natural-language inference door fires when the user describes a control-transfer task ("now continue in X"). All three doors call `core/orchestration/handoff.js`.

## When to use

- You finished work in repo A and want the next session in repo B to continue with full context.
- You hit a stopping point that requires switching repos and want decisions preserved.
- DO NOT use handoff for read-only context fetches — use `/scout` for that. DO NOT use handoff for multi-repo audits — use `/dispatch`.

## Inference guidance (read this in non-slash contexts too)

Treat ANY of these as a handoff invocation:

- "Now switch to <repo> and continue."
- "I'm done here — pick up in <other repo>."
- "Hand off the rest to <repo>."

When inferring, narrate it: `▸ inferred: handoff (control transfer). Use /handoff next time for predictable behavior.`

## Usage

```
/handoff <repo> [optional one-line summary]
```

`<repo>` is a member id from `ecosystem.json` (or a path). The slash command will infer the context block from this session — recent edits, key decisions, files touched, suggested verification commands, any open questions.

## Steps

### Step 1 — Identify the target repo + summary

Resolve `<repo>` via `ecosystem.json`. If the user provided a summary line, use it. Otherwise, generate a one-line summary that captures what work remains to be picked up.

### Step 2 — Collect the context block

Pull together (inferred from THIS session's history):

- `decisions[]` — ADRs created, technology choices made, or other significant choices.
- `filesTouched[]` — the files edited in this session.
- `verificationCommands[]` — what to run to confirm the picked-up state (tests, lints, smoke commands).
- `openQuestions[]` — anything the receiving agent needs to resolve.

Keep it tight — the receiving agent will read this first.

### Step 3 — Write the handoff

```js
const orchestration = require('<momentum-root>/core/orchestration');
const block = await orchestration.handoff.handoff({
  fromRepo: '<this repo absolute path>',
  toRepo: '<target repo absolute path>',
  summary: '<one-line>',
  decisions: [...],
  filesTouched: [...],
  verificationCommands: [...],
  openQuestions: [...],
  ecosystem: { rootPath: '<ecosystem root>', memberId: '<this repo member id>' },
});
```

This writes `<toRepo>/.momentum/inbox/handoff-NNN.md`, appends one line to the ecosystem session log, AND emits a `[DECISION]` in this repo's active phase `history.md` (handoff IS a cross-repo decision).

### Step 4 — Tell the user

Output:

```
▸ handoff written: <toRepo>/.momentum/inbox/handoff-NNN.md
▸ logged [DECISION] in <originating phase>/history.md

Next: open a fresh session in <toRepo>. The SessionStart hook will detect
the handoff and prompt "Read now? [y/skip]". Or run /continue (or
`momentum continue`) explicitly.
```

## Tracking contract

- **Auto every time:** session log line + `.momentum/inbox/handoff-NNN.md` in receiving repo + `[DECISION]` entry in originating active phase history.
- **Never:** `[HANDOFF]` entry types. Use existing `[DECISION]`.

## Errors

- Target repo doesn't exist → report and stop.
- Target repo is the same as the originating repo → report (handoff to self is meaningless) and stop.
