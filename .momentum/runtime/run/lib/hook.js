'use strict';

/**
 * Phase 32a G3 — the node side of the interceptor backend.
 *
 * Invoked by `core/scripts/run-governor.sh` on the host's Stop event. Reads the
 * manifest and kill switch, asks `governor.decide()`, and either allows the
 * stop (exit 0) or blocks it (exit 2) with the continuation instruction on
 * stdout — which the shell wrapper forwards to the model on stderr.
 *
 * FAIL OPEN, ALWAYS. Every failure path in this file exits 0. A broken governor
 * that traps a session is strictly worse than no governor at all
 * (`core/run/CONTRACT.md` §"What a backend must provide"). There is exactly one
 * exit-2 path, and it requires a valid manifest, a live run, and an explicit
 * `continue` from the pure decision function.
 */

const governor = require('./governor');
const manifestLib = require('./manifest');

/**
 * The pre-authorized action list, re-injected on every continuation.
 *
 * This is the actual repair. The list already exists as prose in
 * `core/commands/start-phase.md` under "Pre-authorized actions", where it is
 * read once and forgotten by group four — after which the agent starts asking
 * permission for things it was already granted. Re-stating it each turn makes
 * the contract something re-established rather than remembered.
 */
const PRE_AUTHORIZED = [
  'Commit per the plan\'s per-group commit message — do not ask.',
  'Push the working branch — do not ask.',
  'Run tests, lint, typecheck, build — do not ask.',
  'Update tasks.md, history.md, status.md, the changelog — do not ask.',
  'File backlog entries and ADRs from discoveries — do not ask.',
  'Proceed to the next unit when the current one verifies — the answer is always yes.',
];

function continuationMessage(manifest, decision) {
  const cursor = decision.next || {};
  const lines = [];

  lines.push('▸ momentum run — the run is still active; continue without asking.');
  lines.push('');
  lines.push(`  Run:    ${manifest.run_id}  (${manifest.tier}: ${manifest.target})`);
  lines.push(`  Next:   ${cursor.unit || manifest.target}`);

  const spent = manifest.spent || {};
  const budget = manifest.budget || {};
  if (typeof budget.turns === 'number') {
    lines.push(`  Turns:  ${spent.turns || 0}/${budget.turns}`);
  }

  const parked = (manifest.parked || []).filter((p) => !p.resolved);
  if (parked.length) {
    // Parked work is NON-BLOCKING: it freezes only the thread that needs an
    // answer. Naming the blocked units keeps the agent off them without
    // stopping everything else.
    lines.push('');
    lines.push(`  Parked (${parked.length}) — do NOT work these units; everything else proceeds:`);
    for (const p of parked.slice(0, 5)) {
      lines.push(`    - ${p.blocked_unit}: ${p.question}`);
    }
  }

  lines.push('');
  lines.push('  Pre-authorized — proceed silently:');
  for (const a of PRE_AUTHORIZED) lines.push(`    - ${a}`);

  lines.push('');
  lines.push('  Stop ONLY for: a destructive operation not in the plan, a discovery that');
  lines.push('  invalidates the agreed plan, or an action requiring credentials/spend.');
  lines.push(`  Operator halt: touch ${manifestLib.killSwitchPath(process.env.MOMENTUM_RUN_ROOT || '.')}`);

  return lines.join('\n');
}

function main() {
  const root = process.env.MOMENTUM_RUN_ROOT || process.cwd();

  // loadSafe never throws — a malformed manifest degrades to "no run".
  const manifest = manifestLib.loadSafe(root);
  if (!manifest) return 0;

  const decision = governor.decide({
    manifest,
    killSwitch: manifestLib.killSwitchEngaged(root),
    now: new Date().toISOString(),
  });

  if (decision.action !== governor.ACTION.CONTINUE) {
    // Record why the run stopped so `momentum run status` can explain it later
    // without the operator having to reconstruct it. Best-effort: a failure to
    // write the reason must not turn an allowed stop into a blocked one.
    try {
      if (decision.reason !== governor.STOP_REASON.NOT_RUNNING) {
        manifestLib.setStatus(root, 'stopped', new Date().toISOString(), governor.explain(decision));
      }
    } catch (_e) { /* fail open */ }
    return 0;
  }

  try {
    manifestLib.recordTurn(root, new Date().toISOString());
  } catch (_e) {
    // If the turn cannot be counted the budget cannot be enforced, so the safe
    // move is to allow the stop rather than risk an uncounted loop.
    return 0;
  }

  process.stdout.write(continuationMessage(manifest, decision));
  return 2;
}

if (require.main === module) {
  let code = 0;
  try {
    code = main();
  } catch (_e) {
    code = 0; // fail open, unconditionally
  }
  process.exit(code);
}

// ─────────────────────────────────────────────────────────────────────────────
// The CONTRACT.md backend surface (Phase 32c G1)
//
// 32a shipped this backend as a script entry point and never exposed the named
// surface its own CONTRACT.md requires. It worked — subprocess tests proved the
// production path — but the contract was aspirational on the very backend that
// authored it, and 32c's conformance suite is what surfaced that. A contract
// only one implementation satisfies is a description, not a contract.
// ─────────────────────────────────────────────────────────────────────────────

/** Interceptor is available wherever the host can block a turn ending. */
function supports() {
  return true; // the hook is only installed on adapters declaring `interceptor`
}

/**
 * @param {object} decision  from `governor.decide` — this backend never re-decides
 * @param {{repoRoot: string, dryRun?: boolean}} ctx
 * @returns {{started: boolean, obstructed: boolean, unit: string|null}}
 */
function onTurnEnd(decision, ctx = {}) {
  const root = ctx.repoRoot || process.env.MOMENTUM_RUN_ROOT || process.cwd();
  try {
    if (!decision || decision.action !== governor.ACTION.CONTINUE) {
      // Never obstruct a stop the governor allowed.
      return { started: false, obstructed: false, unit: null };
    }
    const unit = (decision.next && decision.next.unit) || null;

    // Idempotence is the CURSOR's job, not this backend's memory: a doubled
    // platform event must start the unit once. `advance` no-ops when the cursor
    // is already there, which is exactly the guard.
    manifestLib.advance(root, unit, new Date().toISOString());

    if (!ctx.dryRun) manifestLib.recordTurn(root, new Date().toISOString());
    return { started: true, obstructed: false, unit };
  } catch (_e) {
    // Fail open, unconditionally. A broken governor that traps a session is
    // strictly worse than no governor at all.
    return { started: false, obstructed: false, unit: null };
  }
}

module.exports = { main, continuationMessage, PRE_AUTHORIZED, supports, onTurnEnd };
