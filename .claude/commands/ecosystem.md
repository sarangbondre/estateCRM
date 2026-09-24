Cross-repo ecosystem coordination (Phase 9 Tier 1).

The ecosystem layer threads multiple momentum-installed repos into one
coherent unit of work. Use it when a feature or release spans more than
one repo and you want shared status, shared initiative tracking, and a
shared daily session log.

> Per-repo phases, backlog, and history stay where they are. The
> ecosystem layer is additive — it never writes into a member repo's
> `specs/`. The only touch is one fenced line in CLAUDE.md / AGENTS.md.

## When to use

- The work-at-hand is spread across two or more repos that already have
  momentum installed (e.g. a backend repo + a frontend repo + an infra
  repo all participating in one product launch).
- A user asks for cross-repo status: "what's in flight across the X
  constellation right now?"
- A user names an "initiative" or "cross-repo feature" by name — see if
  it exists as `<ecosystem-root>/initiatives/NNNN-<slug>.md`.
- A user asks "what happened today?" — read today's session log.

## Discovery

Always start by checking for an ecosystem root:

```bash
# Walk up from $PWD (bounded to 5 parents) AND scan siblings for
# ecosystem.json — the helper in core/ecosystem/lib/index.js does this.
node -e "console.log(require('./core/ecosystem/lib').findRoot(process.cwd()))"
```

If no ecosystem root exists and the work clearly spans repos, suggest:
`momentum ecosystem init <name>` from the parent directory.

## Subcommands

### `status`

```
momentum ecosystem status
```

Prints the manifest (name, members, dependency edges) and per-member
git state (modified files + last commit). Use this as the first read
when context-switching into multi-repo work.

### `add <repo-path>`

```
momentum ecosystem add ../<repo-name> --role <platform|client|library|infra|bench|other> [--id <id>]
```

Registers a momentum-installed repo as a member of the current
ecosystem. Idempotent — safe to re-run. Writes one fenced line into
the target's CLAUDE.md / AGENTS.md pointing back at the ecosystem.

Pre-flight: target must have CLAUDE.md or AGENTS.md (i.e. have been
through `momentum init`). The command refuses non-momentum targets.

### `remove <id>`

```
momentum ecosystem remove <member-id>
```

Strips the member from `ecosystem.json` and removes the fenced pointer
from the target's primary instruction file. Tolerant of missing target
(the manifest is updated even if the member directory is gone).

### `init [name]`

```
momentum ecosystem init <name>
```

Scaffolds a fresh ecosystem root: `ecosystem.json`, `initiatives/`,
`sessions/`, `.state/`, `README.md`, `.gitignore`. Runs `git init` and
produces the initial commit (best-effort — if git identity is missing
the scaffold is still valid, user can commit later).

## On-disk layout

```
<ecosystem-root>/
├── ecosystem.json          ← manifest (members, roles, dep edges)
├── README.md
├── initiatives/            ← cross-repo features (see /initiative)
│   └── NNNN-<slug>.md
├── sessions/               ← daily activity log
│   └── YYYY-MM-DD.md       ← appended by member-repo PostToolUse hook
├── .state/                 ← runtime state (gitignored)
│   ├── active-initiative
│   └── last-session
└── .gitignore
```

See `core/ecosystem/layout.md` for the full reference.

## Reading the session log

Today's session file (`sessions/$(date -u +%F).md`) is auto-populated
by member-repo hooks every time a `git commit` or `gh pr {merge,create}`
runs. Each line:

```
HH:MMZ [<member-id>] <kind>: <summary> (<context>)
```

For a narrated entry not tied to a tool event, use the `/session` slash
command (`/session log "..."`).

## Reading the manifest

```bash
cat <ecosystem-root>/ecosystem.json
```

Or programmatically:

```js
const lib = require('<momentum>/core/ecosystem/lib');
const root = lib.findRoot(process.cwd());
const manifest = lib.loadManifest(root);
manifest.members.forEach((m) => console.log(m.id, m.role, m.path));
```

## Composition with other commands

- `/initiative` — manage individual cross-repo features inside this
  ecosystem (`create`, `status`, `close`, `list`). See its recipe.
- `/session log <message>` — append a manual narrative entry to
  today's session log.
- `/track` — backlog item tracking; lives inside each member repo's
  `specs/backlog/`. The ecosystem doesn't aggregate backlogs (yet —
  Tier 2 work).
- `momentum init` — adds a brand-new momentum project. The ecosystem
  layer only registers existing momentum-installed repos.

## Failure modes

- "not inside an ecosystem root" — caller is not in or under an
  ecosystem. Either `cd` into one, or `momentum ecosystem init <name>`
  to create one.
- "target doesn't look momentum-installed" — the path passed to `add`
  doesn't have CLAUDE.md / AGENTS.md. Run `momentum init` on the
  target first.
- "member id already registered" — the id is taken by another path.
  Pass `--id <different>` or `remove` the existing entry first.

## Key principles

- **Strictly additive** — never modify a member repo's `specs/` or any
  file beyond the one fenced line in its primary instruction file.
- **Discovery first** — every command walks up looking for the
  ecosystem root; nothing assumes the cwd.
- **Idempotent** — `add` is safe to re-run; `remove` is safe even when
  the target is gone.
- **Member-internal autonomy** — each member repo's per-repo phases,
  backlog, history, sync-docs all keep working unchanged. The
  ecosystem is a thread across them, not a replacement for them.
