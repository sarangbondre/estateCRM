'use strict';

/**
 * Repo state detection — the contract Phase 10's `momentum doctor`
 * and entry/exit commands depend on.
 *
 * A momentum-managed directory is in exactly one state. Knowing the
 * state lets us decide what commands the user can run next.
 *
 * States:
 *   standalone           — momentum-installed; not in any ecosystem.
 *   member               — momentum-installed; pointer present; listed
 *                          in a reachable ecosystem's manifest.
 *   leader               — ecosystem root (has ecosystem.json); not
 *                          itself a member of another ecosystem.
 *   leader-and-member    — ecosystem root that is ALSO a member of a
 *                          different ecosystem (rare; legal).
 *   broken-manifest      — has ecosystem.json that fails validation.
 *   broken-pointer       — has pointer block but is NOT registered
 *                          in any reachable ecosystem.
 *   broken-orphan        — registered in an ecosystem but the pointer
 *                          block is missing from the primary file.
 *
 * `availableTransitions(state)` returns user-facing next-step commands
 * for the doctor recipe to print as teaching output.
 */

const fs = require('fs');
const path = require('path');

const lib = require('./index');
const pointer = require('./pointer');

const MAX_PARENT_WALK_DEFAULT = 5;
const MAX_PARENT_WALK_ENV = 'MOMENTUM_MAX_PARENT_WALK';

/**
 * Resolve the active parent-walk limit, honoring `MOMENTUM_MAX_PARENT_WALK`
 * env override. Negative/non-numeric values fall back to the default.
 */
function getMaxParentWalk() {
  const raw = process.env[MAX_PARENT_WALK_ENV];
  if (raw === undefined || raw === '') return MAX_PARENT_WALK_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return MAX_PARENT_WALK_DEFAULT;
  return Math.floor(n);
}

/**
 * Detect the current state of `repoPath`. Inspects four signals:
 *   - ecosystem.json presence + validity here
 *   - pointer block in primary instruction file
 *   - membership in any reachable ecosystem (walks up + scans siblings)
 *
 * Returns one of the seven state strings documented at the top.
 *
 * Note on cost: this calls `loadManifest` + `validateManifest` for any
 * ecosystem.json in scope. For doctor-style invocations the overhead
 * is irrelevant. State is not cached; callers cache if needed.
 */
function detectState(repoPath) {
  const abs = path.resolve(repoPath);

  // 1. Is this directory itself an ecosystem root?
  let isLeader = false;
  let leaderBroken = false;
  const localManifestPath = path.join(abs, lib.MANIFEST_FILENAME);
  if (safeIsFile(localManifestPath)) {
    isLeader = true;
    try {
      const manifest = lib.loadManifest(abs);
      const v = lib.validateManifest(manifest);
      if (!v.ok) leaderBroken = true;
    } catch (_err) {
      leaderBroken = true;
    }
  }

  // 2. Pointer block present?
  const hasPtr = pointer.hasPointerBlock(abs);

  // 3. Is this directory registered as a member of some reachable ecosystem?
  const registration = findRegistration(abs);
  const isRegistered = registration !== null;

  // Combine signals.
  if (leaderBroken) return 'broken-manifest';
  if (isLeader && hasPtr && isRegistered) return 'leader-and-member';
  if (isLeader) return 'leader';
  if (hasPtr && isRegistered) return 'member';
  if (hasPtr && !isRegistered) return 'broken-pointer';
  if (!hasPtr && isRegistered) return 'broken-orphan';
  return 'standalone';
}

/**
 * Walk up looking for ecosystem.json files, scanning each manifest's
 * members[].path to see if `repoAbs` is registered. Returns
 *   { rootPath, ecosystemName, memberId, memberRole }
 * on first match, or null. Bounded by MAX_PARENT_WALK.
 *
 * The walk pattern mirrors session-append.sh: an ecosystem is a SIBLING
 * of its members, so from a member we walk up and check each sibling
 * for ecosystem.json (and also check `current` itself in case the caller
 * is in the ecosystem root).
 */
function findRegistration(repoAbs) {
  const max = getMaxParentWalk();
  let current = repoAbs;
  for (let depth = 0; depth <= max; depth++) {
    // Check current dir's siblings.
    const parent = path.dirname(current);
    let siblings = [];
    try {
      siblings = fs.readdirSync(parent, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(parent, e.name));
    } catch (_err) {
      // unreadable parent — skip siblings, keep walking
    }
    for (const sib of siblings) {
      const reg = matchInManifest(sib, repoAbs);
      if (reg) return reg;
    }
    // Also check `current` itself (handles leader+member case).
    const selfReg = matchInManifest(current, repoAbs);
    if (selfReg) return selfReg;

    if (parent === current) break;
    current = parent;
  }
  return null;
}

function matchInManifest(candidateRoot, repoAbs) {
  const manifestPath = path.join(candidateRoot, lib.MANIFEST_FILENAME);
  if (!safeIsFile(manifestPath)) return null;
  let manifest;
  try {
    manifest = lib.loadManifest(candidateRoot);
  } catch (_err) {
    return null;
  }
  if (!lib.validateManifest(manifest).ok) return null;
  for (const m of lib.listMembers(manifest)) {
    if (!m || typeof m.path !== 'string') continue;
    const memberAbs = path.resolve(candidateRoot, m.path);
    if (samePath(memberAbs, repoAbs)) {
      return {
        rootPath: candidateRoot,
        ecosystemName: manifest.name,
        memberId: m.id,
        memberRole: m.role,
      };
    }
  }
  return null;
}

function safeIsFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (_err) {
    return false;
  }
}

/**
 * Path equality that's symlink-aware. On macOS `/tmp/foo` and
 * `/private/tmp/foo` are the same path but compare unequal as strings.
 * realpathSync collapses both; if either side cannot be realpathed
 * (missing file) we fall back to a strict string compare.
 */
function samePath(a, b) {
  if (a === b) return true;
  let ra = a;
  let rb = b;
  try {
    ra = fs.realpathSync(a);
  } catch (_e) { /* keep original */ }
  try {
    rb = fs.realpathSync(b);
  } catch (_e) { /* keep original */ }
  return ra === rb;
}

/**
 * Teaching output for `momentum doctor`. Returns an array of
 *   { command, description }
 * objects describing what the user can do from the given state.
 * `context` carries any extra info detection produced (ecosystemName,
 * memberId, etc.) so transitions can be rendered with concrete names.
 */
function availableTransitions(state, context = {}) {
  switch (state) {
    case 'standalone':
      return [
        {
          command: 'momentum join <ecosystem-path>',
          description: 'Attach this repo to an existing ecosystem (e.g. ../my-ecosystem).',
        },
        {
          command: 'momentum init --ecosystem <name>',
          description: 'Create a new ecosystem in a sibling directory and register this repo as the first member.',
        },
      ];
    case 'member': {
      const name = context.ecosystemName ? `"${context.ecosystemName}"` : '<ecosystem>';
      return [
        {
          command: 'momentum leave',
          description: `Detach this repo from ${name} (strips pointer + removes manifest entry).`,
        },
        {
          command: 'momentum ecosystem status',
          description: `Show ${name}'s members and per-member git state.`,
        },
      ];
    }
    case 'leader':
      return [
        {
          command: 'momentum ecosystem add <repo-path>',
          description: 'Register another momentum-installed repo as a member of this ecosystem.',
        },
        {
          command: 'momentum ecosystem status',
          description: 'List members and per-member git state.',
        },
        {
          command: 'momentum ecosystem remove <member-id>',
          description: 'Unregister a member (inverse of add).',
        },
      ];
    case 'leader-and-member': {
      const name = context.ecosystemName ? `"${context.ecosystemName}"` : '<parent-ecosystem>';
      return [
        {
          command: 'momentum ecosystem add <repo-path>',
          description: 'Register a member of THIS ecosystem.',
        },
        {
          command: 'momentum ecosystem status',
          description: 'List members of THIS ecosystem.',
        },
        {
          command: 'momentum leave',
          description: `Detach from parent ecosystem ${name} (keeps this dir as a leader).`,
        },
      ];
    }
    case 'broken-manifest':
      return [
        {
          command: '(fix or remove ecosystem.json)',
          description: 'The manifest at this path fails validation. Repair it by hand, or delete it to revert to standalone.',
        },
      ];
    case 'broken-pointer':
      return [
        {
          command: 'momentum leave',
          description: 'Strip the dangling pointer block (recovers to standalone).',
        },
        {
          command: 'momentum join <ecosystem-path>',
          description: 'Re-attach to an ecosystem if the previous one moved.',
        },
      ];
    case 'broken-orphan': {
      const name = context.ecosystemName ? `"${context.ecosystemName}"` : '<ecosystem>';
      return [
        {
          command: `momentum join ${context.rootPath ? path.relative(process.cwd(), context.rootPath) : '<ecosystem-path>'}`,
          description: `Re-inject the missing pointer (you are listed in ${name} but the pointer block is gone).`,
        },
        {
          command: `momentum ecosystem remove ${context.memberId || '<id>'}`,
          description: `Remove the orphan entry from ${name}'s manifest (run from the ecosystem root).`,
        },
      ];
    }
    default:
      return [];
  }
}

module.exports = {
  MAX_PARENT_WALK_DEFAULT,
  MAX_PARENT_WALK_ENV,
  getMaxParentWalk,
  detectState,
  findRegistration,
  availableTransitions,
};
