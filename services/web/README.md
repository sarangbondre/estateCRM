# web

Next.js chat-first UI + BFF gateway (sign-in, routing, users & roles, audit sink).

| | |
|---|---|
| Contract | `contracts/openapi/web.yaml` (BFF own endpoints + routing table) |
| Events | `contracts/asyncapi/events.yaml` (produced/consumed per `docs/04-lld/web.md` §5) |
| Design | `docs/04-lld/web.md` |
| Tasks | `docs/05-tasks.md` (WEB-*) |
| Owner | Sarang Bondre (see `CODEOWNERS`) |

## Layout
Next.js App Router in `app/`, thin BFF in `src/bff/` (no business rules, ADR-0007).

## Run locally
_Filled in by the service's definition-of-done task (conventions: `docs/06-implementation-rules.md`)._

## Environment variables
_Documented as they are introduced._
