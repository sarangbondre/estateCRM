# web

Next.js chat-first UI + BFF gateway (sign-in, routing, users & roles, audit sink).

|          |                                                                                  |
| -------- | -------------------------------------------------------------------------------- |
| Contract | `contracts/openapi/web.yaml` (BFF own endpoints + routing table)                 |
| Events   | `contracts/asyncapi/events.yaml` (produced/consumed per `docs/04-lld/web.md` §5) |
| Design   | `docs/04-lld/web.md`, UI: `docs/prototype/11estate-crm-prototype.html`           |
| Tasks    | `docs/05-tasks.md` (WEB-\*)                                                      |
| Owner    | Sarang Bondre (see `CODEOWNERS`)                                                 |

## Layout

Next.js 16 App Router + React 19 + Tailwind 4.

```
src/app/        routes: (app)/ home, chat/[conversationId], settings; sign-in
src/ui/         React: shell (sidebar, composer with "/" actions, side panel, theme), chat thread, cards, panels
src/ui/lib/     pure helpers (intent parsing, formatting) + the browser API client (calls /v1 on web only)
src/server/     server-only helpers for pages
tests/          Vitest (unit, contract); e2e/ Playwright
```

The UI never calls a service directly: every call goes to `/v1/...` on web (docs/04-lld/web.md §2).

## Run locally

```sh
pnpm install
pnpm --filter @11e/web dev      # http://localhost:3000
pnpm --filter @11e/web test     # unit tests
```

## Environment variables

_Documented as they are introduced._
