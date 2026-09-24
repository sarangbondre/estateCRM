#!/usr/bin/env bash
# Append an event line to today's ecosystem session log.
#
# Sourced by core/scripts/check-history-reminder.sh (via the existing
# PostToolUse hook installed by `momentum init`). Safe to invoke
# anywhere — no-ops silently when the current directory is not inside
# a registered ecosystem member.
#
# Inputs (positional):
#   $1 — event kind  (commit | pr | deploy | log)
#   $2 — event summary (one line, no embedded newlines)
#   $3 — optional context (sha, PR number, deploy tag, …)
#
# Resolves the ecosystem root by walking up from $PWD looking for a
# sibling directory containing ecosystem.json (bounded to 5 parents by
# default; override via MOMENTUM_MAX_PARENT_WALK env var — see
# core/ecosystem/lib/state.js for the JS counterpart).
# Resolves the member id by matching $PWD against the manifest's
# members[].path entries.
#
# Writes one line to <ecosystem-root>/sessions/$(date -u +%F).md:
#   HH:MMZ [<member-id>] <kind> <summary> (<context>)
#
# If this is the first append today, prepends a header line naming the
# active initiative (if any).

set -eu

EVENT_KIND="${1:-}"
EVENT_SUMMARY="${2:-}"
EVENT_CONTEXT="${3:-}"

if [ -z "$EVENT_KIND" ] || [ -z "$EVENT_SUMMARY" ]; then
  exit 0
fi

# ── Ecosystem discovery (Phase 31c G3, ADR-0018 R5) ────────────────────────
# Delegates to the ONE implementation in core/ecosystem/lib/index.js via the
# vendored runtime, instead of re-walking the tree in bash. Any future change to
# discovery rules is then made once, not once per language — which is how the
# seven-implementation split accumulated in the first place.
#
# Fail-open in every branch: no node, no runtime, no ecosystem → the caller
# simply gets nothing and carries on. A hook must never break a commit or a
# session start.
momentum_discover() {
  command -v node >/dev/null 2>&1 || return 1
  _d=$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")
  for _c in "$_d/../.momentum/runtime/discover.js" \
            "$_d/../../.momentum/runtime/discover.js" \
            "$_d/../../runtime/discover.js"; do
    [ -f "$_c" ] || continue
    node "$_c" "${1:-$PWD}" 2>/dev/null && return 0
    return 1
  done
  return 1
}

_disc=$(momentum_discover "$PWD") || exit 0
ROOT=$(printf '%s' "$_disc" | cut -f1)
MEMBER_ID=$(printf '%s' "$_disc" | cut -f2)
[ -n "$ROOT" ] || exit 0
[ -f "$ROOT/ecosystem.json" ] || exit 0
[ -n "$MEMBER_ID" ] || exit 0

# ── Write the line ─────────────────────────────────────────────────────────

SESSION_DIR="$ROOT/sessions"
mkdir -p "$SESSION_DIR"
TODAY=$(date -u +%F)
SESSION_FILE="$SESSION_DIR/$TODAY.md"
HHMM=$(date -u +%H:%M)

# ── BUG-004 fix: serialize concurrent writers via mkdir lock ────────────────
# `mkdir` is atomic on POSIX filesystems and portable across macOS/Linux
# without depending on flock (which is not present by default on macOS).
# The lock covers the "check + header-write + append" sequence so two
# concurrent commits in different member repos can't both write the
# header or interleave their data lines.
LOCK_DIR="$SESSION_FILE.lock"
acquire_session_lock() {
  local tries=100  # ~5s total at 50ms each
  while [ $tries -gt 0 ]; do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      return 0
    fi
    sleep 0.05
    tries=$((tries - 1))
  done
  return 1
}
release_session_lock() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap release_session_lock EXIT INT TERM

# If we cannot acquire the lock within the budget, drop the event silently
# rather than corrupt the file. Session events are advisory; momentum's
# correctness does not depend on every one landing.
if ! acquire_session_lock; then
  exit 0
fi

# First write of the day → write header (and active initiative banner).
if [ ! -f "$SESSION_FILE" ]; then
  {
    echo "# Session $TODAY"
    if [ -f "$ROOT/.state/active-initiative" ]; then
      ACTIVE=$(tr -d '[:space:]' < "$ROOT/.state/active-initiative")
      if [ -n "$ACTIVE" ]; then
        echo "Active initiative: $ACTIVE"
      fi
    fi
    echo ""
  } > "$SESSION_FILE"
fi

# Build the line; quote context only if present.
if [ -n "$EVENT_CONTEXT" ]; then
  echo "${HHMM}Z [$MEMBER_ID] ${EVENT_KIND}: ${EVENT_SUMMARY} (${EVENT_CONTEXT})" >> "$SESSION_FILE"
else
  echo "${HHMM}Z [$MEMBER_ID] ${EVENT_KIND}: ${EVENT_SUMMARY}" >> "$SESSION_FILE"
fi

# Cache last session date for cheap subsequent reads.
mkdir -p "$ROOT/.state"
echo "$TODAY" > "$ROOT/.state/last-session"

# Lock is released by the EXIT trap.
exit 0
