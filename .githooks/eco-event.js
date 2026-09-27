#!/usr/bin/env node
'use strict';

/**
 * Git-native ecosystem event capture — the hook ENTRY POINT (ADR-0016 / ADR-0018).
 *
 * WHY A GIT HOOK
 * --------------
 * Before Phase 31a the ecosystem session log was written by an AGENT TOOL-HOOK,
 * which fails in the three ways cross-repo work routinely behaves: a wrong
 * tool-name matcher made the branch unreachable on the default adapter for its
 * entire life (BUG-028); `$PWD`-based member resolution missed lane worktrees;
 * and only the agent's own tool calls were ever seen. A git hook has none of
 * those failure modes — it fires on the commit itself, whoever or whatever made
 * it, from any cwd, in any worktree.
 *
 * WHAT CHANGED IN 31c
 * -------------------
 * This file used to REIMPLEMENT fragment writing, actor identity, ecosystem
 * discovery and member resolution, because an installed project receives no
 * copy of momentum's `core/`. That premise was never measured; the closure is
 * ~96 kB against a 1.4 MB package. Phase 31c vendors it to
 * `<repo>/.momentum/runtime/`, so this is now a thin entry point over the REAL
 * core modules (ADR-0018 R1). The mirrors it used to carry are what produced
 * BUG-029, and the same class produced BUG-030 one tier along.
 *
 * DESIGN CONSTRAINTS (unchanged)
 * ------------------------------
 * - **Never block a commit.** Every path is fail-open: any error, any missing
 *   dependency → silent no-op, exit 0.
 * - **Zero external dependencies.** Node builtins + the vendored runtime.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * Locate the vendored runtime (ADR-0018 R2).
 *
 * ONE rule, applied identically by every hook entry point — deliberately not the
 * five-entry ad-hoc lookup that R2 exists to prevent. Two candidates, each with
 * a single unambiguous meaning:
 *
 *   1. `../.momentum/runtime` — the INSTALLED layout. `.githooks/` and
 *      `scripts/` both sit one level below repo root, so this literal path
 *      resolves from either (guarded by the depth-1 assertion in
 *      tests/shipped-runtime.test.js).
 *   2. `../../core` — momentum's OWN source tree, where this file is the
 *      template at `core/git-hooks/` rather than an installed copy. Needed
 *      because momentum's tests require this module directly.
 *
 * Candidate 1 wins whenever it exists, so an installed repo never consults 2.
 */
function runtimeDir() {
  const installed = path.join(__dirname, '..', '.momentum', 'runtime');
  if (fs.existsSync(installed)) return installed;
  return path.join(__dirname, '..', '..', 'core');
}

/** Require a runtime module, or null when the runtime is absent (fail-open). */
function rt(rel) {
  try {
    return require(path.join(runtimeDir(), rel));
  } catch (_e) {
    return null;
  }
}

const events = rt('ecosystem/lib/events.js');

/** Fragment view holding ecosystem activity events (re-exported for callers). */
const EVENTS_VIEW = events ? events.EVENTS_VIEW : 'eco-events';

function git(dir, ...args) {
  try {
    const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 5000 });
    if (res.status !== 0) return null;
    return (res.stdout || '').trim() || null;
  } catch (_e) {
    return null;
  }
}

/**
 * Record one ecosystem event. Delegates entirely to `core/ecosystem/lib/events`,
 * which owns member-repo resolution (`--git-common-dir`, so lane worktrees
 * resolve), ecosystem discovery (the single `findRoot`), attribution, and the
 * conflict-free fragment write.
 */
function record(opts) {
  if (!events) return { recorded: false, reason: 'runtime unavailable' };
  try {
    const res = events.recordEvent(opts);
    // Shape shim, not a reimplementation: the pre-31c mirror returned the
    // fragment path as a top-level `file`, while core nests it under
    // `fragment`. Callers of this ENTRY POINT keep the shape they were written
    // against; the logic behind it is core's alone.
    if (res && res.fragment && res.fragment.file && !res.file) {
      return { ...res, file: res.fragment.file };
    }
    return res;
  } catch (_e) {
    return { recorded: false, reason: 'record failed' };
  }
}

/**
 * Cross-repo routing banner (Phase 31b G2, ADR-0017 E1 — git-native half).
 *
 * The AGENT-INDEPENDENT layer: it fires for a human, a script, another tool, or
 * an agent whose PreToolUse nudge was bypassed. Never blocks — post-commit runs
 * after the commit either way.
 */
function routingBanner(ecosystemRoot, actorId, focusMember) {
  try {
    const crossRepo = require('./cross-repo.js');
    const result = crossRepo.detect(ecosystemRoot, { actor: actorId });
    if (!result.shouldRoute) return;
    for (const line of crossRepo.routingMessage(ecosystemRoot, result, focusMember)) {
      process.stderr.write(`${line}\n`);
    }
  } catch (_e) { /* advisory only */ }
}

/** post-commit: record the commit that just landed, then route if uncovered. */
function postCommit(cwd) {
  const dir = cwd || process.cwd();
  const sha = git(dir, 'rev-parse', '--short', 'HEAD');
  const subject = git(dir, 'log', '-1', '--pretty=%s');
  if (!sha || !subject) return { recorded: false, reason: 'no HEAD' };
  const res = record({ cwd: dir, kind: 'commit', summary: subject, context: sha });
  if (res.recorded) routingBanner(res.ecosystemRoot, res.actor, res.member);
  return res;
}

/**
 * post-merge: record a merge that arrived locally.
 *
 * The local half of the forge-API blind spot (ADR-0016 Consequences): a
 * `gh pr merge` runs server-side where no local hook can fire, so the merge is
 * captured on the next fetch/pull that brings it down. Honest partial coverage,
 * documented as such rather than papered over.
 */
function postMerge(cwd) {
  const dir = cwd || process.cwd();
  const sha = git(dir, 'rev-parse', '--short', 'HEAD');
  const subject = git(dir, 'log', '-1', '--pretty=%s');
  if (!sha || !subject) return { recorded: false, reason: 'no HEAD' };
  return record({ cwd: dir, kind: 'merge', summary: subject, context: sha });
}

// ── Back-compatible surface ─────────────────────────────────────────────────
// These were locally implemented before 31c and are re-exported as delegations
// so existing callers and tests keep working against ONE implementation.

const identity = rt('identity/index.js');
const lib = rt('ecosystem/lib/index.js');

const slug = (s) => (identity ? identity.slug(String(s || '')) : String(s || ''));
const resolveActorId = (dir) => (identity ? identity.resolveActor(dir).id : 'unknown');
const resolveRepoRoot = (cwd) => (events ? events.resolveMemberRepoRoot(cwd) : null);
const findEcosystemRoot = (start) => (lib ? lib.findRoot(start) : null);
const resolveMemberId = (ecoRoot, repoRoot) =>
  (events ? events.resolveMemberId(ecoRoot, repoRoot) : null);

module.exports = {
  EVENTS_VIEW,
  runtimeDir,
  slug,
  resolveActorId,
  resolveRepoRoot,
  findEcosystemRoot,
  resolveMemberId,
  record,
  postCommit,
  postMerge,
};
