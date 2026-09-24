'use strict';

/**
 * Git-native ecosystem event capture (Phase 31a G1, ADR-0016).
 *
 * WHY THIS EXISTS
 * ---------------
 * Before 31a the ecosystem session log was written by an AGENT TOOL-HOOK:
 * `check-history-reminder.sh` pattern-matched `git commit` in a Bash tool call
 * and shelled out to `session-append.sh`. That axis fails in the three ways
 * cross-repo work routinely behaves:
 *
 *   1. Wrong tool-name matcher → the branch was unreachable on the default
 *      adapter for its entire life (BUG-028). Two independent multi-repo
 *      sessions produced ZERO log lines across ~10 commits and 5 PRs.
 *   2. `$PWD`-based member resolution → work in a lane worktree (momentum's
 *      OWN recommended concurrency flow, Rule 15) resolved to no member and
 *      silently no-op'd.
 *   3. Only the agent's own tool calls were seen → a commit made by a human,
 *      a script, an IDE, or a different agent was invisible.
 *
 * A git hook has none of those failure modes: it fires on the commit itself,
 * regardless of who or what created it, from any cwd, in any worktree, under
 * any agent — and needs no per-adapter parity work.
 *
 * DESIGN CONSTRAINTS
 * ------------------
 * - **Never block a commit.** Every entry point is fail-open: any error, any
 *   missing dependency, any malformed manifest → silent no-op, exit 0.
 * - **Zero dependencies.** Node builtins + sibling libs only.
 * - **Conflict-free.** Events are per-actor append-only fragments
 *   (`core/team/lib/fragments`, ADR-0012), so N members × N clones committing
 *   concurrently never collide — no lock needed, unlike the legacy
 *   `session-append.sh` mkdir-lock (BUG-004).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const fragments = require('../../team/lib/fragments');
const identity = require('../../identity');
const lib = require('./index');
const teamState = require('./team-state');

/** Fragment view holding ecosystem activity events. */
const EVENTS_VIEW = 'eco-events';

/**
 * Event kinds recorded on the stream.
 *
 * `land` (Phase 31b, ADR-0017 E5) is written by `momentum lanes land --execute`
 * on success. It exists because "has member X landed its contribution?" must be
 * answerable from a RECORD rather than inferred from branch or merge state —
 * the asking machine may not have member X checked out at all, the same reason
 * the 31a completion gate blocks on absent members rather than skipping them.
 */
const EVENT_KINDS = ['commit', 'merge', 'tag', 'land'];

function git(dir, ...args) {
  try {
    const res = spawnSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (res.status !== 0) return null;
    return (res.stdout || '').trim() || null;
  } catch (_e) {
    return null;
  }
}

/**
 * Resolve the TRUE member repo root from any working directory — including a
 * linked worktree, and including a subdirectory of either.
 *
 * `--git-common-dir` is the load-bearing call: for a linked worktree it
 * resolves to the MAIN repo's `.git`, where `--show-toplevel` would return the
 * worktree's own path. That single difference is what made lane worktrees
 * invisible to the pre-31a write path (the `$PWD` bug, ADR-0016 Cause 1).
 *
 * Returns an absolute path, or null when not inside a git repo.
 */
function resolveMemberRepoRoot(cwd) {
  const dir = cwd || process.cwd();
  const common = git(dir, 'rev-parse', '--git-common-dir');
  if (common) {
    // Relative in the main worktree ('.git'), absolute in a linked worktree.
    const abs = path.resolve(dir, common);
    // A non-bare repo's common dir is '<root>/.git'; bare repos have no
    // worktree to attribute anyway, so fall through when the name differs.
    if (path.basename(abs) === '.git') return path.dirname(abs);
  }
  const top = git(dir, 'rev-parse', '--show-toplevel');
  return top ? path.resolve(top) : null;
}

/**
 * Locate the ecosystem root from a member repo.
 *
 * Phase 31b added a local sibling-scanning resolver here because `lib.findRoot`
 * walked UP ONLY and therefore never found the sibling root that
 * `core/ecosystem/layout.md` documents. Phase 31c (ADR-0018 R3) fixed
 * `findRoot` itself, so this is now a thin alias kept for its callers and for
 * back-compatibility with anything importing it.
 *
 * There is exactly ONE discovery implementation. Do not add another.
 */
function resolveEcosystemRootFrom(startDir) {
  return lib.findRoot(startDir);
}

/**
 * Match a member repo root against the ecosystem manifest.
 * Returns the member id, or null when this repo is not a registered member.
 */
function resolveMemberId(ecosystemRoot, repoRoot) {
  let manifest;
  try {
    manifest = lib.loadManifest(ecosystemRoot);
  } catch (_e) {
    return null;
  }
  if (!manifest || !Array.isArray(manifest.members)) return null;

  let target;
  try {
    target = fs.realpathSync(repoRoot);
  } catch (_e) {
    target = path.resolve(repoRoot);
  }

  for (const m of manifest.members) {
    if (!m || !m.path) continue;
    let abs = path.resolve(ecosystemRoot, m.path);
    try { abs = fs.realpathSync(abs); } catch (_e) { /* keep unresolved */ }
    if (abs === target) return m.id;
  }
  return null;
}

/**
 * Record one ecosystem event as an attributed fragment in the ecosystem repo.
 *
 * Fail-open in every branch: not in a repo, no ecosystem, not a member, write
 * error — all return a `{ recorded: false, reason }` object rather than
 * throwing. Callers are git hooks; a thrown error there would block a commit,
 * which this must never do.
 *
 * @param {object} opts
 * @param {string} [opts.cwd]      where the event happened (default process.cwd())
 * @param {string} opts.kind       one of EVENT_KINDS
 * @param {string} opts.summary    one-line description
 * @param {string} [opts.context]  sha / tag / ref
 * @param {string} [opts.ts]       injectable timestamp (tests)
 * @param {number} [opts.seq]      injectable sequence (tests)
 */
function recordEvent(opts) {
  opts = opts || {};
  try {
    const kind = String(opts.kind || '');
    if (!EVENT_KINDS.includes(kind)) {
      return { recorded: false, reason: `unknown kind '${kind}'` };
    }
    const cwd = opts.cwd || process.cwd();

    const repoRoot = resolveMemberRepoRoot(cwd);
    if (!repoRoot) return { recorded: false, reason: 'not a git repo' };

    const ecosystemRoot = opts.ecosystemRoot || resolveEcosystemRootFrom(repoRoot);
    if (!ecosystemRoot) return { recorded: false, reason: 'no ecosystem' };

    const member = resolveMemberId(ecosystemRoot, repoRoot);
    if (!member) return { recorded: false, reason: 'not a registered member' };

    // `opts.env` lets a caller inject the environment actor resolution reads.
    // `identity.resolveActor` has always accepted it; recordEvent simply never
    // passed it through, so the pre-31c hook-side mirror carried a test seam
    // core lacked. Added here rather than working around it in the test —
    // production always uses the ambient env, so behaviour is unchanged.
    const actor = identity.resolveActor(repoRoot, opts.env);
    const payload = {
      member,
      summary: String(opts.summary || '').split('\n')[0].slice(0, 500),
      context: opts.context ? String(opts.context).slice(0, 200) : '',
    };
    // `land` events carry which initiative they belong to and whether the
    // landing order was overridden (Phase 31b, ADR-0017 E5). Recorded on the
    // event rather than inferred later, so a forced land stays visible in the
    // stream instead of vanishing the way a `--no-verify` bypass would.
    if (opts.initiative) payload.initiative = String(opts.initiative).slice(0, 64);
    if (opts.forced) payload.forced = true;

    const frag = fragments.writeFragment(
      ecosystemRoot, EVENTS_VIEW, actor, kind, payload,
      { ts: opts.ts, seq: opts.seq },
    );
    return { recorded: true, ecosystemRoot, member, actor: actor.id, fragment: frag };
  } catch (e) {
    // Never let event capture break the git operation that triggered it.
    return { recorded: false, reason: `error: ${e && e.message}` };
  }
}

/** All recorded events, stable-sorted by (ts, actor, seq). */
function listEvents(ecosystemRoot) {
  return fragments.readFragments(ecosystemRoot, EVENTS_VIEW);
}

function utcDate(ts) {
  return String(ts || '').slice(0, 10);
}

function utcHhMm(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '??:??';
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Compile the fragment event stream into one day's session log markdown.
 *
 * Byte-compatible with the line format `session-append.sh` has always written
 * (`HH:MMZ [member] kind: summary (context)`) so existing readers, greps, and
 * the docs keep working — the change is the WRITE path, not the format. The
 * one addition is the actor suffix, which only appears for events recorded by
 * someone other than the reader... it is always shown, since a shared
 * ecosystem is multi-actor by construction (ADR-0015).
 */
function compileSessionLog(ecosystemRoot, date) {
  const day = date || utcDate(new Date().toISOString());
  const events = listEvents(ecosystemRoot).filter((f) => utcDate(f.ts) === day);

  const lines = [`# Session ${day}`];
  let active = null;
  try {
    active = teamState.getActiveInitiative(ecosystemRoot);
  } catch (_e) { /* best-effort */ }
  if (active && active.slug) lines.push(`Active initiative: ${active.slug}`);
  lines.push('');

  for (const f of events) {
    const p = f.payload || {};
    const ctx = p.context ? ` (${p.context})` : '';
    const by = f.actor ? ` — ${f.actor}` : '';
    lines.push(`${utcHhMm(f.ts)}Z [${p.member}] ${f.kind}: ${p.summary}${ctx}${by}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Materialize `<eco>/sessions/<date>.md` from the fragment stream.
 *
 * The fragments are the source of truth; this file is a compiled VIEW, which
 * is why it can be regenerated at any time and why concurrent writers never
 * conflict (they append disjoint fragments, then anyone compiles).
 */
function writeSessionLog(ecosystemRoot, date) {
  const day = date || utcDate(new Date().toISOString());
  const dir = path.join(ecosystemRoot, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${day}.md`);
  fs.writeFileSync(file, compileSessionLog(ecosystemRoot, day));
  return file;
}

module.exports = {
  EVENTS_VIEW,
  EVENT_KINDS,
  resolveEcosystemRootFrom,
  resolveMemberRepoRoot,
  resolveMemberId,
  recordEvent,
  listEvents,
  compileSessionLog,
  writeSessionLog,
};
