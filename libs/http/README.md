# @11e/http

Every service's HTTP layer (F-10): a Hono app factory driven by the service's OpenAPI contract, RFC 7807 errors,
Idempotency-Key, If-Match, cursor pagination and a resilient outbound client. Conventions §4, CLAUDE.md §3.3/§3.5, CR-007.

```ts
import spec from '@11e/contracts/openapi/records.json' with { type: 'json' };
import type { operations } from '@11e/contracts/records';
import { createService, idempotent, pageLimit, toPage, notFound } from '@11e/http';

const svc = createService<operations>({ service: 'records', spec, ready: () => checkDbReady(db, LATEST) });
svc.op('listOffers', async (c, { query }) =>
  c.json(toPage(await list(query), pageLimit(query.limit), (r) => ({ k: r.createdAt, id: r.id }))),
);
svc.op('createOffer', (c, { body }) => idempotent(c, db, principalOf(c), body, () => createOffer(body)));
export default svc.app; // hono/vercel adapter at the composition root
```

| Feature        | Behaviour                                                                                                                                                                                                                                                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routing        | `svc.op(operationId, handler)`: method and path come from the contract. `svc.unimplemented()` lists operations with no handler (used by contract tests).                                                                                                                                                                         |
| Validation     | Path, query (coerced, defaults applied, **unknown parameters rejected**), declared headers and JSON / merge-patch bodies are validated with Ajv against the contract. Failures return `400 validation-failed` with `errors[] {field, code, message}`. Also `413` over `maxBodyBytes` (1 MiB) and `415` for the wrong media type. |
| Typed input    | `input.params / query / headers / body` are typed from the generated `operations` of `@11e/contracts/<service>`.                                                                                                                                                                                                                 |
| Errors         | Throw `HttpError` (or `notFound()`, `forbidden()`, `versionMismatch()`, …) to get `application/problem+json` with `type`, `code` and `correlationId`. Unexpected errors become `500 internal` without leaking the message. `DownstreamError` becomes `503 dependency-unavailable`.                                               |
| Correlation    | `X-Correlation-Id` is accepted if well-formed, otherwise generated. It's set on the response and available as `c.get('correlationId')`.                                                                                                                                                                                          |
| Health         | `GET /health/live` and `GET /health/ready` (your `ready()` check → 200/503).                                                                                                                                                                                                                                                     |
| Contract tests | With `validateResponses` (default in `NODE_ENV=test`), a JSON response that doesn't match its declared schema, or an undeclared status, becomes `500 contract-violation`.                                                                                                                                                        |
| Idempotency    | `idempotent(c, db, {tenantId, userId}, body, handler)` gives replay, `409 idempotency-key-reused`, `409` + `Retry-After` while in progress, and releases the key after 5xx. Uses `@11e/db`.                                                                                                                                      |
| Concurrency    | `ifMatchVersion(c)` parses `If-Match` (plain, quoted or weak) → number. Throw `versionMismatch()` on a mismatch.                                                                                                                                                                                                                 |
| Pagination     | `pageLimit` (default 25, max 100), `toPage(rows, limit, positionOf)` (fetch `limit + 1`), `encodeCursor` / `decodeCursor` (opaque base64url; a tampered cursor gives 400).                                                                                                                                                       |
| Outbound       | `createHttpClient({ name, baseUrl, headers })`: 2 s timeout. One retry with 100–400 ms jitter, only for idempotent methods or POSTs with an Idempotency-Key. A per-downstream circuit breaker opens at ≥50% failures over 20 calls and half-opens after 30 s with a single probe.                                                |

Hooks: `onRequestEnd` (route, status, duration, correlation ID, for RED metrics) and `onError` (unexpected errors).
The lib never logs; `libs/observability` plugs in through the hooks.
