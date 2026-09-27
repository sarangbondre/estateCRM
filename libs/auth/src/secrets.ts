import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** Constant-time comparison of two secrets (cron secret, client secret). */
export function secretsEqual(given: string | undefined, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

/** Website API keys are stored hashed (conventions §4). */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}
