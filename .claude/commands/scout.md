Read-only context fetch from one ecosystem member repo. Returns a structured summary, writes a scout-NNN.md run artifact, and appends one line to the ecosystem session log.

> **Three doors, one library.** This is the slash-command door for Claude Code. The CLI door is `momentum scout <repo> "<prompt>"` and the natural-language inference door fires when the user describes a single-repo, read-only context-fetch task without naming a primitive (see "Inference guidance" below). All three doors call `core/orchestration/scout.js` so the output shape is identical.

## When to use

- You're about to make a change in this repo but you need to know the current state of a related repo first (auth shape, API contract, schema, recent decisions).
- A user asks "what's the situation in `<repo>`?" — that's scout.
- You want a durable record of a context-fetch you just did, not just a chat message.

## Inference guidance (read this in non-slash contexts too)

Treat ANY of these as a scout invocation even without an explicit `/scout`:

- "What's the current X in repo Y?"
- "Before I make the change here, get me the latest state from `<sibling repo>`."
- "Read repo Y and tell me about its current Z."

When inferring, narrate it: `▸ inferred: scout (single repo, read-only). Use /scout next time for predictable behavior.`

Do NOT use scout for multi-repo questions — use `/dispatch`. Do NOT use scout when you're about to write into the target repo — use `/handoff`.

## Usage

```
/scout <repo> "<prompt>"
```

`<repo>` is either a member id from `ecosystem.json` or a relative/absolute path. `<prompt>` is the user's question.

## Steps

### Step 1 — Identify the target repo + prompt

Parse the user's invocation. If they said `/scout sapience auth endpoint shape` then:

- repo = `sapience`
- prompt = `auth endpoint shape`

Resolve `sapience` to an absolute path via the ecosystem manifest (`ecosystem.json` → `members[]`).

### Step 2 — Spawn a read-only sub-agent

Use the Task tool with a prompt that:

1. Tells the sub-agent: "you are a SCOUT for momentum's orchestration layer."
2. Provides the target repo path and the user's prompt.
3. Instructs the sub-agent to: read `specs/status.md`, recent files under `specs/architecture/` and `specs/phases/<active>/history.md`, and any keyword-matching files. NO writes.
4. Asks the sub-agent to return a structured JSON object:
   ```json
   {
     "summary": "...one-paragraph answer to the prompt...",
     "filesRead": ["specs/status.md", "..."],
     "findings": [
       { "kind": "discovery", "title": "...", "detail": "...", "recommendedBacklogPriority": "P2" }
     ]
   }
   ```
   `findings` should ONLY include real bugs, real tech debt, real enhancements — applying the same threshold as Rule 3 (Auto-Track Discoveries). DO NOT include orchestration metadata or anything that doesn't deserve a backlog entry.

### Step 3 — Record the run

Once the sub-agent returns:

```js
const orchestration = require('<momentum-root>/core/orchestration');
const result = orchestration.scout.record({
  repo: '<resolved repo path>',
  prompt: '<user prompt>',
  summary: '<sub-agent summary>',
  filesRead: [/* ... */],
  findings: [/* ... */],
  ecosystem: { rootPath: '<ecosystem root>', memberId: '<this repo member id>' },
  duration: <ms>,
});
```

This writes `.momentum/runs/scout-NNN.md` in THIS repo (originating) and appends one line to the ecosystem session log. The library handles run-id allocation.

### Step 4 — Hand findings to the tracking contract

For each finding the sub-agent returned, call:

```js
orchestration.tracking.proposeDiscovery({
  primitive: 'scout',
  finding,
  targetRepo: '<scouted repo path>',
});
```

The helper applies Rule 3 criteria. If `shouldWrite=true`, it appends a `[DISCOVERY]` entry to the scouted repo's active phase history. If `shouldWrite=false`, only the session log line above stays — no curated-layer write.

### Step 5 — Narrate the result

Output the summary, then the artifact path:

```
▸ scout <repo>: <prompt>
  ▸ reading specs/status.md
  ▸ reading specs/architecture/...
  ▸ found: <finding summary>   (one line per finding written by tracking)

<summary text>

→ logged to sessions/<today>.md
→ trace at <artifact path>
```

## Tracking contract

- **Auto every time:** ecosystem session log line + scout-NNN.md artifact in THIS repo.
- **Auto only when meaningful:** `[DISCOVERY]` entry in the SCOUTED repo's active phase history, when the agent judges a finding worth backlog tracking (Rule 3 thresholds). NEVER write `[SCOUT]` entries — use existing entry types.
- **Never:** `backlog.md` entries without explicit user confirmation. Tracking helper proposes; user OKs.

## Errors

- Repo not found in ecosystem manifest → report and stop.
- Repo not in any ecosystem (this repo is standalone) → fall back to running scout in-process via CLI; suggest the user run `momentum scout <path> "<prompt>"` directly.
