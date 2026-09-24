#!/usr/bin/env bash
# momentum cross-repo-gate hook — PreToolUse routing nudge (Phase 31b, ADR-0017).
#
# Fires BEFORE a write lands, when the target path is inside a DIFFERENT
# ecosystem member than the one this session has been working in and no
# in-progress initiative covers the set.
#
# THIS IS ADVICE, NOT A GATE. It always exits 0 (never 2). ADR-0017 E1 puts the
# teeth on the git axis — `lanes land` refuses, this only prompts — because an
# agent hook is bypassed by exactly the three things cross-repo work does
# constantly: lane worktrees, forge-API merges, and container-directory
# launches. Blocking here would create the illusion of enforcement while
# leaving all three holes open.
#
# Design constraints:
#   - The common case (not in an ecosystem, or not inside a member) must be
#     nearly free — bail before doing any real work.
#   - Fires ONCE per session per member, not per edit. Nudge fatigue is how a
#     prompt becomes noise the agent learns to skip.
#   - Silent on every failure. A broken helper must never block a write.
#
# Exit codes: always 0.

set -eu

input=$(cat 2>/dev/null || true)
[ -n "$input" ] || exit 0

# ── Extract the target path (Claude Code / Codex / Antigravity shapes) ────────
extract_path() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null && return
  fi
  printf '%s' "$input" \
    | grep -oE '"(file_path|path)"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -1 \
    | sed -E 's/.*:[[:space:]]*"([^"]+)"$/\1/' || true
}

target=$(extract_path 2>/dev/null || true)
[ -n "${target:-}" ] || exit 0

# Resolve to an absolute path so member matching works from any cwd.
case "$target" in
  /*) abs="$target" ;;
  *)  abs="${MOMENTUM_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$PWD}}/$target" ;;
esac

command -v node >/dev/null 2>&1 || exit 0

# ── Locate the helper (installed beside the git hooks, or in-repo) ───────────
_sdir=$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")
helper=""
for _c in \
  "$_sdir/../.githooks/cross-repo.js" \
  "$_sdir/cross-repo.js" \
  "$_sdir/../ecosystem/lib/cross-repo.js" \
  "$_sdir/../core/ecosystem/lib/cross-repo.js"; do
  if [ -f "$_c" ]; then helper="$_c"; break; fi
done
[ -n "$helper" ] || exit 0

# ── Detect + nudge, once per session per member ──────────────────────────────
# The "once" marker lives under the ecosystem root's gitignored .state/, keyed
# by member. A second edit to the same member stays silent.
# Session id when the adapter supplies one (Claude Code does); the node side
# falls back to a time throttle when it does not.
sid=$(printf '%s' "$input" | grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -1 | sed -E 's/.*:[[:space:]]*"([^"]+)"$/\1/' || true)

MOMENTUM_TARGET="$abs" MOMENTUM_HELPER="$helper" MOMENTUM_SID="${sid:-}" node -e '
try {
  const fs = require("fs");
  const path = require("path");
  const crossRepo = require(process.env.MOMENTUM_HELPER);
  const target = process.env.MOMENTUM_TARGET;

  // Walk up from the target for an ecosystem (self + siblings), bounded.
  const max = parseInt(process.env.MOMENTUM_MAX_PARENT_WALK || "5", 10) || 5;
  let cur = path.dirname(target), root = null;
  for (let i = 0; i <= max && !root; i++) {
    if (fs.existsSync(path.join(cur, "ecosystem.json"))) { root = cur; break; }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    let sibs = [];
    try { sibs = fs.readdirSync(parent); } catch (_e) { sibs = []; }
    for (const s of sibs) {
      if (fs.existsSync(path.join(parent, s, "ecosystem.json"))) { root = path.join(parent, s); break; }
    }
    cur = parent;
  }
  if (!root) process.exit(0);

  // Which member does the target live in?
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "ecosystem.json"), "utf8"));

  // Resolve BOTH sides through realpath before comparing. The target file
  // usually does not exist yet (that is the point of a PRE-write hook), and
  // neither may its directory, so realpath the nearest EXISTING ancestor and
  // re-append the rest. Without this, macOS resolves the member to
  // /private/var/... while the target stays /var/..., they never match, and
  // the nudge silently never fires for a new file in a new directory.
  const realish = (p) => {
    let head = p, tail = [];
    for (;;) {
      try { return path.join(fs.realpathSync(head), ...tail); } catch (_e) { /* climb */ }
      const parent = path.dirname(head);
      if (parent === head) return p;
      tail.unshift(path.basename(head));
      head = parent;
    }
  };

  const t = realish(path.dirname(target));
  let focus = null;
  for (const m of (manifest.members || [])) {
    if (!m || !m.path) continue;
    const abs = realish(path.resolve(root, m.path));
    const rel = path.relative(abs, t);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) { focus = m.id; break; }
  }
  if (!focus) process.exit(0);

  // Fold the member being entered into the touched set — it has no event yet,
  // which is the entire reason this fires before the commit.
  const result = crossRepo.detect(root, { extra: [focus], manifest });
  if (!result.shouldRoute) process.exit(0);

  // BUG-032 (Phase 32d) — an active run grant IS the coordination record this
  // nudge asks for, so a covered run is not nudged.
  //
  // Resolved from the MEMBER BEING ENTERED, not the hook process cwd. The first
  // version read the invoking directory, so an unrelated run in whatever repo
  // happened to be cwd silenced the nudge for a completely different project.
  // Caught by the gate test, which spawns from the momentum repo while editing
  // a temp ecosystem.
  try {
    const memberDir = (manifest.members || [])
      .map((mm) => mm && mm.path && path.resolve(root, mm.path))
      .find((p) => p && path.basename(p) === focus);
    if (memberDir) {
      const runJson = path.join(memberDir, ".momentum", "run.json");
      if (fs.existsSync(runJson)) {
        const run = JSON.parse(fs.readFileSync(runJson, "utf8"));
        if (run && run.status === "running" && run.grant && run.grant.revoked !== true
            && Date.parse(run.grant.expires) > Date.now()) {
          process.exit(0);
        }
      }
    }
  } catch (_e) { /* no run, or unreadable — fall through and nudge */ }

  // Once per session per member. Keyed by the adapter session id when there is
  // one; otherwise throttled by time. NOT keyed by pid — every hook invocation
  // is a fresh shell, so a pid key never repeats and the nudge fires on every
  // single edit, which is precisely the fatigue this guard exists to prevent.
  const THROTTLE_MS = 30 * 60 * 1000;
  const sid = (process.env.MOMENTUM_SID || "").replace(/[^A-Za-z0-9._-]/g, "") || "nosid";
  const stateDir = path.join(root, ".state", "nudged");
  const marker = path.join(stateDir, `${sid}-${focus}`);
  try {
    const st = fs.statSync(marker);
    if (sid !== "nosid") process.exit(0);                       // same session: once, ever
    if (Date.now() - st.mtimeMs < THROTTLE_MS) process.exit(0); // no session id: time-throttled
  } catch (_e) { /* no marker yet */ }
  try { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(marker, ""); } catch (_e) {}

  for (const line of crossRepo.routingMessage(root, result, focus)) {
    process.stderr.write(line + "\n");
  }
} catch (_e) { /* silent */ }
'
# NOTE: node's stderr is deliberately NOT redirected here — the nudge itself is
# written to stderr. The inline script's own try/catch is what keeps failures
# silent, so a redirect would only suppress the message we exist to print.
true

exit 0
