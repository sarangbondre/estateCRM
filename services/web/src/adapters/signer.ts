// ES256 token signer with the active key; JWKS with next + active + previous keys (web LLD §4.2). Keys load once per
// instance and are re-read every 10 minutes so a rotation by another instance is picked up.
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { Clock, SigningKeyStore, StoredSigningKey, TokenSigner } from '../application/ports';

const RELOAD_MS = 10 * 60_000;

export class JoseSigner implements TokenSigner {
  private keys: StoredSigningKey[] = [];
  private loadedAt = 0;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly store: SigningKeyStore,
    private readonly clock: Clock,
  ) {}

  ready(): boolean {
    return this.keys.some((k) => k.status === 'active');
  }

  reload(): Promise<void> {
    this.loading ??= (async () => {
      try {
        let keys = await this.store.loadUsable();
        if (!keys.some((k) => k.status === 'active')) {
          await this.store.create('active', this.clock.now());
          keys = await this.store.loadUsable();
        }
        this.keys = keys;
        this.loadedAt = this.clock.now().getTime();
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  private async current(): Promise<StoredSigningKey[]> {
    if (!this.ready() || this.clock.now().getTime() - this.loadedAt > RELOAD_MS) await this.reload();
    return this.keys;
  }

  async sign(claims: Record<string, unknown>, ttlSec: number): Promise<{ token: string; expiresAt: Date }> {
    const active = (await this.current()).find((k) => k.status === 'active');
    if (!active?.privateKey) throw new Error('no active signing key');
    const iat = Math.floor(this.clock.now().getTime() / 1000);
    const exp = iat + ttlSec;
    const token = await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'ES256', kid: active.kid, typ: 'JWT' })
      .setJti(randomUUID())
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(active.privateKey);
    return { token, expiresAt: new Date(exp * 1000) };
  }

  async jwks(): Promise<{ keys: Record<string, unknown>[] }> {
    const order = { active: 0, next: 1, previous: 2, retired: 3 } as const;
    const keys = [...(await this.current())]
      .filter((k) => k.status !== 'retired')
      .sort((a, b) => order[a.status] - order[b.status])
      .slice(0, 3)
      .map((k) => ({ ...k.publicJwk }));
    return { keys };
  }
}
