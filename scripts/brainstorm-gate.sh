#!/usr/bin/env bash
# brainstorm-gate.sh — PreToolUse hook (shared across Claude Code + Codex + Antigravity)
#
# Blocks write-class tool calls targeting paths under specs/ while a
# brainstorm session is active (indicated by the .momentum/brainstorm-active
# sentinel file).
#
# Phase 16 Rework: promoted from adapters/claude-code/scripts/ to
# core/scripts/ and generalized to handle all three adapters' native tool
# names and payload shapes.
#
# Tool names matched per platform:
#   Claude Code: Write, Edit, MultiEdit
#   Codex:       apply_patch, Bash
#   Antigravity: run_command, view_file, *write*, apply_patch
#
# Project root resolution (in order):
#   1. MOMENTUM_PROJECT_DIR (explicit override)
#   2. CLAUDE_PROJECT_DIR (Claude Code sets this)
#   3. PWD (Codex + Antigravity hooks run with cwd = session root)
#
# Exit codes:
#   0 — allow the tool call (default; also used for fail-open paths)
#   2 — block the tool call (stderr is shown to the model)

set -euo pipefail

# ---------------------------------------------------------------------------
# 1. Read hook input (JSON on stdin)
# ---------------------------------------------------------------------------
input=$(cat)

# ---------------------------------------------------------------------------
# 2. Extract tool_name + file path from payload.
#
# Payload shapes we handle:
#   - Claude Code:  {tool_name, tool_input: {file_path: "..."}}
#   - Codex apply_patch:  {tool_name: "apply_patch", tool_input: {input: "*** Update File: <path>\n..."}}
#   - Codex Bash:         {tool_name: "Bash", tool_input: {command: "..."}}
#   - Antigravity:        {tool_name, tool_input: {path: "...", command?: "..."}}
#
# Strategy: try jq first (best precision), fall back to grep/sed.
# Extract `file_path` (Claude / Antigravity) OR `path` (Antigravity) OR
# the first `*** Update File:` / `*** Add File:` line from `input` (Codex apply_patch).
# ---------------------------------------------------------------------------
if command -v jq >/dev/null 2>&1; then
  tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null || true)
  file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)
  if [[ -z "${file_path:-}" ]]; then
    # Antigravity uses `path` instead of `file_path` for some tools
    file_path=$(printf '%s' "$input" | jq -r '.tool_input.path // empty' 2>/dev/null || true)
  fi
  if [[ -z "${file_path:-}" ]]; then
    # Codex apply_patch — extract from input
    patch_input=$(printf '%s' "$input" | jq -r '.tool_input.input // empty' 2>/dev/null || true)
    if [[ -n "$patch_input" ]]; then
      file_path=$(printf '%s' "$patch_input" \
        | grep -oE '\*\*\* (Update|Add|Delete) File: [^ ]+' \
        | head -1 \
        | sed -E 's/\*\*\* (Update|Add|Delete) File: //' || true)
    fi
  fi
  if [[ -z "${file_path:-}" ]]; then
    # Last resort — look for shell command targeting specs/
    cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
    if [[ -n "$cmd" ]]; then
      # Match: `> specs/path`, `>> specs/path`, `echo ... specs/path`, etc.
      file_path=$(printf '%s' "$cmd" \
        | grep -oE '(specs/[^[:space:]"'"'"'\\]+)' \
        | head -1 || true)
    fi
  fi
else
  # No jq — regex fallbacks. Brittle but adequate for canonical shapes.
  tool_name=$(printf '%s' "$input" \
    | grep -oE '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -1 \
    | sed -E 's/.*:[[:space:]]*"([^"]+)"$/\1/' || true)
  file_path=$(printf '%s' "$input" \
    | grep -oE '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -1 \
    | sed -E 's/.*:[[:space:]]*"([^"]+)"$/\1/' || true)
  if [[ -z "${file_path:-}" ]]; then
    file_path=$(printf '%s' "$input" \
      | grep -oE '"path"[[:space:]]*:[[:space:]]*"[^"]*"' \
      | head -1 \
      | sed -E 's/.*:[[:space:]]*"([^"]+)"$/\1/' || true)
  fi
  if [[ -z "${file_path:-}" ]]; then
    # Codex apply_patch path extraction (string-mode escapes)
    file_path=$(printf '%s' "$input" \
      | grep -oE '\*\*\* (Update|Add|Delete) File: [^\\"]+' \
      | head -1 \
      | sed -E 's/\*\*\* (Update|Add|Delete) File: //' || true)
  fi
fi

# ---------------------------------------------------------------------------
# 3. Allow non-write tool calls
#    Match Claude Code (Write/Edit/MultiEdit), Codex (apply_patch/Bash),
#    Antigravity (run_command/view_file/*write*/apply_patch).
# ---------------------------------------------------------------------------
case "${tool_name:-}" in
  Write|Edit|MultiEdit) ;;        # Claude Code
  apply_patch|Bash) ;;             # Codex (per docs: canonical tool_name is "Bash" for shell)
  run_command|view_file) ;;        # Antigravity (matcher includes these)
  *write*) ;;                      # Antigravity wildcard
  *) exit 0 ;;
esac

# ---------------------------------------------------------------------------
# 4. Resolve project root.
#    MOMENTUM_PROJECT_DIR (override) → CLAUDE_PROJECT_DIR → PWD.
# ---------------------------------------------------------------------------
project_dir="${MOMENTUM_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-${PWD:-}}}"
if [[ -z "${project_dir}" || ! -d "${project_dir}" ]]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# 5. Sentinel check — if the brainstorm-active sentinel is missing, allow.
# ---------------------------------------------------------------------------
sentinel="${project_dir}/.momentum/brainstorm-active"
if [[ ! -e "$sentinel" ]]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# 6. Path check — only block writes under specs/.
# ---------------------------------------------------------------------------
if [[ -z "${file_path:-}" ]]; then
  exit 0  # fail-open if path missing
fi

# Resolve relative paths against project_dir
case "$file_path" in
  /*) abs_path="$file_path" ;;
  *)  abs_path="${project_dir}/${file_path}" ;;
esac

specs_dir="${project_dir}/specs/"
case "$abs_path" in
  "${specs_dir}"*)
    cat >&2 <<EOF
[brainstorm-gate] Blocked: cannot write to specs/ during active brainstorm.
[brainstorm-gate] Path: ${file_path}
[brainstorm-gate]
[brainstorm-gate] The conversation IS the draft. Get explicit user approval, then:
[brainstorm-gate]   rm .momentum/brainstorm-active
[brainstorm-gate] and retry the write.
EOF
    exit 2
    ;;
  *)
    exit 0
    ;;
esac
