Swarm — sustained parallel multi-project feature delivery (Phase 17, v0.20.0).

A **swarm** is a declared cross-repo work unit driven from ONE user session. The user's session becomes the **conductor**. The conductor spawns one **supervisor** subagent per impacted repo, each pinned to that repo's working directory with its own fresh context. Each supervisor runs momentum's normal `/start-phase` → implement → `/sync-docs` → `/complete-phase` loop INSIDE its repo. The conductor coordinates waves (computed from `ecosystem.json` dependency edges), surfaces inbox decisions, broadcasts cross-cutting concerns, and synthesizes per-repo retrospectives at fan-in.

> v0.20.0 ships Claude Code only. Codex + Antigravity parity is Phase 18.

> **⚠ DEPRECATED — the wave runner, not the whole subsystem (Phase 32a, BUG-031).**
> `--mode autopilot`'s wave advance has **never had a production caller**:
> `pollTurn` and `recordRepoComplete` are referenced only by tests, there is no
> `poll` subcommand, and wave-1 spawn directives are the only ones ever built.
> Launch a swarm today and the board freezes at wave-1-start. It is **not being
> repaired** — even wired it drives one phase per repo, which the
> tier-parameterized runner (`momentum run`, Epic 0001) supersedes; removal
> lands in **Phase 32d**. The **inbox protocol** and **wave ordering** are
> retained and already in use by the new runner. For multi-phase or multi-repo
> autonomous work, use `momentum run`.

## Architecture

| Layer | Owns | Reads |
|---|---|---|
| Conductor (this user session) | `<eco>/swarms/<id>/manifest.json` + `board.json` + `contracts/` + `inbox/` + `signals/` + `changes/` | Per-supervisor `dispatch-run-<id>.json` (status) |
| Supervisor (per repo, background) | `<repo>/specs/phases/phase-N-<slug>/*` + `<repo>/.momentum/runs/dispatch-run-<id>.json` | Its phase brief + contract + history.md tail |

Agents are stateless across turns; **state lives in files**. A swarm survives session boundaries the same way a phase does — every state-changing action writes to disk; `/swarm resume` reconstitutes from disk.

## When to use

- A feature spans **two or more momentum-installed repos** AND has dependency ordering (frontend depends on backend depends on shared-types).
- The user wants ONE session driving the whole feature, not three serial sessions.
- An initiative exists or is about to exist at `<eco>/initiatives/<slug>.md`.

Do NOT use `/swarm` for:
- Read-only cross-repo audits — use `/dispatch`.
- Single-repo phases — use `/start-phase` directly.
- Pure context transfer — use `/handoff`.

## Subcommands

The slash command form mirrors the CLI: `/swarm <sub> [args]`. The CLI floor is `momentum swarm <sub> [args]` — pick whichever door fits the moment. Both produce the same on-disk artifacts.

---

### `/swarm start <slug> --initiative <slug> --repos r1,r2,... --phase <phase-slug> [--mode checkpoint|autopilot]`

Plan + spawn Wave 1.

**Step 1 — Present the plan and ask for approval.**

Compute the wave plan in-process (no spawn yet) by calling the CLI floor in dry-run:

```bash
momentum swarm start <slug> --initiative <slug> --repos r1,r2,... --phase <phase-slug> --mode <mode> --json
```

Read the JSON. Render the wave plan to the user:

```
▸ Swarm <NNNN-slug> — planned (not yet spawning)
  Initiative: <slug>
  Mode: <mode>
  Waves:
    Wave 1: <r1>, <r2>
    Wave 2: <r3>
    Wave 3: <r4>
  Token budget: 300k per supervisor (override with /swarm budget)
  Lease: 24h per repo, renewed each turn

Proceed?
```

WAIT for user approval. If `mode = autopilot`, plan approval is the only checkpoint until completion. If `mode = checkpoint`, you'll also pause between waves.

**Step 2 — Spawn Wave 1 supervisors (foreground synthesis, background sessions).**

After approval, spawn one Claude Code background session per Wave 1 repo. The CLI does this when invoked with `--spawn`:

```bash
momentum swarm start <slug> --initiative <slug> --repos ... --phase <phase-slug> --mode <mode> --spawn
```

If `claude --bg` is not available in this env, the CLI surfaces the spawn directives and exits — degrade by reporting the directives to the user (they can launch sessions manually) and continue with conductor polling on the existing manifest.

**Step 3 — Begin the conductor poll loop.**

See `/swarm status` (next subcommand). On every conductor turn:

1. Read `<eco>/swarms/<id>/board.json` (≈3KB).
2. Read `<eco>/swarms/<id>/inbox/INDEX.md`.
3. If `inbox_count > 0`, surface each pending item; resolve interactively.
4. If a supervisor reports `done: true` for the active wave's last repo, run the wave checkpoint flow (see `/swarm verify` — Phase 17 G2).

---

### `/swarm status <swarm-id>`

Render the materialized board cache. Read-only — no manifest mutation. Strategy A from the indexing design: conductor reads ONLY `board.json` (~3KB).

```bash
momentum swarm status <swarm-id>
```

Default output is a rendered ANSI table. Pass `--json` for machine-readable.

Surface:
- Per-repo: wave, status, tasks N/M, tokens used/budget, commits, current task.
- `inbox_count` warning at the bottom if > 0.
- Recent activity tail (last 10 audit events).

When inboxes are pending, prompt: "Run `/swarm verify <id>` to surface the questions, or `/swarm tell <id> <repo> '...'` to push context to a specific supervisor."

---

### `/swarm claim <swarm-id> <repo> [--session <id>] [--lease-hours 24]`

> Phase 17.5 / v0.20.2 — multi-session ownership primitive.

Claim ownership of `<repo>` inside `<swarm-id>` for the current session. The conductor library uses this whenever a session needs authority to write to a repo's manifest entry — `/swarm focus`, `/swarm join`, and a co-conductor taking a wave all compose `claim` under the hood.

```bash
momentum swarm claim <swarm-id> <repo> [--session <id>] [--lease-hours 24]
```

Claim succeeds when:
- the repo is `_unclaimed` or `_focusing` (sentinel — anyone may claim), OR
- the current owner's `lease_expires_at` is in the past (takeover; audit logs both `claim` and `lease-takeover`).

Claim is rejected when the current owner's lease is still valid; the CLI writes a `claim-request` signal so the existing owner sees the request on their next conductor poll. Exit code 1 on rejection.

On success the manifest sets `owner = <session>`, refreshes `lease_renewed_at`, and sets `lease_expires_at = now + <lease-hours>`. The board cache is refreshed.

---

### `/swarm focus <swarm-id> <repo> [--session <id>] [--expires-min 60]`

> Phase 17.5 / v0.20.2 — split one repo off the swarm into a side-session.

Issue a single-use focus token for `<repo>` and hand control to a second Claude Code session. Use when one repo needs sustained one-on-one attention without halting the rest of the swarm. The original conductor keeps every other repo; the new side-session takes `<repo>` and drives its phase to completion. Reunite via `/swarm absorb`.

```bash
momentum swarm focus <swarm-id> <repo> [--session <id>] [--expires-min 60]
```

Behavior:
1. Asserts the caller currently owns `<repo>` (rejected with exit 1 if not).
2. Issues an opaque focus token at `<eco>/swarms/<id>/tokens/<token>.json` (single-use, 1-hour default expiry).
3. Flips `repos[<repo>].owner` to the `_focusing` sentinel — anyone with the token may claim.
4. Writes a `focus-request` signal carrying the token + repo.
5. Audit-logs `focus`.
6. Prints a spawn directive — run `claude --bg --cwd <eco>` in a second terminal, then inside that session call `momentum swarm join <swarm-id> --token <token>`.

The token is single-use: consuming it (via `/swarm join --token`) deletes the file and atomically flips ownership to the receiver. If the token expires before consumption, run `/swarm claim <repo>` against the FOCUSING sentinel to recover.

---

### `/swarm join <swarm-id> [--token <token>] [--claim <repo>] [--session <id>]`

> Phase 17.5 / v0.20.2 — register a session with an existing swarm.

Attach the current session to `<swarm-id>` as a co-conductor. Adds the session to `sessions[]` (idempotent — touch on re-join), auto-renews any repos the session already owns, and optionally consumes a transfer token or claims a specific repo.

```bash
momentum swarm join <swarm-id> [--token <token>] [--claim <repo>] [--session <id>]
```

Three shapes:

| Form | Result |
|---|---|
| `join <id>` | Registration only. Adds the session; renews any owned leases. |
| `join <id> --token <token>` | Consumes the token. If `kind=focus`, claims the token's `target_repo` automatically. If `kind=join`, registers only (equivalent to plain join). |
| `join <id> --claim <repo>` | Explicit claim — bound by the same lease rules as `/swarm claim`. Exits 1 if rejected. |

Exit codes:
- 0 on success.
- 1 if the swarm doesn't exist, the token is missing/expired, or the claim is rejected (`EOWNERSHIP`).

Audit log gets a `join` entry detailing the route — `registration only` / `via token kind=…` / `with --claim …`.

---

### `/swarm absorb <target-swarm-id> <source-swarm-id> [--yes] [--session <id>]`

> Phase 17.5 / v0.20.2 — converge two swarms back into one.

Merge `<source-swarm-id>` into `<target-swarm-id>` (the caller's swarm). Use to reunite after a `/swarm focus` split, or to absorb work from a peer swarm that's now done.

```bash
momentum swarm absorb <target-swarm-id> <source-swarm-id> [--yes] [--session <id>]
```

Behavior:
1. Loads both manifests. If either is missing → exit 1.
2. Detects contract conflicts: for every shared `surface` in both swarms' `contracts`, the `owner` must match and the `content_hash` (when present) must match. Mismatches abort cleanly — both swarms left untouched — with a printed diff for each conflict.
3. Without `--yes`, prints a dry-run plan (repos to add, overlap, contract status) and exits 0 without writing. Re-run with `--yes` to proceed.
4. On commit:
   - `repos`: union; target wins on overlap (so a repo already in flight in target is not regressed by source's state)
   - `waves`: recomputed via the wave-ordering library over the union of repos, against `ecosystem.json` dependencies
   - `sessions[]`: union by `session_id` (earliest `first_seen`, latest `last_seen`)
   - `contracts`: union; target's version kept on overlap (we verified compatibility above)
   - `audit[]`: concat + sort by timestamp; append an `absorb` entry
   - `inbox/`: source's pending items copied into target with bumped ids
5. Archives the source swarm directory to `<eco>/swarms/.absorbed/<source-id>/`. Forensics preserved.
6. Refreshes target's `board.json`.

JSON output (`--json`) returns `{ absorbed, into, reposAdded, reposOverlapped, inboxMoved, archivedTo }`.

---

### `/swarm release <swarm-id> <repo> [--session <id>]`

> Phase 17.5 / v0.20.2 — multi-session ownership primitive.

Release the current session's ownership of `<repo>`. Sets `owner = _unclaimed`, clears the lease, and audit-logs `release`. Idempotent — releasing an already-unclaimed repo is a no-op.

```bash
momentum swarm release <swarm-id> <repo> [--session <id>]
```

Only the current owner may release. Attempting to release a repo you don't own exits 1 (you'd need `/swarm claim` against an expired lease, or the owner to release first).

---

### `/swarm cancel <swarm-id> [--reason "<text>"]`

Graceful halt. Halts every supervisor, marks the swarm `cancelled` in the manifest, preserves all artifacts for forensics.

```bash
momentum swarm cancel <swarm-id> --reason "<text>"
```

**Confirm with the user before running.** Cancel is reversible only via `/swarm resume` re-attaching to a frozen state — you cannot un-cancel a wave that was mid-flight if commits have been pushed and force-overwrites would be needed.

After cancel:
1. All queued/running/blocked repos move to `cancelled`.
2. All queued/running waves move to `cancelled`.
3. Branches remain — supervisors do NOT force-push or delete.
4. Audit log gains a `cancel` entry with the reason.

---

## Tracking contract

- **Auto every time:** `manifest.json` writes via the conductor library; `board.json` regenerated on each write.
- **Auto only when meaningful:** `[SWARM]` entry in each supervisor's repo `history.md` after wave completion; `[NOTE]` in the originating session log on wave transitions.
- **Never:** silent overwrites of supervisor branches. Cancel preserves; resume reconstitutes.

## Errors

- Ecosystem root not found → suggest `--ecosystem <path>` or running from inside an ecosystem.
- Repo arg not a member → list valid members and abort.
- Initiative does not exist → suggest `momentum ecosystem initiative create <slug>` and abort.
- `claude --bg` not on PATH → degrade to dry-run + manual spawn instructions.
