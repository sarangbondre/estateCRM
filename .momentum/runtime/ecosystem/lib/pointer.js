'use strict';

/**
 * Pointer block helpers — extracted from bin/ecosystem.js so that
 * `momentum join` / `momentum leave` (Phase 10 Group 1) can reuse the
 * same primitives without duplicating logic.
 *
 * A pointer block is a sentinel-fenced markdown stanza injected at the
 * top of a member repo's primary instruction file (CLAUDE.md / AGENTS.md)
 * telling agents working *inside* the member that the repo is part of
 * an ecosystem, what to do for cross-repo work, and which orchestration
 * primitives are available. It is the only touch the ecosystem layer
 * makes on a member repo — strictly additive.
 *
 * The block is versioned via the BEGIN sentinel:
 *   `<!-- ecosystem:begin v=2 -->`  ← what we WRITE today
 *   `<!-- ecosystem:begin -->`      ← legacy (v1) — auto-migrated on next touch
 *
 * Phase 15 / ENH-032: bumped to v2. The v1 block was information-only
 * ("Member of X ecosystem at ../X."). v2 is action-bearing — it lists
 * the orchestration primitives and the cross-repo routing rule
 * ("write an initiative; never plan cross-repo features here") so an
 * agent reading the member's primary instruction immediately knows
 * how to engage with the ecosystem layer.
 */

const fs = require('fs');
const path = require('path');

const POINTER_VERSION = 2;
const POINTER_BEGIN = `<!-- ecosystem:begin v=${POINTER_VERSION} -->`;
const POINTER_END = '<!-- ecosystem:end -->';

// Loose substring used to DETECT any pointer block (any version).
// The literal v=2 sentinel above is what we WRITE; for detection we
// match the version-less prefix so we can find + migrate v1 blocks.
const POINTER_BEGIN_PREFIX = '<!-- ecosystem:begin';
// Regex covers both `<!-- ecosystem:begin -->` and `<!-- ecosystem:begin v=N -->`.
const POINTER_BEGIN_RE = /<!-- ecosystem:begin(?:\s+v=(\d+))?\s*-->/;
// Match a full block (BEGIN…END) regardless of version. Used by strip
// + replace. The `[\s\S]*?` middle is non-greedy so multiple blocks
// on the same file don't bleed.
const POINTER_BLOCK_RE = /<!-- ecosystem:begin(?:\s+v=\d+)?\s*-->[\s\S]*?<!-- ecosystem:end -->/g;

// Order matters: prefer CLAUDE.md over AGENTS.md when both exist.
// Future adapters can extend this via the adapter contract (Phase 11+).
const PRIMARY_INSTRUCTION_CANDIDATES = ['CLAUDE.md', 'AGENTS.md'];

/**
 * Locate the primary instruction file in a member repo by checking
 * the candidate list in order. Returns the filename (relative) or null.
 */
function findPrimaryInstructionFile(repoPath) {
  for (const name of PRIMARY_INSTRUCTION_CANDIDATES) {
    if (fs.existsSync(path.join(repoPath, name))) {
      return name;
    }
  }
  return null;
}

/**
 * True iff `repoPath` has a primary instruction file containing a
 * pointer block (any version). Returns false on missing file,
 * unreadable file, or absent sentinel.
 */
function hasPointerBlock(repoPath) {
  const primary = findPrimaryInstructionFile(repoPath);
  if (!primary) return false;
  try {
    const content = fs.readFileSync(path.join(repoPath, primary), 'utf8');
    return content.includes(POINTER_BEGIN_PREFIX);
  } catch (_err) {
    return false;
  }
}

/**
 * Render the v2 pointer-block contents (no surrounding sentinels).
 * Exported for tests; also used internally by ensurePointerInjected.
 */
function renderPointerBody(ecosystemName, relFromMember) {
  return [
    `> **Member of \`${ecosystemName}\` ecosystem** at \`${relFromMember}\`.`,
    `>`,
    `> **Cross-repo work?** The moment work touches a SECOND member repo, stop and run`,
    `> \`/brainstorm-initiative\` — never plan cross-repo features in this repo. It writes`,
    `> the initiative to \`${relFromMember}/initiatives/<NNNN-slug>.md\`; each member then`,
    `> runs its OWN \`/start-phase\` or \`/hotfix\`.`,
    `>`,
    `> Lifecycle: \`/brainstorm-initiative\` → \`initiative start\` → member phases → \`initiative complete\``,
    `> _Enforcement: the nudge is best-effort · the landing gate refuses · the write path is unconditional_`,
    `>`,
    `> Orchestration primitives (run from this repo or the ecosystem root):`,
    `> - \`/scout <repo>\` — read another member's state`,
    `> - \`/dispatch <r1> <r2> "..."\` — parallel multi-repo investigation (slash command — \`momentum dispatch\` CLI is keyword-only)`,
    `> - \`/handoff <repo>\` — transfer context to another member`,
    `> - \`/continue\` — resume from an inbox handoff`,
    `>`,
    `> See siblings + live state: \`momentum ecosystem status\``,
  ].join('\n');
}

/**
 * Inject the pointer block immediately after the first H1 in the
 * primary instruction file, or at the top of file if no H1 exists.
 *
 * Behaviour by current state:
 *   - No pointer block      → insert v=POINTER_VERSION block.
 *   - Pointer block, version < POINTER_VERSION  → migrate in place
 *     (replace the entire block contents with the current version).
 *     This is what closes ENH-032 for already-registered members:
 *     the next time `momentum ecosystem add` runs against them
 *     (idempotent re-add, or a fresh add of a different member that
 *     touches the file), the old info-only block is silently upgraded
 *     to the action-bearing v2 form.
 *   - Pointer block, version == POINTER_VERSION → no-op.
 *
 * `absRepo` — absolute path to the member repo.
 * `primaryFile` — filename returned by findPrimaryInstructionFile.
 * `root` — absolute path to the ecosystem root.
 * `ecosystemName` — manifest name (used in the human-readable line).
 */
function ensurePointerInjected(absRepo, primaryFile, root, ecosystemName) {
  const filePath = path.join(absRepo, primaryFile);
  const original = fs.readFileSync(filePath, 'utf8');
  const relFromMember = path.relative(absRepo, root) || '.';
  const body = renderPointerBody(ecosystemName, relFromMember);
  const fullBlock = `${POINTER_BEGIN}\n${body}\n${POINTER_END}`;

  const match = original.match(POINTER_BEGIN_RE);
  if (match) {
    // A pointer block exists. Inspect its version.
    const existingVersion = match[1] ? parseInt(match[1], 10) : 1;
    if (existingVersion >= POINTER_VERSION) {
      // Up-to-date — preserve as-is (and respect any user edits inside).
      return;
    }
    // Migrate in place: replace the FIRST block with the new block.
    let replaced = false;
    const next = original.replace(POINTER_BLOCK_RE, (m) => {
      if (replaced) return m;
      replaced = true;
      return fullBlock;
    });
    fs.writeFileSync(filePath, next, 'utf8');
    return;
  }

  // No pointer block — insert after first H1 (or at top).
  const insertion = `\n${fullBlock}\n`;
  const lines = original.split('\n');
  let insertAt = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^#\s+/.test(lines[i])) {
      insertAt = i + 1;
      break;
    }
  }
  const next = lines
    .slice(0, insertAt)
    .concat(insertion.split('\n').slice(0, -1), lines.slice(insertAt))
    .join('\n');
  fs.writeFileSync(filePath, next, 'utf8');
}

/**
 * All present primary instruction files in a member repo (not just the first).
 * Phase 28 (ADR-0010): the ecosystem pointer must reach EVERY agent's file, so
 * a Codex/opencode session reading AGENTS.md is not blind to the ecosystem.
 */
function findAllInstructionFiles(repoPath) {
  return PRIMARY_INSTRUCTION_CANDIDATES.filter((name) =>
    fs.existsSync(path.join(repoPath, name)));
}

/**
 * Inject/refresh the pointer block in EVERY present instruction file
 * (Phase 28). Returns the list of files touched. When none exist, returns [].
 */
function ensurePointerInjectedAll(absRepo, root, ecosystemName) {
  const files = findAllInstructionFiles(absRepo);
  for (const primaryFile of files) {
    ensurePointerInjected(absRepo, primaryFile, root, ecosystemName);
  }
  return files;
}

/**
 * Strip the pointer block from EVERY present instruction file (Phase 28).
 * Returns only the files that actually HAD a pointer (so callers can report
 * "nothing to strip" accurately).
 */
function stripPointerAll(absRepo) {
  const stripped = [];
  for (const primaryFile of findAllInstructionFiles(absRepo)) {
    const fp = path.join(absRepo, primaryFile);
    let had = false;
    try { had = fs.readFileSync(fp, 'utf8').includes(POINTER_BEGIN_PREFIX); } catch { /* absent */ }
    stripPointer(fp);
    if (had) stripped.push(primaryFile);
  }
  return stripped;
}

/**
 * Strip the pointer block (any version) and one surrounding blank
 * line from the given file. Idempotent: silently no-ops if the file
 * is missing or no pointer block is present.
 */
function stripPointer(filePath) {
  if (!fs.existsSync(filePath)) return;
  const original = fs.readFileSync(filePath, 'utf8');
  if (!original.includes(POINTER_BEGIN_PREFIX)) return;
  // Match leading newline (if any) + the full block + trailing newline
  // (if any). The BLOCK_RE alone doesn't grab the wrapping whitespace,
  // so we wrap it with optional newlines here.
  const re = new RegExp(
    `\\n?${POINTER_BLOCK_RE.source}\\n?`,
    'g',
  );
  fs.writeFileSync(filePath, original.replace(re, '\n'), 'utf8');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  POINTER_VERSION,
  POINTER_BEGIN,
  POINTER_END,
  POINTER_BEGIN_PREFIX,
  POINTER_BEGIN_RE,
  POINTER_BLOCK_RE,
  PRIMARY_INSTRUCTION_CANDIDATES,
  findPrimaryInstructionFile,
  findAllInstructionFiles,
  hasPointerBlock,
  ensurePointerInjected,
  ensurePointerInjectedAll,
  stripPointer,
  stripPointerAll,
  renderPointerBody,
};
