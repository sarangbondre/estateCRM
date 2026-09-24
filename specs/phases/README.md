---
type: Guide
---

# Phases Index

| Phase | Name | Status | Directory |
|-------|------|--------|-----------|
| _(none yet)_ | | | |

## Phase Structure

Each phase directory contains:

| File | Purpose |
|------|---------|
| `overview.md` | Goal, scope, deliverables, acceptance criteria |
| `plan.md` | Group execution pattern with tasks |
| `tasks.md` | Checklist `[ ]` / `[x]` |
| `history.md` | Append-only log |
| `retrospective.md` | Post-completion review (created by /complete-phase) |

## Swarm-member briefs (optional)

When a phase is driven by a swarm conductor (Phase 17+), `overview.md`
MAY carry an optional YAML frontmatter block declaring its swarm
context. Solo briefs omit this entirely — they remain plain markdown.

```yaml
---
swarm: 0007-user-auth
wave: 2
initiative: user-auth
claimed_by_session: <session-uuid>
---
```

`/start-phase` populates these when invoked from a swarm context.
`/validate` checks that `swarm:` resolves to a real swarm manifest,
that `wave:` matches the wave the swarm has assigned this repo, and
that `initiative:` matches the swarm's initiative.
