'use strict';

/**
 * Team presence — heartbeat-on-invocation (Phase 30b Team-Run, ADR-0013).
 *
 * No daemon: any `momentum` command refreshes a short-TTL presence fragment;
 * liveness (active/idle/offline) is DERIVED from `last_seen` age against config
 * thresholds. Presence rides the same collision-free fragment substrate as the
 * Active-Phase table (own-actor prefix → no write contention).
 *
 * Zero dependencies — node builtins only.
 */

const fragments = require('./fragments');

const PRESENCE_VIEW = 'presence';
const DEFAULT_IDLE = 600;     // seconds → "idle" after 10 min
const DEFAULT_OFFLINE = 3600; // seconds → "offline" after 1 hr

/** Refresh this actor's presence. `ctx` = { branch, lane, activity }. */
function heartbeat(repoRoot, actor, ctx, opts) {
  ctx = ctx || {};
  opts = opts || {};
  return fragments.writeFragment(repoRoot, PRESENCE_VIEW, actor, 'beat', {
    branch: ctx.branch || null,
    lane: ctx.lane || null,
    activity: ctx.activity || null,
    last_seen: opts.ts || new Date().toISOString(),
  }, opts);
}

/** Derive liveness from a presence fragment given `now` (ms epoch). */
function liveness(fragment, now, thresholds) {
  const idle = (thresholds && thresholds.idle) || DEFAULT_IDLE;
  const offline = (thresholds && thresholds.offline) || DEFAULT_OFFLINE;
  const seen = new Date(fragment.payload.last_seen || fragment.ts).getTime();
  const age = (now - seen) / 1000;
  if (age <= idle) return 'active';
  if (age <= offline) return 'idle';
  return 'offline';
}

/** Latest presence per actor + derived liveness, sorted by actor. */
function presence(repoRoot, now, thresholds) {
  const folded = fragments.foldLatest(
    fragments.readFragments(repoRoot, PRESENCE_VIEW),
    (f) => f.actor
  );
  return [...folded.values()]
    .map((f) => Object.assign({ actor: f.actor, liveness: liveness(f, now, thresholds) }, f.payload))
    .sort((a, b) => a.actor.localeCompare(b.actor));
}

module.exports = { heartbeat, liveness, presence, PRESENCE_VIEW, DEFAULT_IDLE, DEFAULT_OFFLINE };
