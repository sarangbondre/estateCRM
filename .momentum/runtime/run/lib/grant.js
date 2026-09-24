'use strict';

/**
 * Phase 32b G2 — the scope grant (ADR-0020).
 *
 * A grant lets ONE human approval fund N protected-branch pushes for ONE epic.
 * It is offered ALONGSIDE `.momentum/merge-approved`, never replacing it: a
 * repo that never mints a grant behaves byte-identically to v0.42.0.
 *
 * ADR-0020 is honest that this is a real widening — one approval now covers
 * code the operator has not read, a single mistaken "yes" costs an epic rather
 * than a merge, and the window is time rather than action. The mitigations here
 * are the three bounds that answer those three hazards, and they are
 * REQUIRED — an unbounded axis is an unbounded grant:
 *
 *   scope  — a branch allowlist it cannot exceed
 *   time   — an absolute, non-sliding expiry
 *   count  — a landing budget, defaulting to the epic's phase count
 *
 * The grant lives in the run manifest's `grant` field. `.momentum/` is
 * gitignored by momentum's template, and `mint` REFUSES to write a grant into a
 * path git would track — committing one would publish an authorization, a
 * failure mode the single-use sentinel does not have because it is consumed
 * immediately.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const manifestLib = require('./manifest');

/** Refusal reasons. Distinct by design — an operator debugging a blocked push
 *  needs to know WHICH bound they hit, not merely that they hit one. */
const REASON = Object.freeze({
  NO_GRANT: 'no-grant',
  EXPIRED: 'expired',
  BRANCH_OUT_OF_SCOPE: 'branch-out-of-scope',
  EPIC_MISMATCH: 'epic-mismatch',
  REVOKED: 'revoked',
  EXHAUSTED: 'exhausted',
});

function newGrantId() {
  return `grant_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Would a file at `p` be tracked by git? Returns false when git is unavailable
 * or the directory is not a repo — in those cases there is nothing to publish
 * a credential *to*, so minting is allowed.
 */
function isGitIgnored(repoRoot, p) {
  const r = spawnSync('git', ['check-ignore', '-q', p], { cwd: repoRoot });
  if (r.error) return true;                 // no git — nothing to leak into
  if (r.status === 0) return true;          // ignored
  if (r.status === 1) return false;         // NOT ignored — tracked or trackable
  return true;                              // 128 = not a repo; nothing to leak into
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mint a grant onto the active run. Throws rather than returning an error —
 * minting is an operator action at a terminal, and a silent partial mint is
 * worse than a refusal.
 */
function mint(args) {
  const { repoRoot, epic, branches, expiresIso, landings, actor, nowIso } = args;

  if (typeof epic !== 'string' || !epic) throw new TypeError('mint: epic required');
  if (!Array.isArray(branches) || branches.length === 0) {
    throw new TypeError('mint: at least one branch required — a grant with no branches scopes nothing');
  }
  if (typeof expiresIso !== 'string' || !expiresIso || !Number.isFinite(Date.parse(expiresIso))) {
    throw new TypeError('mint: expiry required — an authorization that outlives attention is the hazard');
  }
  if (!Number.isInteger(landings) || landings < 1) {
    throw new TypeError('mint: at least one landing required — zero is exhausted, not unlimited');
  }

  const manifestPath = manifestLib.manifestPath(repoRoot);
  if (!isGitIgnored(repoRoot, manifestPath)) {
    throw new Error(
      `mint: ${path.relative(repoRoot, manifestPath)} is not ignored by git.\n`
      + '  A grant is a credential — committing one would publish an authorization.\n'
      + '  Add `.momentum/*` to .gitignore before minting.'
    );
  }

  const grant = {
    grant_id: newGrantId(),
    epic,
    branches: branches.slice(),
    expires: expiresIso,
    landings_remaining: landings,
    revoked: false,
    minted_by: actor || '',
    minted_at: nowIso,
    consumptions: [],
  };

  manifestLib.update(repoRoot, (m) => {
    m.grant = grant;
    if (!Array.isArray(m.audit)) m.audit = [];
    m.audit.push({
      ts: nowIso, event: 'start', actor: actor || 'operator',
      detail: `grant ${grant.grant_id} minted: ${branches.join(',')} × ${landings}, expires ${expiresIso}`,
    });
  });
  return grant;
}

/** @returns {object|null} the grant on the active run, or null. */
function load(repoRoot) {
  const m = manifestLib.loadSafe(repoRoot);
  if (!m || !m.grant || !m.grant.grant_id) return null;
  return m.grant;
}

/**
 * PURE. Never mutates, never touches disk beyond what the caller already read.
 * Order matters only for message quality, not correctness — each bound is
 * independent, so the first failing one is reported.
 */
function verify(grant, ctx) {
  if (!grant || !grant.grant_id) return { ok: false, reason: REASON.NO_GRANT };
  if (grant.revoked === true) return { ok: false, reason: REASON.REVOKED };

  if (grant.epic !== ctx.epic) return { ok: false, reason: REASON.EPIC_MISMATCH };

  if (!Array.isArray(grant.branches) || !grant.branches.includes(ctx.branch)) {
    return { ok: false, reason: REASON.BRANCH_OUT_OF_SCOPE };
  }

  const expiry = Date.parse(grant.expires);
  const now = Date.parse(ctx.nowIso);
  if (!Number.isFinite(expiry) || !Number.isFinite(now) || now >= expiry) {
    return { ok: false, reason: REASON.EXPIRED };
  }

  if (!Number.isInteger(grant.landings_remaining) || grant.landings_remaining < 1) {
    return { ok: false, reason: REASON.EXHAUSTED };
  }
  return { ok: true, reason: null };
}

/**
 * Verify and, on success, spend one landing — recording the consumption BEFORE
 * the caller proceeds with the push. A refusal is free: it never decrements.
 */
function consume(repoRoot, ctx) {
  const grant = load(repoRoot);
  const check = verify(grant, ctx);
  if (!check.ok) return { ok: false, reason: check.reason, remaining: grant ? grant.landings_remaining : 0 };

  let remaining = 0;
  manifestLib.update(repoRoot, (m) => {
    m.grant.landings_remaining -= 1;
    remaining = m.grant.landings_remaining;
    if (!Array.isArray(m.grant.consumptions)) m.grant.consumptions = [];
    m.grant.consumptions.push({
      ts: ctx.nowIso, branch: ctx.branch, actor: ctx.actor || '', remaining,
    });
  });
  return { ok: true, reason: null, remaining };
}

function revoke(repoRoot, nowIso) {
  const grant = load(repoRoot);
  if (!grant) return { ok: false, reason: REASON.NO_GRANT };

  manifestLib.update(repoRoot, (m) => {
    m.grant.revoked = true;
    if (!Array.isArray(m.audit)) m.audit = [];
    m.audit.push({ ts: nowIso, event: 'stop', actor: 'operator', detail: `grant ${m.grant.grant_id} revoked` });
  });
  return { ok: true, reason: null };
}

/** One-line explanation for a refusal, rendered by the CLI and the pre-push hook. */
function explain(reason) {
  return {
    [REASON.NO_GRANT]: 'no scope grant on the active run',
    [REASON.EXPIRED]: 'the grant has expired — re-approve to mint a new one',
    [REASON.BRANCH_OUT_OF_SCOPE]: 'this branch is not in the grant\'s allowlist',
    [REASON.EPIC_MISMATCH]: 'the grant was minted for a different epic',
    [REASON.REVOKED]: 'the grant was revoked',
    [REASON.EXHAUSTED]: 'the grant\'s landing budget is spent',
  }[reason] || reason;
}

module.exports = { mint, load, verify, consume, revoke, explain, REASON };
