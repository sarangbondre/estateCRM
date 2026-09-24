'use strict';

/**
 * Ecosystem-level team state as per-actor fragments (Phase 30e G2, ADR-0015).
 *
 * The ecosystem coordination root is itself a git repo, so the single-repo
 * Team-mode keystone applies directly: ecosystem-team state travels via
 * per-actor append-only fragments committed under the ecosystem repo's
 * `.momentum/team/` (reusing `core/team/lib/fragments`) + `refs/momentum/*`.
 *
 * Two pieces move off per-machine `.state/` onto the shared fragment substrate:
 *
 *   - active-initiative — was `.state/active-initiative` (per-machine, one
 *     value). Now a per-actor fragment; the compiled value is global
 *     last-writer-wins across all actors (it's one shared ecosystem value),
 *     attributed to who set it. Conflict-free by construction — an actor only
 *     writes files under its own `<actor>-` prefix, so N clones never collide.
 *
 *   - session-presence — reuses `core/team/lib/presence` directly against the
 *     ecosystem root (heartbeat-on-invocation, liveness derived from age).
 *
 * The legacy `.state/active-initiative` file is kept in sync as a per-machine
 * cache (offline reads + back-compat with any reader that predates 30e).
 *
 * Zero dependencies — node builtins + sibling libs only.
 */

const fragments = require('../../team/lib/fragments');
const presence = require('../../team/lib/presence');
const initiativeLib = require('./initiative');

const ACTIVE_VIEW = 'eco-active-initiative';

/**
 * Set the active initiative for the ecosystem as a per-actor fragment.
 * `slug` null/'' clears it. Also refreshes the legacy `.state/` cache so
 * offline / pre-30e readers stay correct. `opts.ts` / `opts.seq` injectable
 * for tests. Returns the written fragment.
 */
function setActiveInitiative(ecosystemRoot, actor, slug, opts) {
  const value = slug == null ? '' : String(slug);
  const frag = fragments.writeFragment(ecosystemRoot, ACTIVE_VIEW, actor, 'set', { slug: value }, opts);
  // Per-machine cache (gitignored .state/) — best-effort, never fail the set on it.
  try { initiativeLib.setActive(ecosystemRoot, value); } catch (_e) { /* cache only */ }
  return frag;
}

/**
 * The most-recent active-initiative fragment across ALL actors (global
 * last-writer-wins — active-initiative is one shared value). readFragments is
 * stable-sorted by (ts, actor, seq), so the last element is the latest set.
 * Returns the fragment or null when none exist.
 */
function activeInitiativeFragment(ecosystemRoot) {
  const frags = fragments.readFragments(ecosystemRoot, ACTIVE_VIEW);
  return frags.length ? frags[frags.length - 1] : null;
}

/**
 * Resolve the active initiative to `{ slug, actor, ts }` or null.
 * Prefers the shared fragment view; a cleared (empty-slug) latest returns null.
 * Falls back to the legacy per-machine `.state/active-initiative` only when no
 * fragments exist at all (fresh clone with an old-style state file).
 */
function getActiveInitiative(ecosystemRoot) {
  const latest = activeInitiativeFragment(ecosystemRoot);
  if (latest) {
    const slug = latest.payload && latest.payload.slug ? String(latest.payload.slug) : '';
    if (!slug) return null; // explicitly cleared
    return { slug, actor: latest.actor, ts: latest.ts, source: 'fragment' };
  }
  const legacy = initiativeLib.getActive(ecosystemRoot);
  return legacy ? { slug: legacy, actor: null, ts: null, source: 'legacy' } : null;
}

/** Refresh this actor's ecosystem-level presence (reuses the presence lib). */
function heartbeat(ecosystemRoot, actor, ctx, opts) {
  return presence.heartbeat(ecosystemRoot, actor, ctx, opts);
}

/** Latest presence per actor + derived liveness, at the ecosystem root. */
function listPresence(ecosystemRoot, now, thresholds) {
  return presence.presence(ecosystemRoot, now, thresholds);
}

module.exports = {
  ACTIVE_VIEW,
  setActiveInitiative,
  activeInitiativeFragment,
  getActiveInitiative,
  heartbeat,
  listPresence,
};
