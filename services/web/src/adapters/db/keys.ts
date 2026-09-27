// signing_key and service_client repositories (web LLD §3, §4.2). Global tables (nil tenant): keys and service
// credentials are not tenant data.
import { randomUUID } from 'node:crypto';
import { exportJWK, exportPKCS8, generateKeyPair, importPKCS8 } from 'jose';
import { sql } from '@11e/db';
import type { Kysely } from '@11e/db';
import type {
  ServiceClient,
  ServiceClientRepo,
  SigningKeyStore,
  StoredSigningKey,
} from '../../application/ports';
import type { ServiceName, SigningKeyStatus } from '../../domain/service-tokens';
import type { Keyring } from '../crypto';
import type { WebDb } from './schema';

export class DbSigningKeyStore implements SigningKeyStore {
  constructor(
    private readonly db: Kysely<WebDb>,
    private readonly keyring: Keyring,
  ) {}

  async loadUsable(): Promise<StoredSigningKey[]> {
    const rows = await this.db
      .selectFrom('signing_key')
      .selectAll()
      .where('status', 'in', ['next', 'active', 'previous'])
      .orderBy('activated_at', 'desc')
      .limit(5)
      .execute();
    return Promise.all(
      rows.map(async (r) => ({
        kid: r.kid,
        status: r.status as SigningKeyStatus,
        publicJwk: r.public_jwk,
        privateKey:
          r.status === 'retired'
            ? null
            : ((await importPKCS8(
                this.keyring.decrypt(r.private_key_enc).toString('utf8'),
                'ES256',
              )) as CryptoKey),
        activatedAt: r.activated_at,
        retireAfter: r.retire_after,
      })),
    );
  }

  async create(status: SigningKeyStatus, now: Date): Promise<StoredSigningKey> {
    const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
    const kid = randomUUID();
    const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
    const pkcs8 = await exportPKCS8(privateKey);
    const inserted = await this.db
      .insertInto('signing_key')
      .values({
        kid,
        public_jwk: JSON.stringify(publicJwk),
        private_key_enc: this.keyring.encrypt(Buffer.from(pkcs8, 'utf8')),
        status,
        activated_at: now,
      })
      // Two cold starts may race to create the first active key: the one-active index keeps a single winner.
      .onConflict((oc) =>
        oc
          .expression(sql`(status)`)
          .where('status', '=', 'active')
          .doNothing(),
      )
      .returning('kid')
      .executeTakeFirst();
    if (!inserted) {
      const existing = (await this.loadUsable()).find((k) => k.status === status);
      if (existing) return existing;
      throw new Error('signing key race lost and no key found');
    }
    return {
      kid,
      status,
      publicJwk,
      privateKey: privateKey as CryptoKey,
      activatedAt: now,
      retireAfter: null,
    };
  }

  async promote(kid: string, now: Date, graceMs: number): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('signing_key')
        .set({ status: 'previous', retire_after: new Date(now.getTime() + graceMs), updated_at: now })
        .where('status', '=', 'active')
        .execute();
      await trx
        .updateTable('signing_key')
        .set({ status: 'active', activated_at: now, updated_at: now })
        .where('kid', '=', kid)
        .where('status', '=', 'next')
        .execute();
    });
  }

  async retireExpired(now: Date): Promise<number> {
    const r = await this.db
      .updateTable('signing_key')
      .set({ status: 'retired', updated_at: now })
      .where('status', '=', 'previous')
      .where('retire_after', '<', now)
      .executeTakeFirst();
    return Number(r.numUpdatedRows);
  }
}

export class DbServiceClientRepo implements ServiceClientRepo {
  constructor(
    private readonly db: Kysely<WebDb>,
    private readonly keyring: Keyring,
  ) {}

  async findByCredential(credential: string): Promise<ServiceClient | undefined> {
    if (credential.length < 16 || credential.length > 200) return undefined;
    const r = await this.db
      .selectFrom('service_client')
      .select(['name', 'allowed_audiences', 'status'])
      .where('credential_hash', '=', this.keyring.hmac('credential-hash', credential))
      .executeTakeFirst();
    return r
      ? {
          name: r.name as ServiceName,
          allowedAudiences: r.allowed_audiences,
          status: r.status as ServiceClient['status'],
        }
      : undefined;
  }

  /** Creates or rotates a service's credential (CLI). Returns nothing: the caller already holds the plaintext. */
  async upsert(
    name: ServiceName,
    credential: string,
    audiences: readonly string[],
    now: Date,
  ): Promise<void> {
    await this.db
      .insertInto('service_client')
      .values({
        name,
        credential_hash: this.keyring.hmac('credential-hash', credential),
        allowed_audiences: [...audiences],
        status: 'active',
        rotated_at: now,
      })
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'name']).doUpdateSet({
          credential_hash: this.keyring.hmac('credential-hash', credential),
          allowed_audiences: [...audiences],
          status: 'active',
          rotated_at: now,
          updated_at: now,
        }),
      )
      .execute();
  }
}
