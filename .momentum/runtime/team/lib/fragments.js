'use strict';

/**
 * Per-actor append-only coordination fragments (Phase 30a Team-Walk, ADR-0012).
 *
 * Bulk coordination state (the status Active-Phase table, changelog, later the
 * backlog) is the ONLY thing that crosses machines today (committed specs) — and
 * it conflicts on every concurrent edit. The fix is the towncrier/reno pattern:
 * each actor writes its own append-only fragment files; a compile step folds
 * them into the rendered view. Because an actor only ever writes paths beginning
 * with its own `<actor>-` prefix, two actors NEVER touch the same file — the
 * merge is conflict-free BY CONSTRUCTION.
 *
 * Fragments live under <repo>/.momentum/team/<view>/ and are COMMITTED (the one
 * exception to the gitignored .momentum/ — see the `!.momentum/team/` rule).
 *
 * Zero dependencies — node builtins only.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SEQ_WIDTH = 6;

function teamRoot(repoRoot) {
  return path.join(repoRoot, '.momentum', 'team');
}
function viewDir(repoRoot, view) {
  return path.join(teamRoot(repoRoot), String(view));
}

function pad(seq) {
  return String(seq).padStart(SEQ_WIDTH, '0');
}
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Highest existing seq for `actorId` in `view` (0 if none). */
function maxSeq(repoRoot, view, actorId) {
  const dir = viewDir(repoRoot, view);
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  const re = new RegExp(`^${escapeRe(actorId)}-(\\d+)-`);
  let max = 0;
  for (const n of names) {
    const m = n.match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

/**
 * Append a fragment. Filename `<actor>-<seq>-<kind>.json` — own-prefix only,
 * so concurrent writers never collide. `actor` may be an id string or an
 * identity object ({ id }). `opts.ts` / `opts.seq` are injectable for testing.
 * Returns the written fragment (with its `file` path).
 */
function writeFragment(repoRoot, view, actor, kind, payload, opts) {
  opts = opts || {};
  const dir = viewDir(repoRoot, view);
  fs.mkdirSync(dir, { recursive: true });
  const actorId = typeof actor === 'string' ? actor : actor.id;
  const seq = opts.seq != null ? opts.seq : maxSeq(repoRoot, view, actorId) + 1;
  const safeKind = String(kind).replace(/[^A-Za-z0-9._-]+/g, '-');
  const frag = {
    actor: actorId,
    seq,
    ts: opts.ts || new Date().toISOString(),
    kind: safeKind,
    payload,
  };
  const file = path.join(dir, `${actorId}-${pad(seq)}-${safeKind}.json`);
  fs.writeFileSync(file, JSON.stringify(frag, null, 2) + os.EOL);
  return Object.assign({ file }, frag);
}

/** All fragments in a view, stable-sorted by (ts, actor, seq). */
function readFragments(repoRoot, view) {
  const dir = viewDir(repoRoot, view);
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const frags = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      frags.push(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
    } catch { /* skip malformed */ }
  }
  frags.sort((a, b) =>
    (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0) ||
    (a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0) ||
    (a.seq - b.seq));
  return frags;
}

/**
 * Fold fragments to the latest per key (own-row / last-writer-wins semantics).
 * `keyFn(frag)` derives the key; because input is stable-sorted, later
 * fragments win. Returns a Map(key → fragment).
 */
function foldLatest(fragments, keyFn) {
  const map = new Map();
  for (const f of fragments) map.set(keyFn(f), f);
  return map;
}

module.exports = { teamRoot, viewDir, writeFragment, readFragments, foldLatest, maxSeq };
