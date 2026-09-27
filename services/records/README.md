# records

System of record: properties, projects, offers, demands, people, dedup & merges, desks, vocabulary.

| | |
|---|---|
| Contract | `contracts/openapi/records.yaml` |
| Events | `contracts/asyncapi/events.yaml` (produced/consumed per `docs/04-lld/records.md` §5) |
| Design | `docs/04-lld/records.md` |
| Tasks | `docs/05-tasks.md` (REC-*) |
| Owner | Sarang Bondre (see `CODEOWNERS`) |

## Layout
`src/domain` (pure logic, no I/O) → `src/application` (use cases, ports) → `src/adapters` (http, db, queue, storage, ai). `src/main.ts` is the only composition root (CLAUDE.md §3.1).

## Run locally
_Filled in by the service's definition-of-done task (conventions: `docs/06-implementation-rules.md`)._

## Environment variables
_Documented as they are introduced._
