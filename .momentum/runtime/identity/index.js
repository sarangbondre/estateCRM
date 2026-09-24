'use strict';

/**
 * Actor identity (Phase 30a Team-Walk, ADR-0012).
 *
 * momentum was identity-blind — "actors" were random per-process UUIDs
 * (bin/swarm.js) and branch names (core/lanes/lib/signals.js). Team mode needs
 * a DURABLE actor so coordination writes, claims, and approvals can say WHO.
 *
 * The zero-config source is git's own identity (`git config user.email` /
 * `user.name`), overridable by $MOMENTUM_ACTOR, with a deterministic fallback
 * (stable per repo+user) when git identity is unset. No accounts, no server.
 *
 * Zero dependencies — node builtins only.
 */

const crypto = require('crypto');
const { spawnSync } = require('child_process');

function git(cwd, ...args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) return null;
  return res.stdout.trim();
}

/** Slugify an email/name into a stable, path-safe actor id. */
function slug(s) {
  const out = String(s)
    .toLowerCase()
    .trim()
    .replace(/@.*$/, '') // email local-part
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return out || 'anon';
}

/**
 * Resolve the durable actor for `cwd`.
 * Precedence: $MOMENTUM_ACTOR → git config user.email → deterministic fallback.
 * `env` is injectable for testing (defaults to process.env).
 * Returns { id, name, email, source }.
 */
function resolveActor(cwd, env) {
  env = env || process.env;
  const dir = cwd || process.cwd();

  const override = env.MOMENTUM_ACTOR && env.MOMENTUM_ACTOR.trim();
  if (override) {
    return { id: slug(override), name: override, email: null, source: 'env' };
  }

  const email = git(dir, 'config', 'user.email');
  const name = git(dir, 'config', 'user.name');
  if (email) {
    return { id: slug(email), name: name || email, email, source: 'git' };
  }

  // Deterministic fallback — stable per repo+user without a git identity.
  const root = git(dir, 'rev-parse', '--show-toplevel') || dir;
  const user = env.USER || env.USERNAME || 'unknown';
  const h = crypto.createHash('sha256').update(`${user}::${root}`).digest('hex').slice(0, 8);
  return { id: `anon-${h}`, name: `anon-${h}`, email: null, source: 'fallback' };
}

module.exports = { resolveActor, slug };
