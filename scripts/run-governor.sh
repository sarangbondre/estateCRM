#!/usr/bin/env bash
# run-governor.sh — Stop hook (shared by Claude Code + Antigravity)
#
# Phase 32a G3. The INTERCEPTOR backend of the governor contract
# (`core/run/CONTRACT.md`). Its whole job is the contract's single invariant:
#
#     the next unit starts
#
# ONE script for both adapters, deliberately. Two copies would drift, and a
# governor that behaves differently per platform is worse than none — the
# lesson of BUG-028/029/030, where a path production takes diverged from the
# path a test took.
#
# THE DEFECT THIS EXISTS TO FIX: the Autonomous Execution Contract in
# core/commands/start-phase.md is correct prose that is read once at invocation
# and has scrolled out of context by group four, after which the agent starts
# asking permission for things it was already granted. Re-injecting the cursor
# and the pre-authorized action list makes the contract something RE-ESTABLISHED
# every turn rather than something the agent has to remember.
#
# Design constraints:
#   - The common case (no run) must be nearly free. Bail before any real work.
#   - FAIL OPEN. Any error whatsoever must allow the stop. A broken governor
#     trapping a session is strictly worse than no governor at all
#     (CONTRACT.md §"What a backend must provide").
#   - The kill switch is read by the node side BEFORE anything else, so an
#     operator can always halt a misbehaving run with `touch`.
#
# Exit codes:
#   0 — allow the stop (default, and every failure path)
#   2 — block the stop; stderr is delivered to the model as the next instruction

set -uo pipefail

# ── Project root ─────────────────────────────────────────────────────────────
# Same resolution order as brainstorm-gate.sh.
# Project root. Resolution order matters, and PWD is LAST — not first.
#
# The original order ended at $PWD, which works on Claude Code only because it
# exports CLAUDE_PROJECT_DIR. Antigravity exports neither and invokes hooks
# with cwd = `.agents/` (that is why every antigravity hook command is spelled
# `bash ../scripts/...`). So the script looked for `.agents/.momentum/run.json`,
# found nothing, and exited 0 — the governor was DEAD on Antigravity, silently,
# exactly as it was dead in every install before BUG-033.
#
# This script always lives at <repo>/scripts/run-governor.sh, so its own
# location IS the answer, and it needs no cooperation from the host. Same
# literal-path discipline as ADR-0018 R2.
if [ -n "${MOMENTUM_PROJECT_DIR:-}" ]; then
  root="$MOMENTUM_PROJECT_DIR"
elif [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
  root="$CLAUDE_PROJECT_DIR"
else
  _self="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
  if [ -n "$_self" ] && [ -d "$_self/../.momentum" ]; then
    root="$(cd "$_self/.." && pwd)"
  else
    root="$PWD"
  fi
fi

# Cheapest possible exit for the overwhelming majority of sessions: no run file,
# nothing to govern. This is what makes the invariance guarantee real rather
# than aspirational — a repo with no run.json never reaches the node process.
[ -f "$root/.momentum/run.json" ] || exit 0

command -v node >/dev/null 2>&1 || exit 0

# Drain stdin so the caller never blocks on an unread pipe. The payload is not
# needed — the manifest is the state, not the event.
cat >/dev/null 2>&1 || true

# ── Locate the runtime ───────────────────────────────────────────────────────
# Installed projects get the vendored closure at .momentum/runtime/ (ADR-0018);
# the momentum repo itself runs from core/. Literal paths, not a resolver —
# ADR-0018 R2.
_sdir=$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")
helper=""
for _c in \
  "$root/.momentum/runtime/run/lib/hook.js" \
  "$_sdir/../run/lib/hook.js" \
  "$_sdir/../../core/run/lib/hook.js"; do
  if [ -f "$_c" ]; then helper="$_c"; break; fi
done
[ -n "$helper" ] || exit 0

# ── Decide ───────────────────────────────────────────────────────────────────
# The node side prints the continuation instruction on stdout and exits 2 to
# block, or exits 0 to allow the stop. All of its own failure paths exit 0.
out=$(MOMENTUM_RUN_ROOT="$root" node "$helper" 2>/dev/null)
code=$?

if [ "$code" -eq 2 ] && [ -n "$out" ]; then
  # stderr is what the model receives on a blocked stop.
  printf '%s\n' "$out" >&2
  exit 2
fi

exit 0
