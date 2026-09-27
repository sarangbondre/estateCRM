'use strict';

/**
 * Lane state layer (Phase 21b, FEAT-026 — see ADR-0002).
 *
 * State lives ONCE per repo inside the shared git directory:
 *
 *   <git-common-dir>/momentum/lanes/
 *   ├── registry.json          { stateVersion, lanes: [<id>...] }
 *   └── <id>/
 *       ├── manifest.json      lane manifest (shape below)
 *       └── inbox/             signals (Phase 21b G4); processed/ after ack
 *
 * Anchoring at `git rev-parse --git-common-dir` makes the state
 * untracked by construction, shared across every linked worktree, and
 * gone with the repo. The format is INTERNAL (stateVersion 1) — the
 * publish-as-contract decision is deferred to the 21c close per the
 * platform direction's one-way-door rule.
 *
 * Concurrency: all writes go through a single mkdir-lock chokepoint
 * (the pattern proven in core/swarm/lib/manifest.js); reads are
 * lock-free. Manifest writes are tmp-file + rename for atomicity.
 *
 * Zero dependencies — node builtins only.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const STATE_VERSION = 1;
const LANES_SUBDIR = path.join('momentum', 'lanes');
const REGISTRY = 'registry.json';
const MANIFEST = 'manifest.json';
const LOCK_DIR = '.lock';
const LOCK_RETRIES = 50;
const LOCK_RETRY_MS = 100;

const STATUSES = Object.freeze(['open', 'done', 'landed', 'closed']);
const GRADES = Object.freeze(['phase', 'quick-task', 'spike']);
const ADHOC_BRANCH = /^(fix|chore|feat|refactor|infra)\//;

// ─── git helpers ─────────────────────────────────────────────────────────

function git(cwd, ...args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) return null;
  return res.stdout.trim();
}

/** Absolute path of the shared git dir, from any worktree. Null outside a repo. */
function gitCommonDir(cwd) {
  const out = git(cwd, 'rev-parse', '--git-common-dir');
  if (!out) return null;
  return path.resolve(cwd, out);
}

/** Root of the current worktree. Null outside a repo. */
function worktreeRoot(cwd) {
  return git(cwd, 'rev-parse', '--show-toplevel');
}

/** Anchor dir for lane state (<common>/momentum/lanes). Null outside a repo. */
function resolveAnchor(cwd) {
  const common = gitCommonDir(cwd || process.cwd());
  if (!common) return null;
  return path.join(common, LANES_SUBDIR);
}

/**
 * Anchor dir resolved WITHOUT running git (Phase 31c G2).
 *
 * `resolveAnchor` shells out to `git rev-parse --git-common-dir`, which is
 * correct but unavailable to callers contractually forbidden from spawning git —
 * `core/ecosystem/lib/orient.js` computes a fleet view across every member and
 * must stay cheap and git-free.
 *
 * `.git` is a directory in a normal checkout but a FILE in a linked worktree
 * (`gitdir: /abs/path/.git/worktrees/<name>`), whose sibling `commondir` points
 * back at the shared dir. Lane state lives under the COMMON dir, so a worktree
 * that did not follow that pointer would see no lanes at all — and Rule 15 lane
 * work happens in worktrees, which is exactly where this must be right.
 *
 * This logic arrived in v0.41.1 as part of the BUG-029 fix and lived in
 * `orient.js`. It belongs here, next to the git-based resolver it parallels, so
 * both callers share ONE implementation.
 *
 * `repoDir` must be a repository root (not an arbitrary subdirectory).
 */
function anchorFromRepoDir(repoDir) {
  if (!repoDir) return null;
  const dotGit = path.join(repoDir, '.git');
  let stat;
  try { stat = fs.statSync(dotGit); } catch (_e) { return null; }

  if (stat.isDirectory()) return path.join(dotGit, LANES_SUBDIR);

  let pointer;
  try { pointer = fs.readFileSync(dotGit, 'utf8'); } catch (_e) { return null; }
  const m = pointer.match(/^gitdir:\s*(.+)$/m);
  if (!m) return null;

  const gitdir = path.resolve(repoDir, m[1].trim());
  let common = gitdir;
  try {
    common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim());
  } catch (_e) { /* no commondir — the gitdir itself is the common dir */ }
  return path.join(common, LANES_SUBDIR);
}

// ─── ids / inference ─────────────────────────────────────────────────────

function laneId(branch) {
  return String(branch).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Infer the plan node a branch binds to (the Rule 15 convention as data).
 * `repoRoot` (a worktree root) is used to check for the phase directory.
 */
function inferPlanNode(branch, repoRoot) {
  if (/^phase-/.test(branch)) {
    const dir = repoRoot && fs.existsSync(path.join(repoRoot, 'specs', 'phases', branch));
    return { type: 'phase', ref: branch, dirExists: Boolean(dir) };
  }
  if (ADHOC_BRANCH.test(branch)) {
    return { type: 'adhoc', ref: laneId(branch) };
  }
  return { type: 'unbound', ref: null };
}

function defaultGrade(planNode) {
  if (planNode.type === 'phase') return 'phase';
  return 'quick-task'; // spikes are always declared explicitly
}

// ─── locking ─────────────────────────────────────────────────────────────

function sleepMs(ms) {
  // Synchronous sleep without deps: Atomics.wait on a throwaway buffer.
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

/** Run fn holding the anchor-wide mkdir lock. Throws ELOCK on timeout. */
function withLock(anchor, fn) {
  fs.mkdirSync(anchor, { recursive: true });
  const lock = path.join(anchor, LOCK_DIR);
  let held = false;
  for (let i = 0; i < LOCK_RETRIES; i++) {
    try {
      fs.mkdirSync(lock);
      held = true;
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      sleepMs(LOCK_RETRY_MS);
    }
  }
  if (!held) {
    const e = new Error(`lane state lock busy: ${lock}`);
    e.code = 'ELOCK';
    throw e;
  }
  try {
    return fn();
  } finally {
    try { fs.rmdirSync(lock); } catch { /* already gone */ }
  }
}

// ─── reads (lock-free) ───────────────────────────────────────────────────

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readRegistry(anchor) {
  return readJson(path.join(anchor, REGISTRY)) || { stateVersion: STATE_VERSION, lanes: [] };
}

function laneDir(anchor, id) {
  return path.join(anchor, id);
}

function readManifest(anchor, id) {
  return readJson(path.join(laneDir(anchor, id), MANIFEST));
}

/** All manifests listed in the registry (missing ones skipped). */
function listLanes(anchor) {
  const reg = readRegistry(anchor);
  return reg.lanes.map((id) => readManifest(anchor, id)).filter(Boolean);
}

// ─── writes (locked) ─────────────────────────────────────────────────────

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  );
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + os.EOL);
  fs.renameSync(tmp, file);
}

/**
 * Create + register a lane. Throws EEXIST if the id is already registered
 * with a non-closed manifest.
 */
function createLane(anchor, manifest) {
  const full = {
    stateVersion: STATE_VERSION,
    id: manifest.id,
    branch: manifest.branch,
    planNode: manifest.planNode,
    worktree: manifest.worktree || null,
    grade: manifest.grade,
    touches: manifest.touches || [],
    status: 'open',
    opened: manifest.opened || new Date().toISOString(),
    doneAt: null,
    landedAt: null,
    note: manifest.note || null,
  };
  if (!GRADES.includes(full.grade)) {
    throw new Error(`invalid grade '${full.grade}' (expected ${GRADES.join('|')})`);
  }
  return withLock(anchor, () => {
    const existing = readManifest(anchor, full.id);
    if (existing && existing.status !== 'closed') {
      const e = new Error(`lane '${full.id}' already open (status: ${existing.status})`);
      e.code = 'EEXIST';
      throw e;
    }
    const reg = readRegistry(anchor);
    if (!reg.lanes.includes(full.id)) reg.lanes.push(full.id);
    writeJsonAtomic(path.join(laneDir(anchor, full.id), MANIFEST), full);
    writeJsonAtomic(path.join(anchor, REGISTRY), reg);
    return full;
  });
}

/** Patch a lane manifest. Throws ENOLANE when it doesn't exist. */
function updateLane(anchor, id, patch) {
  return withLock(anchor, () => {
    const current = readManifest(anchor, id);
    if (!current) {
      const e = new Error(`no such lane: '${id}'`);
      e.code = 'ENOLANE';
      throw e;
    }
    if (patch.status && !STATUSES.includes(patch.status)) {
      throw new Error(`invalid status '${patch.status}' (expected ${STATUSES.join('|')})`);
    }
    const next = { ...current, ...patch };
    writeJsonAtomic(path.join(laneDir(anchor, id), MANIFEST), next);
    return next;
  });
}

// ─── inbox reads (writes live in signals.js — G4) ────────────────────────

const INBOX = 'inbox';
const PROCESSED = 'processed';
const SIGNAL_TYPES = Object.freeze(['pause', 'resume', 'redirect', 'kill', 'message']);

function inboxDir(anchor, id) {
  return path.join(laneDir(anchor, id), INBOX);
}

function processedDir(anchor, id) {
  return path.join(inboxDir(anchor, id), PROCESSED);
}

/** Unread signal files for a lane, oldest first. [{file, seq, type, ...body}] */
function unreadSignals(anchor, id) {
  const dir = inboxDir(anchor, id);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((n) => {
      const body = readJson(path.join(dir, n)) || {};
      return { file: n, ...body };
    });
}

function unreadCount(anchor, id) {
  return unreadSignals(anchor, id).length;
}

// ─── touch-path overlap (ENH-047, advisory) ─────────────────────────────

/** Normalize a touch glob to a comparable path prefix. */
function touchPrefix(glob) {
  return String(glob)
    .replace(/\*+.*$/, '') // drop from the first wildcard
    .replace(/\/+$/, '');
}

/** True when two touch declarations plausibly overlap (prefix containment). */
function touchesOverlap(a, b) {
  const pa = touchPrefix(a);
  const pb = touchPrefix(b);
  if (pa === '' || pb === '') return true; // bare '**' overlaps everything
  return pa === pb || pa.startsWith(pb + '/') || pb.startsWith(pa + '/');
}

/**
 * Overlap report between one lane's touches and every other active lane.
 * Returns [{ laneId, mine, theirs }].
 */
function overlapWarnings(anchor, id, touches) {
  const warnings = [];
  if (!touches || touches.length === 0) return warnings;
  for (const other of listLanes(anchor)) {
    if (other.id === id) continue;
    if (other.status === 'closed' || other.status === 'landed') continue;
    for (const mine of touches) {
      for (const theirs of other.touches || []) {
        if (touchesOverlap(mine, theirs)) {
          warnings.push({ laneId: other.id, mine, theirs });
        }
      }
    }
  }
  return warnings;
}

module.exports = {
  STATE_VERSION,
  STATUSES,
  GRADES,
  resolveAnchor,
  anchorFromRepoDir,
  gitCommonDir,
  worktreeRoot,
  laneId,
  inferPlanNode,
  defaultGrade,
  withLock,
  readRegistry,
  readManifest,
  listLanes,
  createLane,
  updateLane,
  laneDir,
  touchesOverlap,
  overlapWarnings,
  SIGNAL_TYPES,
  inboxDir,
  processedDir,
  unreadSignals,
  unreadCount,
};
