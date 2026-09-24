'use strict';

/**
 * Phase 32a G2 — the one mkdir-based file lock.
 *
 * Extracted from `core/swarm/lib/manifest.js` when the inbox became the
 * tier-agnostic park primitive. Two copies of a concurrency primitive is
 * precisely the duplication ADR-0018 was written to end, and a lock is a bad
 * place to discover drift.
 *
 * `mkdir` rather than `flock` for the reason `session-append.sh` gives: it is
 * atomic on every filesystem momentum targets and needs no native binding.
 * Dependency-free by house rule, so contention busy-waits rather than sleeping.
 *
 * The error label is parametrizable so callers reproduce their existing message
 * to the byte — the same technique ADR-0003 used to extract the wave engine
 * without changing a single swarm assertion.
 */

const fs = require('fs');

const DEFAULT_BUDGET_MS = 5000;
const CONTENTION_WAIT_MS = 50;

/**
 * Run `fn` while holding an exclusive lock on `filePath`.
 *
 * @param {string} filePath  the file being guarded (the lock is `<path>.lock`)
 * @param {Function} fn      critical section; its return value is passed through
 * @param {{label?: string, budgetMs?: number}} [opts]
 */
function withLock(filePath, fn, opts = {}) {
  const label = opts.label || 'run/lock';
  const budgetMs = typeof opts.budgetMs === 'number' ? opts.budgetMs : DEFAULT_BUDGET_MS;
  const lockDir = `${filePath}.lock`;
  const deadline = Date.now() + budgetMs;

  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lockDir);
      try {
        return fn();
      } finally {
        try { fs.rmdirSync(lockDir); } catch (_e) { /* best-effort */ }
      }
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        // Contention — short spin. Kept busy rather than async so callers stay
        // synchronous; contention is rare and the budget is bounded.
        const end = Date.now() + CONTENTION_WAIT_MS;
        while (Date.now() < end) { /* spin */ }
        continue;
      }
      throw err;
    }
  }
  throw new Error(`${label}: could not acquire lock at ${lockDir} within budget`);
}

module.exports = { withLock };
