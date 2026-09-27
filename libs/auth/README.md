# @11e/auth

Authentication and authorization checks for every service (F-11, conventions §4, R-2, web LLD §4.2).

```ts
const svc = createService<operations>({
  service: 'records',
  spec,
  ready,
  operationMiddleware: [
    authenticate({
      service: 'records',
      jwksUrl: `${env.WEB_URL}/.well-known/jwks.json`,
      cronSecret: env.CRON_SECRET,
    }),
  ],
});
svc.op('getOffer', async (c, { params }) => {
  const offer = await repo.get(tenantOf(c), params.idOrCode);
  assertTenant(c, offer.tenantId); // another tenant's resource → 404
  return c.json(offer);
});
```

## `authenticate(options)`: driven by the contract

For each operation it satisfies **one** of the OpenAPI `security` alternatives, then applies `x-roles` / `x-callers`:

| Scheme                | Check                                                                                                                                                                                                                                    | Principal                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `staffViaWeb`         | ES256 JWT from web (JWKS cached 10 min). `iss=web`, `aud=<this service>`, `exp`, `tid`, `uid`, `role`. The `X-User-Id` / `X-User-Role` / `X-Tenant-Id` headers **must equal** the claims. The role must be in the operation's `x-roles`. | `{ kind: 'staff', tenantId, userId, role }` |
| `serviceToken`        | Same signature checks, **no `uid`**, `sub` = a known service. If `x-callers` names services, the caller must be one of them.                                                                                                             | `{ kind: 'service', caller, tenantId }`     |
| `cronSecret`          | `X-Cron-Secret`, constant-time compare                                                                                                                                                                                                   | `{ kind: 'scheduler' }`                     |
| `websiteApiKey`       | `X-Api-Key` resolved by your `verifyApiKey` (listings stores `hashApiKey(key)`)                                                                                                                                                          | `{ kind: 'website', tenantId, keyId }`      |
| none (`security: []`) | —                                                                                                                                                                                                                                        | `{ kind: 'anonymous' }`                     |

It returns 401 `unauthenticated` for missing, invalid or expired credentials and for header/claim mismatches. It returns 403
`forbidden` when the role or caller isn't allowed, or the token kind is wrong for the route.

## Helpers

- `principalOf(c)`, `tenantOf(c)`, `requireStaff(c, roles?)`, `assertTenant(c, resourceTenantId)`. Services re-check
  their own resources (CLAUDE.md §3.8, NFR-15).
- `createServiceTokenClient({ webUrl, credential })`: gets `aud=<target>` tokens from web
  `POST /internal/v1/service-tokens` (`X-Service-Credential`). Tokens are cached per audience+tenant and refreshed 60 s
  before expiry; concurrent requests share one fetch. Plug `headersFor(aud, tenantId)` into `createHttpClient`. Service
  tokens are for background jobs and projection rebuilds only, never inside a user request chain (HLD §3.2).
- `secretsEqual`, `hashApiKey`.

`staffSession` and `serviceCredential` (web's own cookie session and the token-mint credential) are implemented by web
itself.
