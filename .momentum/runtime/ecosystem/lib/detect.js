'use strict';

/**
 * Cross-repo coverage detection (Phase 31b G0, ADR-0017 E2).
 *
 * Answers one question: **is this actor doing cross-repo work that no initiative
 * covers?**
 *
 * WHY THIS IS A QUERY AND NOT A TRACKER
 * -------------------------------------
 * The obvious implementation is a per-session record of "members touched so
 * far". That is unnecessary — ADR-0016's write path already records
 * `{actor, ts, member}` for every commit, so the answer is a query over data
 * momentum already collects. A parallel tracker would be a second source of
 * truth to keep honest, which is the exact failure mode this arc exists to
 * close (BUG-007/BUG-028, and the hook-side writer's parity fence).
 *
 * Two properties follow from that choice, and both are load-bearing:
 *
 *   1. **No git calls.** Everything here is file reads over the fragment stream
 *      and `initiatives/`. That is what makes it cheap enough to run from a
 *      PreToolUse hook on every edit.
 *   2. **A CLOSED initiative covers nothing.** Coverage is a question about live
 *      state, not history. An initiative that shipped last month does not
 *      license today's untracked cross-repo work.
 */

const fs = require('fs');
const path = require('path');

const events = require('./events');
const initiativeLib = require('./initiative');

/** Default lookback for "is this the same stretch of work". */
const DEFAULT_WINDOW_HOURS = 24;

/**
 * Resolve the detection window from ecosystem config, falling back to the
 * default. Invalid values fall back rather than throwing — this runs inside
 * hooks, where an exception is worse than an imperfect window.
 */
function windowHours(manifest) {
  const cfg = (manifest && manifest.config) || {};
  const raw = cfg.detect_window_hours;
  const n = typeof raw === 'number' ? raw : parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WINDOW_HOURS;
}

/**
 * Members this actor has recorded events in, within the window.
 *
 * `opts.actor`  — restrict to one actor (omit for all actors)
 * `opts.hours`  — lookback (defaults to config / 24)
 * `opts.now`    — injectable clock for tests
 * `opts.extra`  — additional member ids to fold in (used by the PreToolUse
 *                 nudge, where the member being edited RIGHT NOW has no event
 *                 yet — the whole point is to fire before the commit).
 */
function touchedMembers(ecosystemRoot, opts) {
  opts = opts || {};
  const hours = opts.hours || DEFAULT_WINDOW_HOURS;
  const now = opts.now ? new Date(opts.now).getTime() : Date.now();
  const cutoff = now - hours * 3600 * 1000;

  const seen = new Set(Array.isArray(opts.extra) ? opts.extra.filter(Boolean) : []);
  let stream = [];
  try {
    stream = events.listEvents(ecosystemRoot);
  } catch (_e) {
    stream = [];
  }

  for (const f of stream) {
    if (!f || !f.payload || !f.payload.member) continue;
    if (opts.actor && f.actor !== opts.actor) continue;
    const ts = new Date(f.ts).getTime();
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    seen.add(f.payload.member);
  }
  return [...seen].sort();
}

/** Every in-progress initiative, parsed. Closed/abandoned are excluded (E2). */
function openInitiatives(ecosystemRoot) {
  const dir = path.join(ecosystemRoot, initiativeLib.INITIATIVES_DIR);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (_e) {
    return [];
  }

  const out = [];
  for (const name of names.sort()) {
    if (!/^\d{4}-.*\.md$/.test(name)) continue;
    let raw = '';
    try {
      raw = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch (_e) {
      continue;
    }
    const { frontmatter } = initiativeLib.parseFrontmatter(raw);
    if (!frontmatter || frontmatter.status !== 'in-progress') continue;

    const repos = new Set(Array.isArray(frontmatter.repos) ? frontmatter.repos : []);
    for (const entry of (frontmatter.contributions || [])) {
      const parsed = initiativeLib.parseContribution(entry);
      if (parsed) repos.add(parsed.member);
    }
    out.push({ slug: frontmatter.slug, file: name, members: repos });
  }
  return out;
}

/**
 * Which in-progress initiative covers `members`, if any.
 *
 * "Covers" means every member in the set appears in that initiative's `repos[]`
 * or `contributions[]`. A partial match does NOT cover: an initiative spanning
 * backend+frontend does not license work that also touches infra, because the
 * infra work is precisely the part nobody planned.
 *
 * Returns { initiative, uncovered } — `initiative` is the covering slug or null,
 * and `uncovered` lists the members no open initiative accounts for.
 */
function coverage(ecosystemRoot, members) {
  const set = [...new Set(members || [])].sort();
  if (set.length === 0) return { initiative: null, uncovered: [] };

  const open = openInitiatives(ecosystemRoot);
  for (const init of open) {
    if (set.every((m) => init.members.has(m))) {
      return { initiative: init.slug, uncovered: [] };
    }
  }

  // Nothing covers the whole set. Report which members no OPEN initiative
  // mentions at all — those are the ones a new initiative must account for.
  const mentioned = new Set();
  for (const init of open) for (const m of init.members) mentioned.add(m);
  return { initiative: null, uncovered: set.filter((m) => !mentioned.has(m)) };
}

/**
 * The detection question, answered.
 *
 * Returns:
 *   {
 *     crossRepo: boolean,   // ≥2 members touched in the window
 *     covered:   boolean,   // an open initiative covers the whole set
 *     members:   string[],  // everything touched
 *     initiative: string|null,
 *     uncovered: string[],  // members no open initiative mentions
 *   }
 *
 * `shouldRoute` (crossRepo && !covered) is the condition the nudge and the
 * commit banner both fire on.
 */
function detect(ecosystemRoot, opts) {
  opts = opts || {};
  let manifest = null;
  try {
    manifest = require('./index').loadManifest(ecosystemRoot);
  } catch (_e) {
    manifest = null;
  }

  const members = touchedMembers(ecosystemRoot, {
    actor: opts.actor,
    hours: opts.hours || windowHours(manifest),
    now: opts.now,
    extra: opts.extra,
  });

  const crossRepo = members.length >= 2;
  const { initiative, uncovered } = coverage(ecosystemRoot, members);

  return {
    crossRepo,
    covered: crossRepo && initiative !== null,
    members,
    initiative,
    uncovered,
    shouldRoute: crossRepo && initiative === null,
  };
}

module.exports = {
  DEFAULT_WINDOW_HOURS,
  windowHours,
  touchedMembers,
  openInitiatives,
  coverage,
  detect,
};
