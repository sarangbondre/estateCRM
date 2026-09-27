'use strict';

/**
 * Fleet orient (Phase 31b G1, ENH-067).
 *
 * Rule 1 says "always read `status.md` first" — but it is per-repo, and it
 * fires at session start. Nothing performs the equivalent when a session
 * reaches into a sibling member mid-flight.
 *
 * The cost of that gap, from the 2026-07-26 review: a session rewrote a cost
 * formatter in a member repo **whose own backlog already tracked BUG-001
 * against that exact formatter**. The information existed, in a file the agent
 * could read, and nothing put it in front of them at the moment it mattered.
 *
 * This module reads each member's own tracking files and returns a structured
 * summary. Design constraints:
 *
 * - **File parsing only.** No member-specific code is imported and no git is
 *   run. A member is just a directory with (maybe) a `specs/` tree.
 * - **Degrades, never throws.** A member with no `specs/`, no checkout, or a
 *   corrupt file yields a partial summary. A fleet view that dies on one bad
 *   member is useless exactly when it matters most — during the messy
 *   multi-repo work it exists to support.
 */

const fs = require('fs');
const path = require('path');

// DELIBERATELY dependency-free (node builtins only). This file is installed
// into a target repo's `scripts/` alongside the session scripts so the
// SessionStart banner can compute a fleet line — and an installed project
// receives NO copy of momentum's `core/`, the same constraint that forced
// `core/git-hooks/eco-event.js` to stand alone in Phase 31a. Requiring
// `./index` here would work in this repo and silently fail in every install.

const MAX_ITEMS = 5;

/**
 * Backlog titles in the wild are not one-liners. Live dogfooding against a real
 * 8-member ecosystem turned up single P1 titles running to full paragraphs
 * (embedded spec catalogues, markdown links, component lists), which made the
 * fleet view unreadable — the opposite of orienting. Titles are truncated at
 * the first sentence-ish boundary and hard-capped; the member's own backlog
 * remains the place to read the whole thing.
 */
const MAX_TITLE = 72;

function condense(title) {
  let s = String(title || '')
    .replace(/\[→\]\([^)]*\)/g, '')          // detail links
    .replace(/`([^`]*)`/g, '$1')             // inline code fences
    .replace(/\*\*/g, '')                    // bold markers
    .replace(/\s+/g, ' ')
    .trim();
  // Prefer cutting at a natural break before hard-truncating.
  const brk = s.search(/\s[—·]\s|\. /);
  if (brk > 20 && brk < MAX_TITLE) s = s.slice(0, brk);
  return s.length > MAX_TITLE ? `${s.slice(0, MAX_TITLE - 1).trimEnd()}…` : s;
}

function readIf(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (_e) {
    return null;
  }
}

/**
 * Active phase rows from a member's `specs/status.md` Active Phase table.
 * Returns [{ phase, branch, status }]; empty when none or unparseable.
 */
function activePhases(statusBody) {
  if (!statusBody) return [];
  const section = statusBody.match(/^## Active Phase\s*$([\s\S]*?)(?=^## |\s*$(?![\s\S]))/m);
  if (!section) return [];

  const rows = [];
  for (const line of section[1].split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) continue;
    if (/^-+$/.test(cells[0].replace(/[:\s]/g, ''))) continue;   // separator
    if (/^phase$/i.test(cells[0])) continue;                      // header
    if (/^_?\(?none/i.test(cells[0])) continue;                   // "(none active)"
    rows.push({
      phase: cells[0],
      branch: cells[1].replace(/`/g, ''),
      status: cells[2],
    });
  }
  return rows;
}

/**
 * Open P0/P1 items from a member's `specs/backlog/backlog.md`.
 * Returns [{ id, priority, title }], capped — the point is a signal, not a dump.
 */
function openBlockers(backlogBody) {
  if (!backlogBody) return [];
  const out = [];
  for (const line of backlogBody.split('\n')) {
    if (!line.startsWith('| ')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 4) continue;
    const [id, title, priority, status] = cells;
    if (!/^(BUG|FEAT|ENH|TD)-\d+$/.test(id)) continue;
    if (!/^P[01]$/.test(priority)) continue;
    if (!/^(open|in-progress)$/i.test(status)) continue;
    out.push({ id, priority, title: condense(title) });
  }
  // P0 before P1, then by id — the reader wants the worst thing first.
  out.sort((a, b) => (a.priority < b.priority ? -1 : a.priority > b.priority ? 1 : 0)
    || (a.id < b.id ? -1 : 1));
  return out;
}

/**
 * Statuses that mean a lane is still in flight. `landed` and `closed` lanes are
 * spent — surfacing them is how BUG-029 reported 30 "open" lanes on a repo whose
 * true state was 29 closed + 1 landed.
 */
const IN_FLIGHT = new Set(['open', 'done']);

/**
 * In-flight lanes for a member — delegated to `core/lanes/lib/state`, the
 * authority (Phase 31c G2, ADR-0018 R1).
 *
 * This function used to re-implement lane-registry reading, because orient.js
 * had to stay dependency-free to ship into installs. It got the format wrong:
 * the registry holds lane ID STRINGS, not objects, so every entry became
 * `{status: undefined}` and `undefined !== 'closed'` passed the repo's entire
 * lane history through as open (BUG-029). The vendored runtime removes the
 * reason for the mirror, so the mirror is gone.
 *
 * `state` is resolved lazily: orient.js is also loaded from `scripts/orient.js`
 * in installs where the sibling path differs, and a missing authority must
 * degrade to "no lanes" rather than throw — a fleet view that dies on one bad
 * member is useless exactly when it matters.
 */
function laneState() {
  for (const rel of ['../../lanes/lib/state', './lanes/lib/state', '../lanes/lib/state']) {
    try {
      // eslint-disable-next-line global-require
      return require(path.join(__dirname, rel));
    } catch (_e) { /* try next */ }
  }
  return null;
}

/**
 * Member local-checkout resolution — delegated to `lib.resolveMemberLocation`,
 * the authority (TD-012, closing the last of its three mirrors).
 *
 * This was the third and final self-contained duplicate TD-012 named. It existed
 * for the same reason as the other two — an installed project had no `core/`, so
 * anything a hook needed had to travel with it — and ADR-0018's vendored runtime
 * removed that reason. The other two mirrors went in 31c; this one outlived them
 * only because nothing had broken yet.
 *
 * Which is precisely the argument for removing it. The last time this file
 * mirrored an authority instead of calling it, the copy read the lane registry's
 * shape wrong and passed the repo's entire lane history through as open
 * (BUG-029) — silently, for a year. A mirror that currently agrees is not a
 * mirror that will keep agreeing: `resolveMemberLocation` grew `kind` and
 * remote-member semantics in Phase 30e, and nothing would have told us if this
 * copy had needed them too.
 *
 * Resolved lazily and degrading to the inline logic, for the same reason
 * `laneState()` does: orient.js is loaded both from `core/ecosystem/lib/` and
 * from `scripts/orient.js` in installs, and a fleet view that dies on one
 * unreachable authority is useless exactly when it matters.
 */
function memberLocation(ecosystemRoot, member) {
  const m = member || {};
  for (const rel of ['./index', '../lib/index', './ecosystem/lib/index']) {
    try {
      // eslint-disable-next-line global-require
      const lib = require(path.join(__dirname, rel));
      if (lib && typeof lib.resolveMemberLocation === 'function') {
        return lib.resolveMemberLocation(ecosystemRoot, m);
      }
    } catch (_e) { /* try next */ }
  }
  // Fail-soft fallback, matching the authority's semantics.
  const relPath = typeof m.path === 'string' && m.path.length > 0 ? m.path : null;
  const localPath = relPath ? path.resolve(ecosystemRoot, relPath) : null;
  let hasLocal = false;
  if (localPath) {
    try { hasLocal = fs.existsSync(localPath); } catch (_e) { hasLocal = false; }
  }
  const remote = typeof m.remote === 'string' && m.remote.length > 0 ? m.remote : null;
  return { id: m.id, role: m.role, path: relPath, remote, localPath, hasLocal };
}

function openLanes(repoDir) {
  const state = laneState();
  if (!state) return [];
  try {
    // anchorFromRepoDir, NOT resolveAnchor: orient is contractually git-free
    // (it runs across every member, and from the SessionStart banner's <100ms
    // budget). state.js owns both resolvers so there is still one implementation.
    const anchor = state.anchorFromRepoDir(repoDir);
    if (!anchor) return [];
    return state.listLanes(anchor)
      .filter((l) => l && IN_FLIGHT.has(l.status))
      .map((l) => ({ id: l.id, branch: l.branch || null, status: l.status }));
  } catch (_e) {
    return [];
  }
}

/**
 * Orient summary for one member.
 * Always returns an object; `reachable: false` when there is no local checkout.
 */
function orientMember(ecosystemRoot, member) {
  const base = { id: member.id, role: member.role, reachable: false, phases: [], blockers: [], lanes: [] };
  const loc = memberLocation(ecosystemRoot, member);
  if (!loc.hasLocal) {
    return { ...base, remote: loc.remote };
  }
  const repoDir = loc.localPath;
  const specs = path.join(repoDir, 'specs');
  if (!fs.existsSync(specs)) {
    // A member that isn't momentum-managed is reachable but has nothing to say.
    return { ...base, reachable: true, managed: false };
  }

  return {
    ...base,
    reachable: true,
    managed: true,
    phases: activePhases(readIf(path.join(specs, 'status.md'))),
    blockers: openBlockers(readIf(path.join(specs, 'backlog', 'backlog.md'))),
    lanes: openLanes(repoDir),
  };
}

/** Orient summary for every member in the manifest. */
function orientFleet(ecosystemRoot, manifest) {
  let m = manifest;
  if (!m) {
    try {
      m = JSON.parse(fs.readFileSync(path.join(ecosystemRoot, 'ecosystem.json'), 'utf8'));
    } catch (_e) {
      return [];
    }
  }
  return (m.members || []).map((member) => orientMember(ecosystemRoot, member));
}

/**
 * One-line fleet summary for the SessionStart banner, or null when there is
 * nothing worth saying. Kept deliberately terse — the banner has a <100ms
 * budget and a noisy banner is one people stop reading.
 */
function fleetLine(summaries) {
  const withBlockers = summaries.filter((s) => s.blockers.length).length;
  const activePhaseCount = summaries.reduce((n, s) => n + s.phases.length, 0);
  const laneCount = summaries.reduce((n, s) => n + s.lanes.length, 0);
  if (!withBlockers && !activePhaseCount && !laneCount) return null;

  const parts = [];
  if (withBlockers) parts.push(`${withBlockers} member${withBlockers === 1 ? '' : 's'} with open P0/P1`);
  if (activePhaseCount) parts.push(`${activePhaseCount} active phase${activePhaseCount === 1 ? '' : 's'}`);
  if (laneCount) parts.push(`${laneCount} open lane${laneCount === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/**
 * The lines the routing nudge shows about a member you are about to touch
 * (Phase 31b AC-4). This is what turns "this is cross-repo work" into
 * "frontend has BUG-001 open on the cost formatter".
 */
function memberBrief(summary) {
  const lines = [];
  if (!summary.reachable) {
    lines.push(`${summary.id}: no local checkout`);
    return lines;
  }
  if (summary.phases.length) {
    const p = summary.phases[0];
    lines.push(`${summary.id}: active phase ${p.phase} (${p.status})`);
  }
  if (summary.blockers.length) {
    const shown = summary.blockers.slice(0, MAX_ITEMS);
    for (const b of shown) lines.push(`${summary.id}: ${b.priority} ${b.id} — ${b.title}`);
    const extra = summary.blockers.length - shown.length;
    if (extra > 0) lines.push(`${summary.id}: +${extra} more open P0/P1`);
  }
  if (summary.lanes.length) {
    lines.push(`${summary.id}: ${summary.lanes.length} open lane(s) — `
      + summary.lanes.map((l) => l.id).join(', '));
  }
  return lines;
}

module.exports = {
  MAX_ITEMS,
  IN_FLIGHT,
  MAX_TITLE,
  condense,
  activePhases,
  openBlockers,
  openLanes,
  orientMember,
  orientFleet,
  fleetLine,
  memberBrief,
};
