Manage cross-repo initiatives in an ecosystem.

Initiatives are first-class records of features that span multiple
member repos. Each initiative is one markdown file under
`<ecosystem-root>/initiatives/NNNN-<slug>.md` with a small YAML
frontmatter block (id, slug, status, started, owner, repos).

This command must be run from inside an ecosystem root or any of its
member repos (the ecosystem root is discovered by walking up).

## The lifecycle (Phase 31a, ADR-0016)

An initiative runs the same shape as a phase, one tier up. Prefer the lifecycle
commands over the raw subcommands below:

```
/brainstorm-initiative                            # objective, members, edges, criteria
  → momentum ecosystem initiative create <slug>   # writes initiatives/NNNN-<slug>.md
  → momentum ecosystem initiative start <slug>    # contributions + edges + active
    → each member runs its OWN /start-phase or /hotfix
      → /complete-initiative                      # cross-repo Rule 12 gate, then close
```

## Subcommands

```
/initiative create <slug>     Create a new initiative + activate it
/initiative start <slug>      Declare per-member contributions + dependency edges
/initiative complete <slug>   Evidence gate across members, then close
/initiative status [<slug>]   Print the named (or active) initiative card
/initiative close <slug>      Populate the Close section + deactivate
/initiative list              List all initiatives in this ecosystem
```

`create`, `start`, and `complete` are wired as real CLI subcommands
(`momentum ecosystem initiative …`). `status` / `close` / `list` remain
slash-only.

## Steps for `start`

```bash
momentum ecosystem initiative start <slug> \
  --contribute <member>:<kind>:<ref> \
  --edge <from>:<to>:<kind>
```

- `kind` is a momentum work type (Rule 14): `phase` or `adhoc`.
- `ref` is the directory name of the member's own record —
  `phase-12-attachments`, `fix-BUG-031-upload`.
- `--edge` kinds: `api-contract`, `library`, `deploy`, `build-time`, `other`.

`start` writes the `Per-repo contributions` table, registers the edges in
`ecosystem.json`, sets the initiative active, and prints the next command for
each member. It **never writes inside a member repo** — each member owns its
own `specs/`, and its own `/start-phase` or `/hotfix` scaffolds the record.

Re-running is idempotent. Repointing an existing contribution is refused rather
than silently overwritten.

## Linking a decision to an initiative

To have a member's ADR appear under `## Linked decisions`, add one line to that
ADR's frontmatter in the member repo:

```yaml
---
type: ADR
initiative: <slug>
---
```

`initiative complete` scans each contributing member's `specs/decisions/` for
that stamp. It is opt-in and written in the member repo by whoever authors the
ADR — momentum never reaches across the ownership boundary to add it.

## Steps for `create`

1. Locate the ecosystem root via the walk-up helper
   (`core/ecosystem/lib/index.js → findRoot`). If none found, abort
   with a clear message: "Not inside an ecosystem. Run `momentum
   ecosystem init` first."

2. Validate the `<slug>` matches `/^[a-z][a-z0-9-]*$/`. If not, abort.

3. Allocate the next initiative id via `nextInitiativeId(root)`
   (scans existing files for the highest `NNNN-` prefix).

4. Prompt the user (one question at a time) for:
   - **Why** — one-paragraph motivation
   - **Repos involved** — defaults to all members; allow comma-separated
     subset
   - **Owner** — defaults to git config user.name or env USER

5. Render the initiative file from
   `core/ecosystem/templates/initiative-template.md`, substituting the
   frontmatter + the user's "Why" text. Leave the
   "Per-repo contributions", "Linked decisions", "Deploy chronology"
   sections empty (they'll fill in as work lands).

6. Write the file to `<root>/initiatives/<NNNN>-<slug>.md` via
   `writeInitiative(filePath, frontmatter, content)`. This re-validates
   the frontmatter.

7. Set the slug as the active initiative:
   `setActive(root, slug)` (writes `<root>/.state/active-initiative`).

8. Print confirmation:
   ```
   Created initiative 0042-<slug>.md. Active.
   ```

## Steps for `status`

1. Resolve the target slug: argument if given; else read
   `<root>/.state/active-initiative`; else abort with
   "No active initiative. Pass <slug> or `/initiative create` first."

2. Load the file via `loadInitiative(root, slug)`. Print:
   - Frontmatter as a header block (status, owner, started, repos)
   - "Per-repo contributions" section verbatim
   - For each repo in `repos[]`, run `gh pr list --repo <owner>/<repo>
     --state open --json number,title,headRefName` (best-effort; degrade
     gracefully if `gh` not authenticated) and append a one-line
     summary per open PR.
   - For each repo, print last 3 commits via `git -C <repo-path>
     log -3 --oneline`.

3. If `<root>/.state/active-initiative` matches this slug, print:
   `(active)` in the header.

## Steps for `close`

1. Resolve slug from argument (required for close — no implicit
   "close the active one" to avoid surprises).

2. Load the initiative; abort if already `status: closed`.

3. Prompt the user (one question at a time):
   - **What shipped?**
   - **What was deferred?**
   - **What was learned?**

4. Append a populated `## Close` section (preserving any existing
   sections above it). Set frontmatter `status: closed` and
   `closed: <today>`. Write back via `writeInitiative`.

5. If this slug was active, clear `.state/active-initiative` via
   `clearActive(root)`.

6. Print confirmation:
   ```
   Closed initiative <slug>. State cleared.
   ```

## Steps for `list`

1. Read every `NNNN-*.md` file in `<root>/initiatives/`. Sort by
   numeric id ascending.

2. For each, print:
   ```
   NNNN <slug>  status  started→closed-or-‹in-progress›  repos: a, b, c
   ```

3. If `.state/active-initiative` is set, mark that row with `←active`.

## Key principles

- **Idempotent prompts** — running `/initiative create <existing-slug>`
  must refuse with a clear error, never silently overwrite.
- **Frontmatter is the source of truth** — body sections are free-form
  human writing; the agent doesn't reformat them when re-reading.
- **Cross-repo, not in-repo** — initiatives live in the ecosystem root,
  not inside any one member's `specs/`. The member-repo phases stay
  authoritative for their own work; initiatives link across them.
