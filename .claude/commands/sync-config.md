Sync the project's `specs/config.md` with the project's current shape — review drift and apply on approval.

Momentum infers project shape (language, framework, publish target, git forge)
from manifests (`package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod` / …) and
the git remote. When that shape changes — you switched CI from GitHub Actions to
GitLab, adopted a framework, renamed the package — `specs/config.md` can drift
from reality. This command re-infers and shows the difference, then asks before
writing anything (ENH-062 — approval-gated, never a silent mutation).

## Steps

1. Run:
   ```
   momentum config sync
   ```
   (pass a `target-dir` to sync a different project; `--dry-run` to preview.)

2. Read the output:
   - `✓ matches the inferred project shape — nothing to sync` → no drift, done.
   - A per-field `old → new` list → drift detected.

3. At the prompt, decide:
   - `a` / `all` → apply every drifted field.
   - `language,git_forge` (comma-separated keys) → apply only those.
   - `s` / `skip` / empty → leave `specs/config.md` unchanged.

4. On approval, momentum rewrites `specs/config.md` and refreshes the derived
   `.momentum/config-cache.json`. The **trust layer is untouched** — protected
   branches can only ever be *added*, never removed (ADR-0009). Only the
   inferable fields (`language`, `framework`, `publish_target`, `git_forge`) are
   ever offered; user-authored fields (`branch_flow`, `end_state`, commands) are
   never flagged or overwritten.

5. Report to the user what changed (or that nothing changed). If drift was
   found and skipped, note they can re-run `momentum config sync` any time.

## When to run this proactively

- After a visible project-shape change (new framework, forge move, language
  bump) — offer to run `/sync-config` rather than silently editing config.
- `momentum upgrade` prints a drift warning when it detects one; route the user
  to this command to resolve it.
- Never auto-edit `specs/config.md` outside this approval flow.
