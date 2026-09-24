#!/usr/bin/env node
'use strict';

/**
 * Ecosystem discovery for shell callers (Phase 31c G3, ADR-0018 R5).
 *
 * `session-append.sh` and `sessionstart-handoff.sh` each carried their own bash
 * re-implementation of the walk, and `session-append.sh` additionally shelled
 * out to python3 for member resolution. Two more copies of an algorithm that
 * exists once in `core/ecosystem/lib/index.js` — and any future change to
 * discovery rules would have had to be made in two languages, which is exactly
 * how the seven-implementation split accumulated in the first place.
 *
 * This is the single surface those scripts consume. Not a new subprocess cost:
 * both already spawned an interpreter for this work.
 *
 * Usage:
 *     node discover.js <start-dir>
 *
 * Prints two tab-separated fields on success:
 *     <ecosystem-root>\t<member-id-or-empty>
 *
 * Exits 1 and prints nothing when there is no reachable ecosystem. Every
 * failure path is silent — the callers are hooks, and a hook must never break a
 * commit or a session start.
 */

const path = require('path');

function runtimeDir() {
  // `.momentum/runtime/` when installed; this checkout's `core/` in momentum
  // itself. Same two-candidate rule every entry point uses (R2).
  const fs = require('fs');
  const installed = path.join(__dirname, '..', '..', '.momentum', 'runtime');
  if (fs.existsSync(installed)) return installed;
  return path.join(__dirname, '..');
}

function main(argv) {
  const start = argv[0] || process.cwd();
  let lib;
  let events;
  try {
    const base = runtimeDir();
    lib = require(path.join(base, 'ecosystem', 'lib', 'index.js'));
    events = require(path.join(base, 'ecosystem', 'lib', 'events.js'));
  } catch (_e) {
    return 1;
  }

  let root = null;
  try {
    root = lib.findRoot(start);
  } catch (_e) {
    root = null;
  }
  if (!root) return 1;

  // Member id is best-effort: the caller may be in the ecosystem root itself,
  // or in a directory that is not a registered member. Both are valid states
  // and neither is an error — the root alone is still useful.
  let member = '';
  try {
    // Prefer the git-resolved repo root: `--git-common-dir` is what makes a
    // LANE WORKTREE resolve to its true member (ADR-0016 Cause 1).
    const repoRoot = events.resolveMemberRepoRoot(start);
    if (repoRoot) member = events.resolveMemberId(root, repoRoot) || '';
    // Fall back to matching the start directory itself. The bash implementation
    // this replaces resolved members by path alone and therefore worked in
    // directories that are not git repos; dropping that would have been a silent
    // behaviour narrowing rather than a refactor.
    if (!member) member = events.resolveMemberId(root, start) || '';
  } catch (_e) {
    member = '';
  }

  process.stdout.write(`${root}\t${member}\n`);
  return 0;
}

if (require.main === module) {
  let code = 1;
  try {
    code = main(process.argv.slice(2));
  } catch (_e) {
    code = 1; // silent by design
  }
  process.exit(code);
}

module.exports = { main, runtimeDir };
