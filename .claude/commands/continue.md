Pick up a pending handoff in this repo. Reads `.momentum/inbox/handoff-NNN.md`, parses the structured context block, marks the inbox file as read, and emits a `[NOTE]` in the receiving repo's active phase history.

> **Three doors, one library.** This is the slash-command door for Claude Code. The CLI door is `momentum continue [--handoff <id>]`. The auto-greet door fires via the SessionStart hook when you open a fresh session with pending handoffs. All three call `core/orchestration/continue.js`.

## When to use

- The SessionStart auto-greet hook printed a "1 pending handoff" banner and you typed `y`.
- You know there's a pending handoff from another repo and want to start with that context.
- You want to list pending handoffs and pick one explicitly.

## Usage

```
/continue                     pick up the OLDEST pending handoff
/continue <id>                pick up handoff-<id> specifically
/continue list                list pending handoffs without picking
```

## Steps

### Step 1 — List or pick

If `list`, run:

```js
const orchestration = require('<momentum-root>/core/orchestration');
const pending = orchestration.continueHandoff.listPending('<this repo>');
```

Render: `▸ N pending handoff(s):` then `▸ <id> from <fromRepo>: <summary>`. Stop.

Otherwise, pick:

```js
const block = await orchestration.continueHandoff.continueHandoff({
  repo: '<this repo absolute path>',
  handoffId: '<id-if-specified>', // omit for oldest
  ecosystem: { rootPath: '<ecosystem root>', memberId: '<this repo member id>' },
});
```

This parses the inbox file, moves it to `.momentum/inbox/read/`, and emits a `[NOTE]` in this repo's active phase history (handoff pickup IS a meaningful event worth tracking).

### Step 2 — Act on the block

Narrate it to the user:

```
▸ picking up handoff-NNN from <fromRepo>

Summary: <summary>

Decisions:
  - <decision 1>
  - <decision 2>

Files touched (in originating session):
  - <file 1>
  - <file 2>

Verification:
  $ <command 1>

Open questions:
  ? <question 1>
```

Then proceed with the work the handoff describes — the user shouldn't have to re-explain anything.

### Step 3 — Don't surprise the user

If the handoff is large (>30 lines of decisions/files), summarise + offer "want me to read the full block? [y/n]" before diving in. Otherwise just proceed.

## Tracking contract

- **Auto every time:** inbox file moved to `read/` + `[NOTE]` in receiving repo's active phase history referencing the picked-up handoff.

## Errors

- No pending handoffs → "no pending handoffs in this repo" and stop. NOT an error.
- Specified handoff id not found → error with list of pending ids.
- Inbox file is malformed → error pointing at the file with a hint to inspect.
