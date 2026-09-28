// Service-token issuing (R-2, web LLD §4.2): user-context tokens for proxied calls (cached per user and audience),
// service-to-service tokens for callers with a client credential, the JWKS, and signing-key rotation.
import { WebError } from '../domain/errors';
import {
  PREVIOUS_KEY_GRACE_MS,
  TOKEN_TTL_SEC,
  USER_TOKEN_CACHE_MS,
  audienceAllowed,
  isServiceName,
  rotationDue,
  serviceTokenClaims,
  userTokenClaims,
} from '../domain/service-tokens';
import type { ServiceName } from '../domain/service-tokens';
import type { Clock, ServiceClient, ServiceClientRepo, SigningKeyStore, TokenSigner } from './ports';
import type { StaffContext } from './sessions';

/** A new key is published in JWKS for at least this long before it signs anything. */
export const NEXT_KEY_PUBLISH_MS = 10 * 60_000;

export interface TokenDeps {
  signer: TokenSigner;
  keys: SigningKeyStore;
  clients: ServiceClientRepo;
  clock: Clock;
}

export class Tokens {
  private readonly userTokens = new Map<string, { token: string; until: number }>();

  constructor(private readonly deps: TokenDeps) {}

  /** Bearer token for a proxied call to `audience` on behalf of the signed-in user. */
  async userToken(ctx: StaffContext, audience: ServiceName): Promise<string> {
    const key = `${ctx.userId}|${audience}|${ctx.role}|${ctx.isDataOperator}`;
    const now = this.deps.clock.now().getTime();
    const hit = this.userTokens.get(key);
    if (hit && hit.until > now) return hit.token;
    const { token } = await this.deps.signer.sign(
      {
        ...userTokenClaims({
          audience,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          role: ctx.role,
          isDataOperator: ctx.isDataOperator,
        }),
      },
      TOKEN_TTL_SEC,
    );
    this.userTokens.set(key, { token, until: now + USER_TOKEN_CACHE_MS });
    if (this.userTokens.size > 5000) this.prune(now);
    return token;
  }

  /** Sign-out, role change, deactivation: stop reusing this user's cached tokens. */
  evictUser(userId: string): void {
    for (const k of this.userTokens.keys()) if (k.startsWith(`${userId}|`)) this.userTokens.delete(k);
  }

  private prune(now: number) {
    for (const [k, v] of this.userTokens) if (v.until <= now) this.userTokens.delete(k);
  }

  /** POST /internal/v1/service-tokens: the caller authenticates with X-Service-Credential (HMAC lookup). */
  async authenticateClient(credential: string | undefined): Promise<ServiceClient & { name: ServiceName }> {
    const client = credential ? await this.deps.clients.findByCredential(credential) : undefined;
    if (!client || client.status !== 'active' || !isServiceName(client.name))
      throw new WebError('service-credential-invalid');
    return client;
  }

  /** A service-to-service token for an allowed caller → audience pair. */
  async mintFor(
    client: ServiceClient & { name: ServiceName },
    audience: string,
    tenantId: string,
  ): Promise<{ caller: ServiceName; token: string; expiresAt: Date }> {
    if (!isServiceName(audience) || !audienceAllowed(client.name, audience, client.allowedAudiences))
      throw new WebError('audience-not-allowed', `${client.name} may not call ${audience}`);
    const { token, expiresAt } = await this.deps.signer.sign(
      { ...serviceTokenClaims(client.name, audience, tenantId) },
      TOKEN_TTL_SEC,
    );
    return { caller: client.name, token, expiresAt };
  }

  async mintForService(credential: string | undefined, audience: string, tenantId: string) {
    return this.mintFor(await this.authenticateClient(credential), audience, tenantId);
  }

  jwks() {
    return this.deps.signer.jwks();
  }

  /**
   * signing-key-rotate (daily; a key lives 90 days): retire ended grace periods; promote a published "next" key;
   * or publish a new "next" key when the active one is due. Signing only ever uses a key that JWKS already served.
   */
  async rotate(): Promise<{ processed: number }> {
    const now = this.deps.clock.now();
    let processed = await this.deps.keys.retireExpired(now);
    const keys = await this.deps.keys.loadUsable();
    const active = keys.find((k) => k.status === 'active');
    const next = keys.find((k) => k.status === 'next');
    if (!active) {
      await this.deps.keys.create('active', now);
      processed++;
    } else if (next && now.getTime() - next.activatedAt.getTime() >= NEXT_KEY_PUBLISH_MS) {
      await this.deps.keys.promote(next.kid, now, PREVIOUS_KEY_GRACE_MS);
      processed++;
    } else if (!next && rotationDue(active.activatedAt, now)) {
      await this.deps.keys.create('next', now);
      processed++;
    }
    if (processed) {
      await this.deps.signer.reload();
      this.userTokens.clear();
    }
    return { processed };
  }
}
