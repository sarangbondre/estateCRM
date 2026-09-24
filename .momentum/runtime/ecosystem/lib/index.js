'use strict';

/**
 * Ecosystem helpers — pure, dependency-free.
 *
 * Provides four building blocks the rest of Phase 9 depends on:
 *
 *   - findRoot(startPath)        — locate the ecosystem root by walking up
 *   - loadManifest(rootPath)     — read + parse ecosystem.json
 *   - listMembers(manifest)      — convenience accessor
 *   - validateManifest(obj)      — minimal schema check (no external deps)
 *
 * Schema validation is deliberately hand-rolled: momentum has a
 * zero-dependency posture for the CLI (no ajv, no joi). The check
 * is structural — type + required fields — and surfaces the first
 * violation with a human-readable path. The full JSON Schema in
 * `../schema/ecosystem.schema.json` remains the authoritative
 * contract; this validator is its operational counterpart.
 */

const fs = require('fs');
const path = require('path');

// Default upper bound on parent-directory walk-up. Honored by both this
// module's findRoot and core/ecosystem/scripts/session-append.sh. The
// authoritative export lives in core/ecosystem/lib/state.js as of
// Phase 10 (ENH-022); we keep MAX_WALK_DEPTH as a backward-compat alias.
const MAX_PARENT_WALK_DEFAULT = 5;
const MAX_WALK_DEPTH = MAX_PARENT_WALK_DEFAULT;
const MANIFEST_FILENAME = 'ecosystem.json';

function resolveMaxParentWalk() {
  const raw = process.env.MOMENTUM_MAX_PARENT_WALK;
  if (raw === undefined || raw === '') return MAX_PARENT_WALK_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return MAX_PARENT_WALK_DEFAULT;
  return Math.floor(n);
}

// Per-process cache: absolute-startPath-prefix → resolved root (or null)
const rootCache = new Map();

/**
 * Walk up from `startPath` looking for a directory containing
 * `ecosystem.json`. Returns the absolute root path or null.
 * Bounded to `resolveMaxParentWalk()` parents (default 5, override via
 * the `MOMENTUM_MAX_PARENT_WALK` env var) so a misconfigured caller
 * can't scan the entire filesystem.
 *
 * Memoized: repeated calls with paths under the same root return
 * instantly. Cache key is the absolute starting path.
 */
/** True when `dir/ecosystem.json` exists and is a file. */
function hasManifest(dir) {
  try {
    return fs.statSync(path.join(dir, MANIFEST_FILENAME)).isFile();
  } catch (_err) {
    return false;
  }
}

/**
 * THE ecosystem-root resolver (ADR-0018 R3).
 *
 * Three strategies, in order:
 *   1. **up-walk** — `ecosystem.json` in this dir or an ancestor
 *   2. **sibling scan** at each level — `core/ecosystem/layout.md` documents the
 *      ecosystem root as a SIBLING of its members, which is exactly what
 *      `ecosystem init` + `ecosystem add ../repo` produce
 *   3. **registration lookup** — the per-machine registry, for members whose
 *      root is neither an ancestor nor a sibling
 *
 * Before Phase 31c this function did step 1 ONLY, while six other call sites
 * each hand-rolled step 2 and the two CLIs bolted on step 3. Every ad-hoc copy
 * encoded the documented layout; the sanctioned API contradicted it. The cost
 * was **BUG-030**: `landing.js` had no fallback, so in the standard sibling
 * layout `momentum lanes land` silently skipped the entire cross-repo gate and
 * v0.41.0 shipped ENH-068 non-functional.
 *
 * Bounded by `MOMENTUM_MAX_PARENT_WALK` (default 5) and memoised per absolute
 * start path.
 */
function findRoot(startPath) {
  if (typeof startPath !== 'string' || startPath.length === 0) {
    return null;
  }
  const abs = path.resolve(startPath);
  if (rootCache.has(abs)) {
    return rootCache.get(abs);
  }

  const remember = (val) => { rootCache.set(abs, val); return val; };
  const maxDepth = resolveMaxParentWalk();
  let current = abs;

  for (let i = 0; i <= maxDepth; i++) {
    // 1. this directory
    if (hasManifest(current)) return remember(current);

    const parent = path.dirname(current);
    if (parent === current) break; // filesystem root

    // 2. siblings of this directory
    let siblings = [];
    try {
      siblings = fs.readdirSync(parent, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(parent, e.name));
    } catch (_err) {
      siblings = []; // unreadable parent — keep walking
    }
    for (const sib of siblings) {
      if (sib !== current && hasManifest(sib)) return remember(sib);
    }

    current = parent;
  }

  // 3. registration fallback — required lazily to avoid a module cycle
  // (state.js reads the manifest through this module).
  try {
    const reg = require('./state').findRegistration(abs);
    if (reg && reg.rootPath && hasManifest(reg.rootPath)) {
      return remember(reg.rootPath);
    }
  } catch (_err) { /* registry absent or unreadable — fall through */ }

  return remember(null);
}

/**
 * Read + parse the manifest at `rootPath/ecosystem.json`.
 * Throws on missing file or invalid JSON; caller decides recovery.
 */
function loadManifest(rootPath) {
  if (typeof rootPath !== 'string' || rootPath.length === 0) {
    throw new TypeError('loadManifest: rootPath must be a non-empty string');
  }
  const file = path.join(rootPath, MANIFEST_FILENAME);
  const raw = fs.readFileSync(file, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SyntaxError(`Invalid JSON in ${file}: ${err.message}`);
  }
  return parsed;
}

/**
 * Returns the members array, defaulting to [] if absent.
 * Does not validate; assumes caller already passed validateManifest.
 */
function listMembers(manifest) {
  if (!manifest || typeof manifest !== 'object') return [];
  return Array.isArray(manifest.members) ? manifest.members : [];
}

/**
 * Find a member by id. Returns the member object or null.
 */
function findMember(manifest, id) {
  return listMembers(manifest).find((m) => m && m.id === id) || null;
}

/**
 * Resolve where a member lives (ADR-0015 remote-URL members). A member may be
 * co-located (`path`), remote-only (`remote` git URL), or both. Returns:
 *   {
 *     id, role, remote,
 *     localPath   — absolute path if `path` is set, else null,
 *     hasLocal    — whether a local checkout exists on THIS machine,
 *     kind        — 'local' | 'remote' | 'local+remote'
 *   }
 * `hasLocal` is a filesystem check; a remote-only member (or a co-located one
 * a teammate hasn't checked out) resolves with hasLocal:false, so `ecosystem
 * status` can still render it from its URL. Pure over the manifest + fs.
 */
function resolveMemberLocation(rootPath, member) {
  const remote = typeof member.remote === 'string' && member.remote.length > 0 ? member.remote : null;
  const relPath = typeof member.path === 'string' && member.path.length > 0 ? member.path : null;
  const localPath = relPath ? path.resolve(rootPath, relPath) : null;
  let hasLocal = false;
  if (localPath) {
    try { hasLocal = fs.existsSync(localPath); } catch (_e) { hasLocal = false; }
  }
  const kind = relPath && remote ? 'local+remote' : remote ? 'remote' : 'local';
  return {
    id: member.id,
    role: member.role,
    path: relPath,
    remote,
    localPath,
    hasLocal,
    kind,
  };
}

/**
 * Hand-rolled structural validation. Returns
 *   { ok: true } on success
 *   { ok: false, errors: [{ path, message }] } on failure.
 *
 * Catches every issue (does not bail on first); the caller can render
 * a useful error report. Authoritative schema is
 * `core/ecosystem/schema/ecosystem.schema.json` — keep them in sync.
 */
function validateManifest(obj) {
  const errors = [];
  const slug = /^[a-z][a-z0-9-]*$/;

  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: [{ path: '$', message: 'manifest must be a JSON object' }] };
  }

  // name
  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    errors.push({ path: '$.name', message: 'required non-empty string' });
  } else if (!slug.test(obj.name)) {
    errors.push({ path: '$.name', message: 'must match /^[a-z][a-z0-9-]*$/' });
  } else if (obj.name.length > 64) {
    errors.push({ path: '$.name', message: 'must be at most 64 chars' });
  }

  // version
  if (obj.version !== 1) {
    errors.push({ path: '$.version', message: 'must be the integer 1 (no other schema version supported)' });
  }

  // created — optional, must be a valid ISO date if present
  if (obj.created !== undefined) {
    if (typeof obj.created !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(obj.created)) {
      errors.push({ path: '$.created', message: 'must be an ISO-8601 date (YYYY-MM-DD)' });
    }
  }

  // members
  if (!Array.isArray(obj.members)) {
    errors.push({ path: '$.members', message: 'required array' });
  } else {
    const seenIds = new Set();
    obj.members.forEach((m, i) => {
      const base = `$.members[${i}]`;
      if (m === null || typeof m !== 'object' || Array.isArray(m)) {
        errors.push({ path: base, message: 'must be an object' });
        return;
      }
      if (typeof m.id !== 'string' || m.id.length === 0) {
        errors.push({ path: `${base}.id`, message: 'required non-empty string' });
      } else {
        if (!slug.test(m.id)) errors.push({ path: `${base}.id`, message: 'must match slug pattern' });
        if (m.id.length > 64) errors.push({ path: `${base}.id`, message: 'must be at most 64 chars' });
        if (seenIds.has(m.id)) errors.push({ path: `${base}.id`, message: `duplicate member id "${m.id}"` });
        seenIds.add(m.id);
      }
      // A member needs at least one of `path` (co-located on disk) or `remote`
      // (a git URL) — ADR-0015. Both may be present. This lets a distributed
      // team share one ecosystem without identical folder layouts.
      const hasPath = typeof m.path === 'string' && m.path.length > 0;
      const hasRemote = typeof m.remote === 'string' && m.remote.length > 0;
      if (!hasPath && !hasRemote) {
        errors.push({ path: base, message: 'must have at least one of `path` or `remote`' });
      }
      if (m.path !== undefined && (typeof m.path !== 'string' || m.path.length === 0)) {
        errors.push({ path: `${base}.path`, message: 'must be a non-empty string when present' });
      }
      if (m.remote !== undefined && (typeof m.remote !== 'string' || m.remote.length === 0)) {
        errors.push({ path: `${base}.remote`, message: 'must be a non-empty git URL string when present' });
      }
      const validRoles = ['platform', 'client', 'library', 'infra', 'bench', 'other'];
      if (!validRoles.includes(m.role)) {
        errors.push({ path: `${base}.role`, message: `must be one of: ${validRoles.join(', ')}` });
      }
      if (m.owns !== undefined && !isArrayOfStrings(m.owns)) {
        errors.push({ path: `${base}.owns`, message: 'must be array of strings' });
      }
      if (m.consumes !== undefined && !isArrayOfStrings(m.consumes)) {
        errors.push({ path: `${base}.consumes`, message: 'must be array of strings' });
      }
    });
  }

  // dependencies — optional
  if (obj.dependencies !== undefined) {
    if (!Array.isArray(obj.dependencies)) {
      errors.push({ path: '$.dependencies', message: 'must be array if present' });
    } else {
      const memberIds = new Set(
        Array.isArray(obj.members) ? obj.members.map((m) => m && m.id).filter(Boolean) : [],
      );
      const validKinds = ['api-contract', 'library', 'deploy', 'build-time', 'other'];
      obj.dependencies.forEach((d, i) => {
        const base = `$.dependencies[${i}]`;
        if (d === null || typeof d !== 'object' || Array.isArray(d)) {
          errors.push({ path: base, message: 'must be an object' });
          return;
        }
        if (typeof d.from !== 'string' || !memberIds.has(d.from)) {
          errors.push({ path: `${base}.from`, message: 'must reference a known member id' });
        }
        if (typeof d.to !== 'string' || !memberIds.has(d.to)) {
          errors.push({ path: `${base}.to`, message: 'must reference a known member id' });
        }
        if (!validKinds.includes(d.kind)) {
          errors.push({ path: `${base}.kind`, message: `must be one of: ${validKinds.join(', ')}` });
        }
        // `initiative` records which initiative discovered this edge (ADR-0016).
        // Optional — a hand-declared edge has none.
        if (d.initiative !== undefined
          && (typeof d.initiative !== 'string' || !slug.test(d.initiative))) {
          errors.push({ path: `${base}.initiative`, message: 'must be a slug when present' });
        }
      });
    }
  }

  // config — optional, ecosystem-level mechanisms (ADR-0016).
  // The coordination root has no `specs/`, so `specs/config.md` is unavailable
  // here; ecosystem-tier settings live in this object instead.
  if (obj.config !== undefined) {
    if (obj.config === null || typeof obj.config !== 'object' || Array.isArray(obj.config)) {
      errors.push({ path: '$.config', message: 'must be an object if present' });
    } else {
      const known = ['integration_verify_command', 'detect_window_hours', 'landing_order'];
      for (const key of Object.keys(obj.config)) {
        if (!known.includes(key)) {
          errors.push({ path: `$.config.${key}`, message: `unknown key (known: ${known.join(', ')})` });
        }
      }
      if (obj.config.integration_verify_command !== undefined
        && (typeof obj.config.integration_verify_command !== 'string'
          || obj.config.integration_verify_command.length === 0)) {
        errors.push({
          path: '$.config.integration_verify_command',
          message: 'must be a non-empty string when present',
        });
      }
      // Phase 31b (ADR-0017): detection window + landing-order strictness.
      if (obj.config.detect_window_hours !== undefined) {
        const n = obj.config.detect_window_hours;
        if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
          errors.push({
            path: '$.config.detect_window_hours',
            message: 'must be a positive number when present',
          });
        }
      }
      if (obj.config.landing_order !== undefined) {
        const modes = ['enforce', 'warn', 'off'];
        if (!modes.includes(obj.config.landing_order)) {
          errors.push({
            path: '$.config.landing_order',
            message: `must be one of: ${modes.join(', ')}`,
          });
        }
      }
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Read the ecosystem-level config object (ADR-0016), with every known key
 * resolved. Returns an object with `integration_verify_command: string|null`.
 *
 * Deliberately mirrors `core/config.js`'s posture: absent config is a valid
 * state that callers must handle explicitly, never a silent default that
 * fabricates a verification the project never declared.
 */
function readEcosystemConfig(manifest) {
  const cfg = (manifest && typeof manifest.config === 'object' && !Array.isArray(manifest.config))
    ? manifest.config
    : {};
  const cmd = cfg.integration_verify_command;
  const win = typeof cfg.detect_window_hours === 'number' && cfg.detect_window_hours > 0
    ? cfg.detect_window_hours
    : null;
  const order = ['enforce', 'warn', 'off'].includes(cfg.landing_order)
    ? cfg.landing_order
    : 'enforce';
  return {
    integration_verify_command: (typeof cmd === 'string' && cmd.length > 0) ? cmd : null,
    // null (not a number) when undeclared, so callers can distinguish
    // "declared as 24" from "defaulted to 24" — the same reason
    // integration_verify_command returns null rather than a fabricated command.
    detect_window_hours: win,
    // `enforce` is the DEFAULT rather than a null: unlike a verification command
    // momentum cannot invent, the landing order is fully derivable from edges
    // momentum registered itself. Defaulting to off would silently disable a
    // gate the project never opted out of.
    landing_order: order,
  };
}

function isArrayOfStrings(v) {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

/**
 * Clear the findRoot memo cache. Tests use this; production code
 * doesn't need to.
 */
function _clearRootCache() {
  rootCache.clear();
}

module.exports = {
  MAX_WALK_DEPTH,
  MAX_PARENT_WALK_DEFAULT,
  MANIFEST_FILENAME,
  resolveMaxParentWalk,
  findRoot,
  loadManifest,
  listMembers,
  findMember,
  resolveMemberLocation,
  validateManifest,
  readEcosystemConfig,
  _clearRootCache,
};
