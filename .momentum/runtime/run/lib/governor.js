'use strict';

/**
 * Phase 32a G3 — the governor's decision function.
 *
 * `decide(state) → { action, reason, next }` — a PURE function. No I/O, no
 * clock, no filesystem: the caller reads the manifest and the kill switch and
 * passes them in. That is what makes the governor testable without a live agent,
 * and it is why every backend must route through here rather than adding
 * conditions of its own (`core/run/CONTRACT.md`).
 *
 * The invariant is **"the next unit starts"** — not "block the stop". That
 * phrasing is an artifact of one platform's hook surface: Claude Code and
 * Antigravity can block a turn ending, Codex and opencode can only observe one.
 * A backend satisfies this contract if `continue` results in the next unit
 * beginning, by whatever mechanism its host affords.
 */

const ACTION = Object.freeze({
  ALLOW_STOP: 'allow-stop',
  CONTINUE: 'continue',
});

/** Why a stop was allowed. Rendered to the operator, so each is a sentence's worth. */
const STOP_REASON = Object.freeze({
  NO_RUN: 'no-run',
  NOT_RUNNING: 'not-running',
  // BUG-036 — a finished run is a SUCCESS, and must not be reported as one of
  // the failure rails. Before this existed the schema declared `status:
  // complete` and nothing could reach it, so a finished run stayed `running`,
  // the governor answered "continue" every turn with no work left, and the run
  // ended by exhausting its budget as `budget-turns`. The governor could not
  // report success: every completed run looked like a runaway.
  COMPLETE: 'complete',
  KILL_SWITCH: 'kill-switch',
  BUDGET_TURNS: 'budget-turns',
  BUDGET_TOKENS: 'budget-tokens',
  BUDGET_WALL_CLOCK: 'budget-wall-clock',
  STRIKES: 'strikes',
  HARD_GATE: 'hard-gate',
  PARKED_THRESHOLD: 'parked-threshold',
});

const DEFAULT_STRIKE_LIMIT = 3;
const DEFAULT_PARK_THRESHOLD = 5;

function stop(reason, detail) {
  return { action: ACTION.ALLOW_STOP, reason, detail: detail || '', next: null };
}

function minutesBetween(fromIso, nowIso) {
  const from = Date.parse(fromIso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(from) || !Number.isFinite(now)) return 0;
  return (now - from) / 60000;
}

/**
 * @param {object} state
 * @param {object|null} state.manifest   parsed `.momentum/run.json`, or null
 * @param {boolean} state.killSwitch     is `.momentum/run-stop` present?
 * @param {string} [state.now]           ISO timestamp, for the wall-clock budget
 * @param {boolean} [state.hardGate]     caller-detected gate (e.g. release approval)
 * @param {string} [state.hardGateDetail]
 * @returns {{action: string, reason: string, detail: string, next: object|null}}
 */
function decide(state = {}) {
  const { manifest, killSwitch, now, hardGate, hardGateDetail } = state;

  // ── 1. No run ────────────────────────────────────────────────────────────
  // The common case must be free. A repo with no run.json behaves exactly as it
  // did before this phase existed — the invariance guarantee, enforced here
  // rather than merely promised in the plan.
  if (!manifest || typeof manifest !== 'object') {
    return stop(STOP_REASON.NO_RUN);
  }
  if (manifest.status === 'complete') {
    return stop(STOP_REASON.COMPLETE, 'the plan is finished');
  }
  if (manifest.status !== 'running') {
    return stop(STOP_REASON.NOT_RUNNING, `status is ${manifest.status}`);
  }

  // ── 2. Kill switch ───────────────────────────────────────────────────────
  // Checked before everything else because the agent is the thing that may be
  // misbehaving. A kill switch a runaway can reason past is not a kill switch.
  if (killSwitch === true) {
    return stop(STOP_REASON.KILL_SWITCH, 'operator halted the run');
  }

  // ── 3. Budget ────────────────────────────────────────────────────────────
  const budget = manifest.budget || {};
  const spent = manifest.spent || {};
  if (typeof budget.turns === 'number' && (spent.turns || 0) >= budget.turns) {
    return stop(STOP_REASON.BUDGET_TURNS, `${spent.turns || 0}/${budget.turns} turns`);
  }
  if (typeof budget.tokens === 'number' && (spent.tokens || 0) >= budget.tokens) {
    return stop(STOP_REASON.BUDGET_TOKENS, `${spent.tokens || 0}/${budget.tokens} tokens`);
  }
  if (typeof budget.wall_clock_minutes === 'number' && manifest.created && now) {
    const elapsed = minutesBetween(manifest.created, now);
    if (elapsed >= budget.wall_clock_minutes) {
      return stop(STOP_REASON.BUDGET_WALL_CLOCK,
        `${Math.round(elapsed)}/${budget.wall_clock_minutes} min`);
    }
  }

  // ── 4. Strikes ───────────────────────────────────────────────────────────
  // Repeated failure on one unit is not progress; retrying forever burns budget
  // to produce noise.
  const unit = manifest.cursor && manifest.cursor.unit;
  const strikes = (manifest.strikes && unit && manifest.strikes[unit]) || 0;
  const strikeLimit = (manifest.policy && manifest.policy.strike_limit) || DEFAULT_STRIKE_LIMIT;
  if (strikes >= strikeLimit) {
    return stop(STOP_REASON.STRIKES, `${unit}: ${strikes}/${strikeLimit} failures`);
  }

  // ── 5. Hard gate ─────────────────────────────────────────────────────────
  // The one question the operator actually has to answer.
  if (hardGate === true) {
    return stop(STOP_REASON.HARD_GATE, hardGateDetail || 'operator approval required');
  }

  // ── 6. Parked threshold ──────────────────────────────────────────────────
  // Limping on to a 60%-built feature across three branches is worse than
  // stopping cleanly and reporting.
  const parked = Array.isArray(manifest.parked)
    ? manifest.parked.filter((p) => !p.resolved)
    : [];
  const parkThreshold = (manifest.policy && manifest.policy.park_threshold) || DEFAULT_PARK_THRESHOLD;
  if (parked.length >= parkThreshold) {
    return stop(STOP_REASON.PARKED_THRESHOLD, `${parked.length} unresolved questions`);
  }

  // ── 7. Continue ──────────────────────────────────────────────────────────
  // The whole feature.
  return {
    action: ACTION.CONTINUE,
    reason: 'work-remains',
    detail: '',
    next: manifest.cursor || null,
  };
}

/**
 * Human-readable one-liner for a decision. Used by the hook script and by
 * `momentum run status`, so an operator returning to a stopped run learns why
 * from the same sentence the governor recorded.
 */
function explain(decision) {
  if (!decision) return '';
  if (decision.action === ACTION.CONTINUE) {
    const unit = decision.next && decision.next.unit;
    return unit ? `continuing → ${unit}` : 'continuing';
  }
  const base = {
    [STOP_REASON.NO_RUN]: 'no active run',
    [STOP_REASON.NOT_RUNNING]: 'run is not in a running state',
    [STOP_REASON.COMPLETE]: 'run complete',
    [STOP_REASON.KILL_SWITCH]: 'kill switch engaged',
    [STOP_REASON.BUDGET_TURNS]: 'turn budget exhausted',
    [STOP_REASON.BUDGET_TOKENS]: 'token budget exhausted',
    [STOP_REASON.BUDGET_WALL_CLOCK]: 'wall-clock budget exhausted',
    [STOP_REASON.STRIKES]: 'strike limit reached',
    [STOP_REASON.HARD_GATE]: 'operator decision required',
    [STOP_REASON.PARKED_THRESHOLD]: 'too many unresolved questions',
  }[decision.reason] || decision.reason;
  return decision.detail ? `${base} (${decision.detail})` : base;
}

module.exports = {
  decide,
  explain,
  ACTION,
  STOP_REASON,
  DEFAULT_STRIKE_LIMIT,
  DEFAULT_PARK_THRESHOLD,
};
