# intake

Uploads, strict/mapping intake modes, validation, extraction & classification, review queue.

| | |
|---|---|
| Contract | `contracts/openapi/intake.yaml` |
| Events | `contracts/asyncapi/events.yaml` (produced/consumed per `docs/04-lld/intake.md` §5) |
| Design | `docs/04-lld/intake.md` |
| Tasks | `docs/05-tasks.md` (INT-*) |
| Owner | Sarang Bondre (see `CODEOWNERS`) |

## Layout
`src/domain` (pure logic, no I/O) → `src/application` (use cases, ports) → `src/adapters` (http, db, queue, storage, ai). `src/main.ts` is the only composition root (CLAUDE.md §3.1).

## Run locally
_Filled in by the service's definition-of-done task (conventions: `docs/06-implementation-rules.md`)._

## Environment variables
_Documented as they are introduced._
