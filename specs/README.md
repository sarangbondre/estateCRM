---
type: Guide
---

# Specs

> Structured project knowledge. All planning, tracking, and decision-making lives here.

## Directory Map

| Directory | Purpose |
|-----------|---------|
| `status.md` | Current phase, blockers, P0 items — **read this first** |
| `backlog/` | Bugs, features, tech debt, enhancements |
| `changelog/` | Monthly change logs |
| `decisions/` | Architecture Decision Records (ADRs) |
| `phases/` | Phase plans, tasks, and history |
| `planning/` | Roadmap and release plan — created at founding (`/start-project`) |
| `vision/` | Project charter, principles, success criteria — created at founding (`/start-project`) |

Foundation docs (`vision/`, `planning/roadmap.md`) are **authored, not
scaffolded**: they don't exist until `/start-project` founds the project
from your brainstorm. Their absence means "not founded yet" — phase
commands will route you to `/start-project` first.

## Workflow

```
/brainstorm-idea     →  explore an idea (no files written)
/start-project       →  found the project: author vision + roadmap, plan Phase 0
/start-phase         →  begin a phase
/track               →  log a discovery mid-phase
/complete-phase      →  verify, release, retrospective
/sync-docs           →  propagate history to specs (at phase end only)
```
