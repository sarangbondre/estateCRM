---
type: Guide
---

# Ad-hoc Work (`specs/adhoc/`)

First-class home for work that does NOT warrant a full numbered phase —
hotfixes, chores, audits, dependency bumps, quick experiments. Off-phase work
still preserves git discipline, tracking, and (for quick-tasks) the Rule 12
verification gate — it just skips the phase scaffold.

## Work types

| Type | When | Ceremony |
|------|------|----------|
| `phase` | Net-new features, cross-cutting or architectural work | Full: `/brainstorm-phase` → `/start-phase` → groups → verify → `/complete-phase`. |
| `quick-task` | A bounded fix/chore with a clear blast radius | A record here + the Rule 12 evidence gate. No phase scaffold. |
| `spike` | Time-boxed exploration, throwaway code | Declared up front; exempt from acceptance gates; record what was learned. |

See **Rule 14** in the project instruction file (CLAUDE.md / AGENTS.md) for when
a quick-task must escalate to a full phase.

## Lane

Create with `/hotfix` (or `/hotfix --spike`). Each record lives at
`specs/adhoc/<id>/record.md`, copied from [`_TEMPLATE.md`](_TEMPLATE.md). The
`<id>` is the backlog id when one exists (e.g. `BUG-009`), otherwise a
`YYYY-MM-DD-<slug>` stamp.

Ad-hoc releases are tracked in the "Ad-hoc / Patch Releases" section of
`specs/status.md` — separate from the numbered-phase table.
