'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Source-of-truth config file (ADR-0009); the derived cache is a fallback. */
const CONFIG_FILE = 'specs/config.md';

/**
 * Phase 19 — Lifecycle Hardening, Group 0.
 *
 * Canonical contract for momentum's git-lifecycle + ad-hoc-work enforcement.
 * PURE functions + constants only — NO fs access, NO process side effects —
 * so that the git hooks (core/git-hooks/run-check.js), the installer
 * (bin/momentum.js), and the /hotfix command all share ONE source of truth,
 * and the logic is unit-testable in isolation.
 *
 * Vendor-neutral by design (DIP): pure git, no forge API. Enforcement lives in
 * plain git hooks that work on any forge and under any agent. See
 * core/lifecycle-contract.md for the full reference.
 */

const CONTRACT = {
  // Hooks ship as plain scripts in a tracked dir, wired via
  // `git config core.hooksPath`. No husky/lefthook — zero dependencies.
  hooksPath: '.githooks',

  // Emergency bypass for ALL momentum git hooks (e.g. MOMENTUM_SKIP_HOOKS=1).
  skipEnv: 'MOMENTUM_SKIP_HOOKS',

  // Single-use sentinel authorizing ONE push to a protected branch. Created
  // by the agent only after the user approves a merge; consumed on use.
  mergeApprovedSentinel: '.momentum/merge-approved',

  // Direct pushes to these branches are blocked unless the sentinel exists.
  // 'master' included for downstream repos that haven't renamed to 'main'.
  // Default fallback when no config cache is present (ADR-0009).
  protectedBranches: ['main', 'master', 'staging'],

  // Phase 26 — derived config cache read by the pre-push hook to resolve
  // the protected-branch list for THIS project (ADR-0009). Gitignored state,
  // not content. Absent/unparseable → fall back to `protectedBranches` above.
  configCache: '.momentum/config-cache.json',

  // Canonical Verification-Evidence heading in retrospective.md (Rule 12).
  // The same heading gates ad-hoc records (specs/adhoc/<id>/record.md).
  verifyEvidenceHeading: '## Verification Evidence',

  // Allowed Conventional-Commit types: momentum's stated set
  // (feat/fix/docs/refactor/chore/infra) plus the standard extras the project
  // actually uses (test/perf/build/ci/style/revert).
  conventionalTypes: [
    'feat', 'fix', 'docs', 'refactor', 'chore', 'infra',
    'test', 'perf', 'build', 'ci', 'style', 'revert',
  ],

  // First-class work types (Rule 14). 'phase' = full ceremony; 'quick-task' =
  // ad-hoc record + Rule 12 gate, no phase scaffold; 'spike' = declared,
  // gate-exempt, throwaway.
  workTypes: ['phase', 'quick-task', 'spike'],
};

// Subjects that bypass type validation (git-generated or WIP markers).
// 'merge: ' covers the house merge style `merge: x → y` alongside git's
// default `Merge ` (BUG-015 — CLAUDE.md Naming Conventions + repo history).
const COMMIT_SUBJECT_BYPASS = /^(Merge |merge: |Revert "|fixup!|squash!|amend!|Initial commit$)/;

/**
 * True when the emergency bypass env var is set to a truthy value.
 * @param {NodeJS.ProcessEnv} [env]
 */
function skipRequested(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : {});
  const v = e[CONTRACT.skipEnv];
  return v != null && v !== '' && v !== '0' && String(v).toLowerCase() !== 'false';
}

/**
 * The first non-empty, non-comment line of a commit message (the subject).
 * @param {string} message
 * @returns {string}
 */
function firstMeaningfulLine(message) {
  if (!message) return '';
  for (const raw of String(message).split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    return line;
  }
  return '';
}

/**
 * True when a commit subject conforms to Conventional Commits (or is a
 * git-generated/WIP subject that bypasses validation).
 * @param {string} subject
 * @param {string[]} [types]
 */
function isValidCommitSubject(subject, types) {
  const s = (subject || '').trim();
  if (s === '') return false;
  if (COMMIT_SUBJECT_BYPASS.test(s)) return true;
  const typeAlt = (types || CONTRACT.conventionalTypes).join('|');
  // type(scope)!: description — scope and ! optional; single space after colon.
  const re = new RegExp('^(' + typeAlt + ')(\\([^)]+\\))?(!)?: .+');
  return re.test(s);
}

/**
 * Validate a full commit message; returns { subject, valid }.
 * @param {string} message
 * @param {string[]} [types]
 */
function validateCommitMessage(message, types) {
  const subject = firstMeaningfulLine(message);
  return { subject, valid: isValidCommitSubject(subject, types) };
}

/** refs/heads/main -> 'main'; non-branch refs -> null. */
function branchFromRef(ref) {
  if (!ref) return null;
  const m = /^refs\/heads\/(.+)$/.exec(ref);
  return m ? m[1] : null;
}

/** refs/tags/v1.2.3 -> 'v1.2.3'; non-tag refs -> null. */
function tagFromRef(ref) {
  if (!ref) return null;
  const m = /^refs\/tags\/(.+)$/.exec(ref);
  return m ? m[1] : null;
}

/** True for a semver release tag (v1.2.3, v1.2.3-rc.1, ...). */
function isReleaseTag(tag) {
  return !!tag && /^v\d+\.\d+\.\d+/.test(tag);
}

/** True when `branch` is in the protected list. */
function branchIsProtected(branch, list) {
  return !!branch && (list || CONTRACT.protectedBranches).includes(branch);
}

/**
 * Phase 26 (ADR-0009) — resolve the protected-branch list from a parsed
 * config cache object. ADR-0009 makes the trust layer invariant: the
 * protected set can NEVER be weaker than CONTRACT.protectedBranches (the
 * branches that always require human authorization). The cache may only
 * ADD branches to that invariant floor — it can never remove one. So we
 * UNION the cache's `protected_branches` with CONTRACT.protectedBranches.
 * A user-editable, gitignored cache file therefore cannot silently
 * downgrade enforcement (the exact bypass ADR-0009 forbids). Pure — no fs.
 * @param {object|null} cache
 * @returns {string[]} never weaker than CONTRACT.protectedBranches
 */
function protectedBranchesFromCache(cache) {
  const base = CONTRACT.protectedBranches.slice();
  const extra = [];
  if (cache && Array.isArray(cache.protected_branches)) {
    for (const b of cache.protected_branches) {
      const s = String(b).trim();
      if (s && !base.includes(s) && !extra.includes(s)) extra.push(s);
    }
  }
  return base.concat(extra);
}

/**
 * Extract the `protected_branches` CSV list from the SOURCE OF TRUTH
 * (`specs/config.md`) directly. The derived cache can go stale after a
 * hand-edit; reading the source of truth at push time closes that gap
 * (review finding I1) while staying fully self-contained (no config lib
 * needed — just one table row). Returns null when the file/row is absent.
 * @param {string} root
 * @returns {string[]|null}
 */
function protectedBranchesFromConfigFile(root) {
  const file = path.join(root, CONFIG_FILE);
  let body;
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const m = /^\s*\|?\s*protected_branches\s*\|?\s*([^\n|]+)/m.exec(body);
  if (!m) return null;
  const list = m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : null;
}

/**
 * Resolve the protected-branch list the pre-push hook enforces. Source of
 * truth is `specs/config.md` (never stale after a hand-edit — review
 * finding I1); the derived cache is a fallback when config.md is absent.
 * Either way the result is UNIONed with the invariant floor
 * (CONTRACT.protectedBranches) so enforcement can never be weaker than
 * ADR-0009 requires. Reads files only as a fallback; pure w.r.t. the floor.
 * @param {string} root
 * @param {object|null} [cache]  parsed config-cache object (optional)
 * @returns {string[]}
 */
function resolveProtectedBranchesList(root, cache) {
  const floor = CONTRACT.protectedBranches;
  const seen = new Set(floor);
  const out = floor.slice();
  const add = (list) => {
    if (!Array.isArray(list)) return;
    for (const b of list) {
      const s = String(b).trim();
      if (s && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
  };
  // Union every source. config.md is the source of truth for branch_flow-derived
  // branches; the cache may add extras; the floor is the non-removable invariant.
  // No source can REMOVE a branch the floor (or another source) protects.
  add(protectedBranchesFromConfigFile(root));
  if (cache) add(protectedBranchesFromCache(cache));
  return out;
}

/**
 * True when `content` (a retrospective.md or ad-hoc record) has a non-empty
 * `## Verification Evidence` section — i.e. ≥1 non-blank, non-heading line
 * before the next heading.
 * @param {string} content
 * @param {string} [heading]
 */
function retroHasEvidence(content, heading) {
  if (!content) return false;
  const target = (heading || CONTRACT.verifyEvidenceHeading).trim();
  const lines = String(content).split('\n');
  const idx = lines.findIndex((l) => l.trim() === target);
  if (idx === -1) return false;
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^#{1,6}\s/.test(line)) break; // next heading ends the section
    if (line !== '') return true;
  }
  return false;
}

/**
 * Parse a pre-push stdin line: "<localRef> <localSha> <remoteRef> <remoteSha>".
 * Returns null for malformed lines.
 */
function parsePrePushLine(line) {
  const parts = (line || '').trim().split(/\s+/);
  if (parts.length < 4 || parts[0] === '') return null;
  const [localRef, localSha, remoteRef, remoteSha] = parts;
  return { localRef, localSha, remoteRef, remoteSha };
}

module.exports = {
  CONTRACT,
  COMMIT_SUBJECT_BYPASS,
  skipRequested,
  firstMeaningfulLine,
  isValidCommitSubject,
  validateCommitMessage,
  branchFromRef,
  tagFromRef,
  isReleaseTag,
  branchIsProtected,
  protectedBranchesFromCache,
  protectedBranchesFromConfigFile,
  resolveProtectedBranchesList,
  retroHasEvidence,
  parsePrePushLine,
};
