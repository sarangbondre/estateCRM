'use strict';

/**
 * momentum git-hook helper — cross-repo routing detection (Phase 31b G2, ADR-0017).
 *
 * Produces the routing message shown by BOTH enforcement layers (E1):
 *   - the `post-commit` banner (git-native, agent-independent)
 *   - the `cross-repo-gate.sh` PreToolUse nudge (fires before the edit)
 *
 * WHY THIS IS ANOTHER SELF-CONTAINED FILE
 * ---------------------------------------
 * Third time in this arc, so worth stating plainly rather than rediscovering:
 * an installed project receives NO copy of momentum's `core/`. Anything a hook
 * needs must travel with the hook. `core/git-hooks/eco-event.js` (31a) and
 * `core/ecosystem/lib/orient.js` (31b G1) hit the same wall.
 *
 * This file is therefore node-builtins-only, ships into `.githooks/` beside
 * `eco-event.js`, and resolves `orient.js` LAZILY through a candidate list so
 * it degrades to a detail-free message rather than throwing when orient is not
 * installed. TD-012 tracks consolidating this shipped-runtime story.
 *
 * The coverage logic here is a deliberate minimal mirror of
 * `core/ecosystem/lib/detect.js`, fenced by a parity test — the same discipline
 * applied to the eco-event.js/fragments duplication in 31a.
 */

const fs = require('fs');
const path = require('path');

const EVENTS_VIEW = 'eco-events';

/**
 * Resolve a core module (ADR-0018 R2).
 *
 * ONE depth-independent rule rather than a per-location candidate list: walk up
 * from this file looking for `.momentum/runtime/`, then for a `core/` that
 * contains the module. This file executes from two different depths — as
 * momentum's own `core/ecosystem/lib/cross-repo.js` and as the installed
 * `.githooks/cross-repo.js` — and a fixed relative path cannot serve both.
 *
 * The five-entry hardcoded lookup this file used to carry (for `orient.js`) is
 * exactly what R2 objects to: it encoded assumptions about layout per call site
 * and broke silently when either layout moved. A bounded upward search has one
 * rule and one failure mode.
 */
function resolveModule(rel) {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    for (const base of [path.join(dir, '.momentum', 'runtime'), path.join(dir, 'core')]) {
      const cand = path.join(base, rel);
      try {
        if (fs.existsSync(cand)) {
          // eslint-disable-next-line global-require
          return require(cand);
        }
      } catch (_e) { /* keep searching */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_e) {
    return null;
  }
}

/** Back-compat alias — `sibling` was the 31b-era name. */
const sibling = resolveModule;

function loadOrient() {
  return sibling('ecosystem/lib/orient.js');
}

/**
 * The routing question — delegated to `core/ecosystem/lib/detect`, the authority
 * (Phase 31c G2, ADR-0018 R1).
 *
 * This file used to MIRROR detect.js: its own event-stream scan, its own
 * initiative frontmatter parser, its own coverage rule. The mirror existed only
 * because an installed project had no `core/`; the vendored runtime removes that
 * reason, so the mirror is gone and with it the parity fence that guarded it
 * (R7). Returns detect's shape unchanged.
 */
function detect(ecosystemRoot, opts) {
  const authority = sibling('ecosystem/lib/detect.js');
  if (authority) return authority.detect(ecosystemRoot, opts);
  // Fail-open: no runtime → nothing to route. A hook must never throw.
  return { crossRepo: false, covered: false, shouldRoute: false, members: [], initiative: null };
}

/**
 * The routing message. `focus` is the member being entered right now (the
 * PreToolUse case) — its open P0/P1 items are surfaced, which is what turns
 * "this is cross-repo work" into something worth reading (AC-4).
 */
function routingMessage(ecosystemRoot, result, focus) {
  const lines = [];
  lines.push(`⚠ Cross-repo work with no initiative: ${result.members.join(' + ')}`);

  if (focus) {
    const orient = loadOrient();
    if (orient) {
      try {
        const manifest = readJson(path.join(ecosystemRoot, 'ecosystem.json')) || {};
        const member = (manifest.members || []).find((m) => m && m.id === focus);
        if (member) {
          const summary = orient.orientMember(ecosystemRoot, member);
          for (const l of orient.memberBrief(summary)) lines.push(`  ${l}`);
        }
      } catch (_e) { /* detail is a bonus, never a requirement */ }
    }
  }

  lines.push('  → Run /brainstorm-initiative to open one before going further.');
  lines.push('    (Cross-repo work belongs to an initiative — see ADR-0016.)');
  return lines;
}

// `touchedMembers` / `openInitiativeMembers` / `DEFAULT_WINDOW_HOURS` are gone:
// they were the mirror's internals, and the mirror is deleted (ADR-0018 R1).
// Callers wanting them should use `core/ecosystem/lib/detect` directly — there
// is one implementation now, and this file is an ENTRY POINT over it.
module.exports = {
  EVENTS_VIEW,
  resolveModule,
  sibling,
  loadOrient,
  detect,
  routingMessage,
};
