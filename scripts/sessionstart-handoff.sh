#!/usr/bin/env bash
# SessionStart hook — momentum context + handoff auto-greet.
#
# Two banners, printed in this order to stderr:
#
#   1. Ecosystem context (ENH-033, Phase 15) — when CWD is reachable
#      from an ecosystem.json (parent walk + sibling scan), one or two
#      lines naming the ecosystem, member count, and active initiative.
#
#   2. Handoff inbox — when `.momentum/inbox/handoff-*.md` exists, one
#      line per pending handoff. Final line prompts the user
#      `Read now? [y/skip]`; on `y` the script exits 10 to signal the
#      adapter that the next agent action should be `/continue` (or
#      `momentum continue`). On any other input or non-TTY runs, exits
#      0 silently — the handoff stays in the inbox until the user runs
#      `/continue` themselves.
#
# Both banners are silent when not relevant. Total cost target <100ms.
#
# Adapter wiring:
#   - Claude Code:  .claude/settings.json SessionStart entry → this script
#   - Codex:        .codex/hooks.json SessionStart entry → this script
#   - Antigravity:  no SessionStart hook surface; banners ship via
#                   primary instruction text (see overlay).

set -eu

# ─────────────────────────────────────────────────────────────────────────────
# Banner 1 — Ecosystem context (ENH-033)
# ─────────────────────────────────────────────────────────────────────────────
#
# Mirror the parent-walk + sibling-scan algorithm from
# core/ecosystem/scripts/session-append.sh so what the session log
# considers "the reachable ecosystem" is what the SessionStart banner
# announces.

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

ECO_ROOT="$(momentum_discover "$PWD" 2>/dev/null | cut -f1 || true)"

if [ -n "${ECO_ROOT:-}" ] && [ -f "$ECO_ROOT/ecosystem.json" ]; then
  # Extract name + member count. Prefer python3 for JSON parsing; fall
  # back to grep/sed when python3 isn't available (rare but possible).
  if command -v python3 >/dev/null 2>&1; then
    eco_summary=$(python3 - "$ECO_ROOT/ecosystem.json" <<'PY' 2>/dev/null || echo ""
import sys, json
try:
    with open(sys.argv[1]) as f:
        m = json.load(f)
    name = m.get("name", "(unnamed)")
    members = len(m.get("members", []) or [])
    print(f"{name}\t{members}")
except Exception:
    pass
PY
)
  else
    # Crude fallback — extract `"name": "..."` and count `"id":` entries.
    eco_name=$(sed -nE 's/.*"name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$ECO_ROOT/ecosystem.json" | head -1)
    eco_members=$(grep -cE '"id"[[:space:]]*:' "$ECO_ROOT/ecosystem.json" || echo 0)
    eco_summary="${eco_name:-(unnamed)}	${eco_members}"
  fi

  if [ -n "${eco_summary:-}" ]; then
    eco_name=$(printf '%s' "$eco_summary" | cut -f1)
    eco_members=$(printf '%s' "$eco_summary" | cut -f2)
    if [ "$eco_members" = "1" ]; then
      plural=""
    else
      plural="s"
    fi
    printf '▸ Ecosystem: %s (%s member%s)\n' "$eco_name" "$eco_members" "$plural" >&2

    # Active initiative line (only when set).
    if [ -f "$ECO_ROOT/.state/active-initiative" ]; then
      active=$(tr -d '\n' < "$ECO_ROOT/.state/active-initiative" 2>/dev/null | head -c 200)
      if [ -n "$active" ]; then
        printf '▸ Active initiative: %s\n' "$active" >&2
      fi
    fi

    # Fleet line (Phase 31b, ENH-067) — one line naming how many members carry
    # open P0/P1, active phases, and lanes. Rule 1 orients you in THIS repo;
    # this is the fleet equivalent, and it is why a session no longer has to
    # discover a sibling's open bug by tripping over it.
    #
    # Best-effort and silent on any failure: no node, no momentum checkout, a
    # corrupt manifest — all skip. The banner has a <100ms budget, so this is
    # one short-lived node process doing file reads only (core/ecosystem/lib/
    # orient.js makes no git calls by construction).
    if command -v node >/dev/null 2>&1; then
      # orient.js is installed next to this script (bin/momentum.js ships it),
      # with the in-repo source path as a fallback for momentum's own checkout.
      _sdir=$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")
      for _cand in \
        "$_sdir/orient.js" \
        "$_sdir/../core/ecosystem/lib/orient.js"; do
        if [ -f "$_cand" ]; then
          fleet=$(MOMENTUM_ECO_ROOT="$ECO_ROOT" MOMENTUM_ORIENT="$_cand" node -e '
            try {
              const o = require(process.env.MOMENTUM_ORIENT);
              const line = o.fleetLine(o.orientFleet(process.env.MOMENTUM_ECO_ROOT));
              if (line) process.stdout.write(line);
            } catch (_e) { /* silent */ }
          ' 2>/dev/null || true)
          break
        fi
      done
      if [ -n "${fleet:-}" ]; then
        printf '▸ Fleet: %s\n' "$fleet" >&2
      fi
    fi
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# Banner 2 — Handoff inbox (existing behaviour)
# ─────────────────────────────────────────────────────────────────────────────

INBOX_DIR=".momentum/inbox"

# No inbox dir → no pending handoffs.
[ -d "$INBOX_DIR" ] || exit 0

# Walk the inbox and collect pending handoff files.
shopt -s nullglob 2>/dev/null || true
pending=( "$INBOX_DIR"/handoff-*.md )
if [ "${#pending[@]}" -eq 0 ]; then
  exit 0
fi

count="${#pending[@]}"
if [ "$count" -eq 1 ]; then
  plural=""
else
  plural="s"
fi
banner_lines=()
banner_lines+=( "▸ ${count} pending handoff${plural}:" )

for f in "${pending[@]}"; do
  base=$(basename "$f" .md)
  # Pull a one-line summary from the inbox file. Use awk to grab the
  # line after `## Summary` heading. Fallback to filename if missing.
  summary=$(awk '/^## Summary$/{getline; print; exit}' "$f" 2>/dev/null || true)
  [ -z "$summary" ] && summary="(no summary)"
  from=$(awk -F': *' '/^\*\*fromRepo:\*\*/ {print $2; exit}' "$f" 2>/dev/null || true)
  if [ -n "$from" ]; then
    from_label=$(basename "$from")
  else
    from_label="(unknown)"
  fi
  banner_lines+=( "  ▸ ${base} from ${from_label}: ${summary}" )
done

banner_lines+=( "▸ Read now? [y/skip]  (or run: /continue / momentum continue)" )

# Emit the banner. Use stderr so the agent's primary stdout stays
# clean for normal output; adapters that route hook output anywhere
# will still surface it.
for line in "${banner_lines[@]}"; do
  printf '%s\n' "$line" >&2
done

# If stdin is not a TTY (CI, agent harness without interactive surface)
# just exit 0 — the banner has informed the user (or downstream
# adapter) without forcing a blocking read.
if [ ! -t 0 ]; then
  exit 0
fi

# Read a single character with a short timeout so we don't hang an
# unattended session start.
ans=""
if IFS= read -t 5 -r -n 1 ans 2>/dev/null; then
  : # read succeeded (ans may be empty if user hit Enter)
fi
printf '\n' >&2

case "$ans" in
  y|Y) exit 10 ;;
  *)   exit 0  ;;
esac
