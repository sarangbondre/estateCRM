'use strict';

/**
 * Phase 32a G3 — run-manifest CRUD.
 *
 * `.momentum/run.json` is the resume point. Agents are stateless across turns,
 * so everything needed to restart a run after compaction, session death, or a
 * machine restart lives here and nowhere else. Every write goes through this
 * module under the shared mkdir lock; backends are forbidden from writing the
 * file directly (`core/run/CONTRACT.md`).
 *
 * Zero-dependency structural validation, mirroring the house pattern in
 * `core/swarm/lib/manifest.js` and `core/ecosystem/lib/index.js`: the JSON
 * Schema at `../schema/run.schema.json` is the authoritative contract and this
 * validator is its operational counterpart.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { withLock } = require('./lock');

const SCHEMA_VERSION = 1;
const MOMENTUM_DIR = '.momentum';
const MANIFEST_FILENAME = 'run.json';
const KILL_SWITCH_FILENAME = 'run-stop';

const TIERS = Object.freeze(['group', 'phase', 'epic', 'initiative']);
const STATUSES = Object.freeze(['running', 'parked', 'stopped', 'complete', 'failed']);

const LOCK_LABEL = 'run/manifest';

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

function momentumDir(repoRoot) {
  return path.join(repoRoot, MOMENTUM_DIR);
}

function manifestPath(repoRoot) {
  return path.join(momentumDir(repoRoot), MANIFEST_FILENAME);
}

/**
 * The kill switch is a bare file an operator can `touch` from any shell, with
 * no momentum command in the loop. That is deliberate: the thing it stops may
 * be the thing that would otherwise have to cooperate.
 */
function killSwitchPath(repoRoot) {
  return path.join(momentumDir(repoRoot), KILL_SWITCH_FILENAME);
}

function killSwitchEngaged(repoRoot) {
  try { return fs.existsSync(killSwitchPath(repoRoot)); } catch (_e) { return false; }
}

function clearKillSwitch(repoRoot) {
  try { fs.unlinkSync(killSwitchPath(repoRoot)); } catch (_e) { /* already absent */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

function validate(m) {
  const errors = [];
  if (!m || typeof m !== 'object') return ['manifest must be an object'];

  if (m.schema_version !== SCHEMA_VERSION) {
    // Refuse rather than guess — an unversioned or future resume format read
    // optimistically is how a run silently loses state.
    errors.push(`unsupported schema_version ${JSON.stringify(m.schema_version)} (expected ${SCHEMA_VERSION})`);
  }
  if (typeof m.run_id !== 'string' || !/^run_[a-z0-9]{4,16}$/.test(m.run_id)) {
    errors.push(`invalid run_id ${JSON.stringify(m.run_id)}`);
  }
  if (!TIERS.includes(m.tier)) errors.push(`invalid tier ${JSON.stringify(m.tier)}`);
  if (typeof m.target !== 'string' || !m.target) errors.push('target required');
  if (!STATUSES.includes(m.status)) errors.push(`invalid status ${JSON.stringify(m.status)}`);
  if (!m.policy || typeof m.policy !== 'object') errors.push('policy required');
  if (!m.cursor || typeof m.cursor !== 'object' || typeof m.cursor.unit !== 'string') {
    errors.push('cursor.unit required');
  }
  if (typeof m.created !== 'string') errors.push('created required');
  return errors;
}

function assertValid(m) {
  const errors = validate(m);
  if (errors.length) {
    throw new Error(`run/manifest: invalid manifest — ${errors.join('; ')}`);
  }
  return m;
}

// ─────────────────────────────────────────────────────────────────────────────
// Read / write
// ─────────────────────────────────────────────────────────────────────────────

/** @returns {object|null} the manifest, or null when there is no run. */
function load(repoRoot) {
  const p = manifestPath(repoRoot);
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`run/manifest: ${p} is not valid JSON — ${err.message}`);
  }
  return assertValid(parsed);
}

/**
 * Best-effort load for the hook path. A malformed manifest must never trap a
 * session — `CONTRACT.md` requires backends to fail open, and the hook reaches
 * this before it reaches the governor.
 */
function loadSafe(repoRoot) {
  try { return load(repoRoot); } catch (_e) { return null; }
}

function write(repoRoot, manifest) {
  assertValid(manifest);
  const p = manifestPath(repoRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  withLock(p, () => {
    // Write-then-rename: a crash mid-write must not leave a truncated resume point.
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, p);
  }, { label: LOCK_LABEL });
  return manifest;
}

/** Locked read-modify-write. `fn` mutates the manifest in place. */
function update(repoRoot, fn) {
  const p = manifestPath(repoRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return withLock(p, () => {
    const current = JSON.parse(fs.readFileSync(p, 'utf8'));
    fn(current);
    assertValid(current);
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, p);
    return current;
  }, { label: LOCK_LABEL });
}

// ─────────────────────────────────────────────────────────────────────────────
// Construction
// ─────────────────────────────────────────────────────────────────────────────

function newRunId() {
  return `run_${crypto.randomBytes(4).toString('hex')}`;
}

function create(args) {
  const { repoRoot, tier, target, unit, policy, budget, nowIso, runId } = args;
  const manifest = {
    schema_version: SCHEMA_VERSION,
    run_id: runId || newRunId(),
    tier,
    target,
    status: 'running',
    policy: Object.assign({ release: 'per-phase', push: 'per-phase', tdd: 'strict' }, policy || {}),
    cursor: { unit: unit || target, started: nowIso, path: [target] },
    decisions: [],
    parked: [],
    strikes: {},
    amendments: [],
    spent: { turns: 0, tokens: 0 },
    created: nowIso,
    audit: [{ ts: nowIso, event: 'start', actor: 'run', detail: `${tier}:${target}` }],
  };
  if (budget) manifest.budget = budget;
  return write(repoRoot, manifest);
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutations — each one an audited state transition
// ─────────────────────────────────────────────────────────────────────────────

function appendAudit(m, entry) {
  if (!Array.isArray(m.audit)) m.audit = [];
  m.audit.push(entry);
}

/**
 * Advance to the next unit. IDEMPOTENT BY CURSOR: a backend may fire twice for
 * one logical turn (platforms differ, retries happen), and advancing twice
 * would silently skip a unit. The cursor is the guard, not the backend's memory
 * — `CONTRACT.md` §"What a backend must provide".
 */
function advance(repoRoot, nextUnit, nowIso) {
  return update(repoRoot, (m) => {
    if (m.cursor && m.cursor.unit === nextUnit) return; // already there — no-op
    m.cursor = { unit: nextUnit, started: nowIso, path: (m.cursor && m.cursor.path) || [] };
    appendAudit(m, { ts: nowIso, event: 'continue', actor: 'governor', detail: nextUnit });
  });
}

/**
 * Count one governor continuation. Deliberately SEPARATE from `advance`:
 * `advance` is idempotent by cursor (so a doubled backend event cannot skip a
 * unit), which means it must not carry the turn counter — a counter that no-ops
 * on repeat would let a run loop forever without ever reaching its turn budget.
 * One function moves the cursor; the other counts turns.
 */
function recordTurn(repoRoot, nowIso, tokens) {
  return update(repoRoot, (m) => {
    m.spent = m.spent || { turns: 0, tokens: 0 };
    m.spent.turns = (m.spent.turns || 0) + 1;
    if (typeof tokens === 'number' && tokens > 0) {
      m.spent.tokens = (m.spent.tokens || 0) + tokens;
    }
    appendAudit(m, { ts: nowIso, event: 'continue', actor: 'governor', detail: `turn ${m.spent.turns}` });
  });
}

function recordDecision(repoRoot, decision, nowIso) {
  return update(repoRoot, (m) => {
    if (!Array.isArray(m.decisions)) m.decisions = [];
    m.decisions.push(Object.assign({ ts: nowIso, authority: 'agent' }, decision));
  });
}

function recordPark(repoRoot, park, nowIso) {
  return update(repoRoot, (m) => {
    if (!Array.isArray(m.parked)) m.parked = [];
    m.parked.push(Object.assign({ ts: nowIso, resolved: false }, park));
    appendAudit(m, { ts: nowIso, event: 'park', actor: 'run', detail: park.question || '' });
  });
}

function resolvePark(repoRoot, id, answer, nowIso) {
  return update(repoRoot, (m) => {
    const item = (m.parked || []).find((p) => p.id === id);
    if (!item) throw new Error(`run/manifest: no parked item ${id}`);
    item.resolved = true;
    item.answer = answer;
    appendAudit(m, { ts: nowIso, event: 'resolve', actor: 'operator', detail: id });
  });
}

function recordStrike(repoRoot, unit, nowIso) {
  return update(repoRoot, (m) => {
    if (!m.strikes || typeof m.strikes !== 'object') m.strikes = {};
    m.strikes[unit] = (m.strikes[unit] || 0) + 1;
    appendAudit(m, { ts: nowIso, event: 'strike', actor: 'run', detail: `${unit}=${m.strikes[unit]}` });
  });
}

function clearStrikes(repoRoot, unit) {
  return update(repoRoot, (m) => {
    if (m.strikes && m.strikes[unit]) delete m.strikes[unit];
  });
}

/**
 * Record a failing→passing transition for one task (Epic 0001 D12).
 *
 * With the operator absent for several phases, this is the ONLY evidence of
 * progress that is not the agent's own opinion. That is why TDD stops being a
 * quality preference in autonomous mode and becomes the control signal: "is
 * this done?" was previously answered by a human looking at it.
 *
 * Stored on the manifest rather than inferred from test output, because a run
 * must be able to prove this after the fact, from disk, with no test runner.
 */
function recordRedGreen(repoRoot, unit, task, nowIso) {
  return update(repoRoot, (m) => {
    if (!m.red_green || typeof m.red_green !== 'object') m.red_green = {};
    if (!Array.isArray(m.red_green[unit])) m.red_green[unit] = [];
    if (!m.red_green[unit].includes(task)) m.red_green[unit].push(task);
    appendAudit(m, { ts: nowIso, event: 'continue', actor: 'run', detail: `red→green ${unit}:${task}` });
  });
}

/** PURE. Has `task` on `unit` got a recorded red→green? */
function hasRedGreen(manifest, unit, task) {
  if (!manifest || !manifest.red_green) return false;
  const list = manifest.red_green[unit];
  return Array.isArray(list) && list.includes(task);
}

function setStatus(repoRoot, status, nowIso, detail) {
  if (!STATUSES.includes(status)) throw new Error(`run/manifest: invalid status ${status}`);
  return update(repoRoot, (m) => {
    m.status = status;
    const event = { running: 'resume', stopped: 'stop', complete: 'complete', failed: 'fail', parked: 'park' }[status];
    appendAudit(m, { ts: nowIso, event, actor: 'run', detail: detail || '' });
  });
}

module.exports = {
  TIERS,
  STATUSES,
  momentumDir,
  manifestPath,
  killSwitchPath,
  killSwitchEngaged,
  clearKillSwitch,
  validate,
  load,
  loadSafe,
  write,
  update,
  create,
  advance,
  recordTurn,
  recordDecision,
  recordPark,
  resolvePark,
  recordStrike,
  recordRedGreen,
  hasRedGreen,
  clearStrikes,
  setStatus,
};
