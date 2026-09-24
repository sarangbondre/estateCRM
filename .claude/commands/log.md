Record a manual entry in the active phase history file — or, when no phase is
active, in the ad-hoc work record (off-phase decisions are never dropped).

> **Which phase is yours (Rule 15):** the phase bound to your branch — branch
> `phase-N-shortname` ↔ `specs/phases/phase-N-shortname/`. `status.md`'s
> Active Phase table is the fallback (detached HEAD, no matching directory)
> and the cross-lane overview, not the binding.

## Steps

1. Resolve your phase from the current branch (`git branch --show-current`):
   a `phase-*` branch with a matching `specs/phases/<branch>/` directory binds
   to that phase. Fallback: the `specs/status.md` Active Phase table. A
   non-phase branch (`fix/*`, `chore/*`, `feat/*`) is ad-hoc work — see below.
2. Find the history file:
   - **Phase lane**: `specs/phases/<phase-bound-to-your-branch>/history.md`
   - **No active phase** (between phases, or `/hotfix` quick-task / spike work):
     the `specs/adhoc/<id>/record.md` you are working in, else
     `specs/adhoc/history.md` (create it from the same entry format if absent).
     Off-phase work still captures its *why* (Rule 8) — it just lives here.
3. Determine entry type from the message:
   - Decision about technology/architecture → [DECISION]
   - Phase scope added/removed → [SCOPE_CHANGE]
   - Bug/tech debt/enhancement found → [DISCOVERY]
   - New planned feature → [FEATURE]
   - Architecture pattern changed → [ARCH_CHANGE]
   - Evaluator defined or changed → [EVALUATOR]
   - Anything else → [NOTE]
4. Extract or infer topics (2-5 keywords)
5. Identify affects-phases (check `status:` frontmatter in `specs/phases/*/overview.md`)
6. Identify affects-specs (check `specs/decisions/impact-map.md`)
7. Append the formatted entry to history.md (APPEND ONLY):

```
### [TYPE] YYYY-MM-DD — Short title (max 10 words)
Topics: topic-1, topic-2, topic-3
Affects-phases: phase-N-name (or "none")
Affects-specs: path/to/file.md#section (or "none")
Detail: One to three sentences describing what changed and why.

---
```

8. If the entry introduces a topic not in the `specs/decisions/impact-map.md` table, add a row
9. Confirm: "Logged [TYPE] entry to [phase or ad-hoc] history."
