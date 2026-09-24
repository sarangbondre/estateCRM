#!/usr/bin/env node
'use strict';

/**
 * Phase 19 — Lifecycle Hardening, Group 1.
 *
 * momentum git-hook dispatcher: a thin I/O layer over the pure contract in
 * ./contract.js. Invoked by the .githooks/commit-msg and .githooks/pre-push
 * shell wrappers. All decision logic lives in contract.js (unit-tested);
 * this file only does fs/stdin/exit-code plumbing.
 *
 * Vendor-neutral: pure git, no forge API. Runs under any agent on any forge.
 */

const fs = require('node:fs');
const path = require('node:path');
const C = require('./contract');

// git invokes hooks with cwd = repo root.
function repoRoot() {
  return process.cwd();
}

/**
 * Phase 32b / ADR-0020 — try a scope grant when no sentinel is present.
 *
 * ADDITIVE AND FAIL-CLOSED. Every error path returns false, which falls through
 * to the existing refusal: a broken or absent grant subsystem can only ever make
 * the hook stricter, never weaker. That asymmetry is what keeps the ADR-0009
 * floor intact — the grant can authorize a push, but nothing about it can
 * authorize one by failing.
 *
 * @returns {boolean} true when a valid in-scope grant funded this push.
 */
function tryScopeGrant(root, branch) {
  try {
    const runtime = [
      path.join(root, '.momentum', 'runtime', 'run', 'lib', 'grant.js'),
      path.join(__dirname, '..', 'run', 'lib', 'grant.js'),
    ].find((p) => fs.existsSync(p));
    if (!runtime) {
      // AUDIBLE. A stale or missing vendored runtime made the grant path
      // vanish with no message — indistinguishable from "no grant was
      // minted". Found while landing v0.43.1: the grant was valid, the hook
      // simply could not find grant.js and returned false from its catch.
      // Silent unavailability is the same failure family as BUG-031/BUG-033.
      process.stderr.write(
        '  momentum: scope-grant support not found in this repo — the vendored\n'
        + '            runtime is missing or stale. Run `momentum upgrade .` to refresh.\n'
      );
      return false;
    }

    const grantLib = require(runtime);
    const manifestLib = require(path.join(path.dirname(runtime), 'manifest.js'));

    const manifest = manifestLib.loadSafe(root);
    if (!manifest || !manifest.grant) return false;

    let actor = '';
    try {
      actor = require('child_process')
        .execSync('git config user.email', { cwd: root }).toString().trim();
    } catch { actor = 'unknown'; }

    const res = grantLib.consume(root, {
      branch,
      epic: manifest.grant.epic,
      actor,
      nowIso: new Date().toISOString(),
    });

    if (!res.ok) {
      process.stderr.write(
        `  momentum: scope grant not applied — ${grantLib.explain(res.reason)}.\n`
      );
      return false;
    }

    process.stderr.write(
      `  momentum: scope grant ${manifest.grant.grant_id} consumed — push to '${branch}' `
      + `authorized (${res.remaining} landing(s) remaining).\n`
    );
    return true;
  } catch {
    return false; // fail closed
  }
}

function fail(msg) {
  process.stderr.write(`\n✖ momentum git hook blocked this action:\n  ${msg}\n`);
  process.stderr.write(`\n  Emergency bypass (use sparingly): ${C.CONTRACT.skipEnv}=1 <git command>\n\n`);
  process.exit(1);
}

// ── commit-msg ────────────────────────────────────────────────────────────────
function commitMsg(msgFile) {
  if (C.skipRequested()) process.exit(0);
  let content = '';
  try {
    content = fs.readFileSync(msgFile, 'utf8');
  } catch {
    process.exit(0); // no message file — let git handle it
  }
  const { subject, valid } = C.validateCommitMessage(content);
  if (valid) process.exit(0);
  fail(
    `commit subject is not a Conventional Commit:\n      "${subject}"\n` +
    `  Expected:  <type>(scope?)!: description\n` +
    `  where <type> is one of: ${C.CONTRACT.conventionalTypes.join(', ')}`
  );
}

// ── pre-push ──────────────────────────────────────────────────────────────────

/**
 * Phase 26 (ADR-0009) — resolve this project's protected-branch list. Source
 * of truth is `specs/config.md` (read directly, so a hand-edit never leaves
 * the hook enforcing a stale set — review finding I1); the derived cache is
 * only a fallback when config.md is absent. The result is always UNIONed with
 * the invariant floor CONTRACT.protectedBranches, so enforcement can never be
 * weaker than the trust layer requires, even if the cache is edited by hand.
 */
function resolveProtectedBranches(root) {
  const cachePath = path.join(root, C.CONTRACT.configCache);
  let cache = null;
  try {
    cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    /* absent / unparseable — config.md (if present) is the source of truth */
  }
  return C.resolveProtectedBranchesList(root, cache);
}

function findLatestRetro(root) {
  const specsDir = path.join(root, 'specs');
  if (!fs.existsSync(specsDir)) return null;
  const candidates = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('._')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (
        e.name === 'retrospective.md' ||
        (e.name === 'record.md' && dir.split(path.sep).includes('adhoc'))
      ) {
        try {
          candidates.push({ p, mtime: fs.statSync(p).mtimeMs });
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(specsDir);
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].p;
}

function prePush() {
  if (C.skipRequested()) process.exit(0);

  let input = '';
  try {
    input = fs.readFileSync(0, 'utf8'); // git pipes ref lines on stdin
  } catch {
    input = '';
  }
  const root = repoRoot();
  const lines = input.split('\n').map((l) => l.trim()).filter(Boolean);
  const protectedList = resolveProtectedBranches(root);

  for (const line of lines) {
    const parsed = C.parsePrePushLine(line);
    if (!parsed) continue;
    if (/^0+$/.test(parsed.localSha)) continue; // branch/tag deletion — skip

    // (1) Block direct push to a protected branch without the approval sentinel.
    const branch = C.branchFromRef(parsed.remoteRef);
    if (C.branchIsProtected(branch, protectedList)) {
      const sentinel = path.join(root, C.CONTRACT.mergeApprovedSentinel);
      if (fs.existsSync(sentinel)) {
        try {
          fs.unlinkSync(sentinel); // single-use: consume on push
        } catch {
          /* ignore */
        }
        // Team-mode (Phase 30d): record WHO authorized this protected push
        // (attributed audit). Best-effort — an audit-log failure must NEVER
        // block a push, so the whole thing is wrapped and swallowed.
        try {
          const who = (require('child_process')
            .execSync('git config user.email', { cwd: root }).toString().trim()) || 'unknown';
          const line = `${new Date().toISOString()}  ${who}  authorized push to ${branch}  (${parsed.localSha.slice(0, 7)})\n`;
          fs.mkdirSync(path.join(root, '.momentum', 'team'), { recursive: true });
          fs.appendFileSync(path.join(root, '.momentum', 'team', 'merge-approvals.log'), line);
        } catch { /* never block a push on an audit-log failure */ }
        process.stderr.write(
          `  momentum: '${C.CONTRACT.mergeApprovedSentinel}' consumed — push to '${branch}' authorized.\n`
        );
      } else if (!tryScopeGrant(root, branch)) {
        // Phase 32b / ADR-0020: the sentinel is tried FIRST and the grant
        // second, so this path is reached only when neither authorized the
        // push. A repo that never mints a grant sees exactly the v0.42.0
        // message and behaviour.
        fail(
          `direct push to protected branch '${branch}' is blocked.\n` +
          `  Merging to '${branch}' needs explicit human approval. After the user approves,\n` +
          `  authorize a single push with the single-use sentinel:\n` +
          `      touch ${C.CONTRACT.mergeApprovedSentinel}\n` +
          `  (it is consumed on push).\n` +
          `  For a multi-phase epic, one approval can instead mint a scope grant\n` +
          `  covering N landings: momentum run grant --branches ... (ADR-0020).`
        );
      }
    }

    // (2) Block a release-tag push lacking verification evidence (Rule 12 / FEAT-019).
    const tag = C.tagFromRef(parsed.remoteRef);
    if (C.isReleaseTag(tag)) {
      const retro = findLatestRetro(root);
      // Only enforce where the retrospective convention is in use. A project
      // with no retrospective at all is not gated.
      if (retro) {
        let content = '';
        try {
          content = fs.readFileSync(retro, 'utf8');
        } catch {
          content = '';
        }
        if (!C.retroHasEvidence(content)) {
          fail(
            `release tag '${tag}' is blocked: the most recent retrospective\n` +
            `      (${path.relative(root, retro)})\n` +
            `  has no non-empty '${C.CONTRACT.verifyEvidenceHeading}' section.\n` +
            `  Capture fresh verification output there (Rule 12) before tagging a release.`
          );
        }
      }

      // Record the release as an ecosystem `tag` event (Phase 31a, ADR-0016).
      // git has no post-tag hook, and a tag created locally means nothing until
      // it is PUSHED — so the push is the real release moment and the right
      // place to capture it. This is what fills an initiative's Deploy
      // chronology, which shipped empty in the template since Phase 9 (TD-011).
      // Advisory: wrapped so a capture failure can never block a release push.
      try {
        require('./eco-event.js').record({
          kind: 'tag', summary: `release ${tag}`, context: tag,
        });
      } catch (_e) { /* advisory only */ }
    }
  }
  process.exit(0);
}

// ── dispatch ──────────────────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'commit-msg') {
  commitMsg(rest[0]);
} else if (cmd === 'pre-push') {
  prePush();
} else if (cmd === 'post-commit' || cmd === 'post-merge') {
  // Ecosystem event capture (Phase 31a, ADR-0016). Advisory and fail-open:
  // these hooks run AFTER the git operation succeeded, so nothing here may
  // surface an error or a non-zero exit — a failed log append must never make
  // a successful commit look broken.
  try {
    const eco = require('./eco-event.js');
    if (cmd === 'post-commit') eco.postCommit();
    else eco.postMerge();
  } catch (_e) { /* advisory only */ }
  process.exit(0);
} else {
  process.stderr.write(`momentum run-check: unknown command '${cmd}'\n`);
  process.exit(0); // unknown → don't block
}
