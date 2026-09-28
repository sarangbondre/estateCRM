// In-memory fakes of the application ports that reach outside the DB (Storage has no container in CI).
import type { FileStore, SignedUrl } from '../../src/application/ports.js';

export class MemoryFileStore implements FileStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly removed: string[] = [];

  signedUploadUrl(path: string): Promise<SignedUrl> {
    return Promise.resolve({
      url: `https://storage.test/upload/${encodeURI(path)}?token=t`,
      expiresAt: new Date(Date.now() + 7_200_000),
    });
  }

  signedReadUrl(path: string, expiresInSec: number): Promise<SignedUrl> {
    return Promise.resolve({
      url: `https://storage.test/read/${encodeURI(path)}?token=t`,
      expiresAt: new Date(Date.now() + expiresInSec * 1000),
    });
  }

  stat(path: string) {
    const o = this.objects.get(path);
    return Promise.resolve(o ? { sizeBytes: o.byteLength } : undefined);
  }

  read(path: string): Promise<AsyncIterable<Uint8Array>> {
    const o = this.objects.get(path);
    if (!o) return Promise.reject(new Error(`missing object ${path}`));
    return Promise.resolve(
      (async function* () {
        for (let i = 0; i < o.byteLength; i += 65536) yield o.subarray(i, i + 65536);
      })(),
    );
  }

  put(path: string, body: Uint8Array | string): Promise<void> {
    this.objects.set(path, typeof body === 'string' ? new TextEncoder().encode(body) : body);
    return Promise.resolve();
  }

  remove(paths: readonly string[]): Promise<void> {
    for (const p of paths) {
      this.objects.delete(p);
      this.removed.push(p);
    }
    return Promise.resolve();
  }

  text(path: string): string | undefined {
    const o = this.objects.get(path);
    return o ? new TextDecoder().decode(o) : undefined;
  }
}
