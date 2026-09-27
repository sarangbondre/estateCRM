Append a manual narrative entry to today's ecosystem session log.

The session log auto-fills with structural events (commits, PR
opens/merges) via the PostToolUse hook in each registered member repo.
Use `/session log` for narrative entries — decisions, problems hit,
checkpoint notes — that don't correspond to a tool event.

## Usage

```
/session log "<message>"
```

## Steps

1. Locate the ecosystem root via
   `core/ecosystem/lib/index.js → findRoot(process.cwd())`.
   If no ecosystem root exists, refuse with a clear message: "Not
   inside an ecosystem. Run `momentum ecosystem init` first or `cd`
   into a registered member repo."

2. Determine the calling member id (when relevant): match
   `realpath($PWD)` against each `manifest.members[].path`. If no
   match, write the entry with a `[meta]` tag instead.

3. Build the line:
   ```
   HH:MMZ [<member-id-or-meta>] note: <message>
   ```

4. If today's session file doesn't exist yet, prepend a header:
   ```
   # Session YYYY-MM-DD
   Active initiative: <slug>      (if .state/active-initiative is set)

   ```

5. Append the line to `<ecosystem-root>/sessions/$(date -u +%F).md`.

6. Update `<ecosystem-root>/.state/last-session` to today's date.

7. Print confirmation:
   ```
   Logged: HH:MMZ [<member-id>] note: <message>
   ```

## When to use vs auto-events

| Use `/session log` for… | Auto-events already cover… |
|---|---|
| "Decided to defer X to Tier 2" | `git commit` (the actual change record) |
| "Discovered the SQL was dropping scope filter" | `gh pr create/merge` |
| "Bumped Y version pin in lock to address Z" | future: deploy events (Group 3 v2) |
| "Switching context from sapience to frontend" | future: hook-detected directory changes |

## Mechanism

`/session log` is a thin wrapper around the same
`core/ecosystem/scripts/session-append.sh` helper used by the
PostToolUse hook. From bash:

```bash
$MOMENTUM_SCRIPTS/session-append.sh log "<message>" "<optional-context>"
```

## Idempotency / safety

- Multiple `/session log` calls in the same minute produce multiple
  lines. Concurrent writes (a `/session log` plus a `git commit` hook
  in another member repo at the same instant) are serialized via a
  per-session-file `mkdir` lock (Phase 10 / BUG-004). ~5s acquisition
  budget; on timeout the event is dropped rather than risking
  corruption.
- The walk-up that locates the ecosystem root honors the
  `MOMENTUM_MAX_PARENT_WALK` env var (default 5).
- Outside an ecosystem the helper silently no-ops, so harmless to
  invoke speculatively.
- The session log is gitignore-free (committed) but `.state/` is not —
  to share session history across machines, push the ecosystem repo.
