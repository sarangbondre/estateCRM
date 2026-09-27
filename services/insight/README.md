# insight

Chat (redacted, plan-only AI), dashboards, exports.

| | |
|---|---|
| Contract | `contracts/openapi/insight.yaml` |
| Events | `contracts/asyncapi/events.yaml` (produced/consumed per `docs/04-lld/insight.md` §5) |
| Design | `docs/04-lld/insight.md` |
| Tasks | `docs/05-tasks.md` (INS-*) |
| Owner | Sarang Bondre (see `CODEOWNERS`) |

## Layout
`src/domain` (pure logic, no I/O) → `src/application` (use cases, ports) → `src/adapters` (http, db, queue, storage, ai). `src/main.ts` is the only composition root (CLAUDE.md §3.1).

## Run locally
_Filled in by the service's definition-of-done task (conventions: `docs/06-implementation-rules.md`)._

## Environment variables
_Documented as they are introduced._
