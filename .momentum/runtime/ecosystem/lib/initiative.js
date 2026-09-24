'use strict';

/**
 * Initiative helpers — pure, dependency-free.
 *
 * An initiative is one markdown file under
 * `<ecosystem-root>/initiatives/NNNN-<slug>.md` with a YAML frontmatter
 * block validated against `../schema/initiative.schema.json`. Body is
 * free-form markdown using the fixed sections from
 * `../templates/initiative-template.md`.
 *
 * Numbering is monotonically increasing across the ecosystem. The
 * filename slug is for human readability; the `id` integer is canonical.
 */

const fs = require('fs');
const path = require('path');

const INITIATIVES_DIR = 'initiatives';
const STATE_DIR = '.state';
const ACTIVE_FILE = 'active-initiative';

const FRONTMATTER_FENCE = '---';

// ─────────────────────────────────────────────────────────────────────────────
// Frontmatter parse / serialize (single-level YAML only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal YAML reader: supports scalar key:value lines (string / integer)
 * and inline arrays like `repos: [a, b, c]`. Quotes optional on scalars.
 * Anything more complex (nested, multi-line) is not used by initiatives
 * today — keep this strict and dependency-free.
 */
function parseFrontmatter(body) {
  if (typeof body !== 'string') return { frontmatter: null, content: body };
  const trimmed = body.replace(/^﻿/, '');
  if (!trimmed.startsWith(FRONTMATTER_FENCE)) {
    return { frontmatter: null, content: body };
  }
  const lines = trimmed.split('\n');
  // Find the closing fence after the first.
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === FRONTMATTER_FENCE) { end = i; break; }
  }
  if (end === -1) return { frontmatter: null, content: body };
  const fmLines = lines.slice(1, end);
  const fm = {};
  for (const raw of fmLines) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      // Inline array
      const inner = value.slice(1, -1).trim();
      fm[key] = inner.length === 0
        ? []
        : inner.split(',').map((s) => stripQuotes(s.trim())).filter(Boolean);
    } else if (/^-?\d+$/.test(value)) {
      fm[key] = parseInt(value, 10);
    } else {
      fm[key] = stripQuotes(value);
    }
  }
  const content = lines.slice(end + 1).join('\n').replace(/^\n+/, '');
  return { frontmatter: fm, content };
}

function stripQuotes(s) {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

function serializeFrontmatter(fm) {
  const lines = [FRONTMATTER_FENCE];
  for (const key of Object.keys(fm)) {
    const value = fm[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => formatScalar(v)).join(', ')}]`);
    } else {
      lines.push(`${key}: ${formatScalar(value)}`);
    }
  }
  lines.push(FRONTMATTER_FENCE);
  return lines.join('\n') + '\n';
}

function formatScalar(v) {
  if (typeof v === 'number') return String(v);
  const s = String(v);
  // Quote when ambiguous: contains characters that would re-parse oddly.
  if (s.length === 0) return '""';
  if (/[#:,\[\]]/.test(s) || /^\s|\s$/.test(s) || /^-?\d+$/.test(s)) {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

const VALID_STATUSES = ['in-progress', 'closed', 'abandoned'];

// Per-member contribution records (ADR-0016). `kind` mirrors momentum's work
// types (Rule 14): a member contributes either a full phase or an ad-hoc record.
// Stored as flat `member:kind:ref` strings so they round-trip through the
// strict, dependency-free frontmatter serializer above (which flattens arrays
// via String(v) and therefore cannot carry nested objects).
const VALID_CONTRIBUTION_KINDS = ['phase', 'adhoc'];
const CONTRIBUTION_RE = new RegExp(
  `^[a-z][a-z0-9-]*:(?:${VALID_CONTRIBUTION_KINDS.join('|')}):[A-Za-z0-9._-]+$`,
);

/**
 * Validates an initiative frontmatter object against the schema.
 * Returns { ok: true } or { ok: false, errors: [{ path, message }] }.
 */
function validateFrontmatter(fm) {
  const errors = [];
  const slug = /^[a-z][a-z0-9-]*$/;
  const date = /^\d{4}-\d{2}-\d{2}$/;

  if (fm === null || typeof fm !== 'object' || Array.isArray(fm)) {
    return { ok: false, errors: [{ path: '$', message: 'frontmatter must be an object' }] };
  }
  if (!Number.isInteger(fm.id) || fm.id < 1) {
    errors.push({ path: '$.id', message: 'must be a positive integer' });
  }
  if (typeof fm.slug !== 'string' || !slug.test(fm.slug)) {
    errors.push({ path: '$.slug', message: 'must match /^[a-z][a-z0-9-]*$/' });
  }
  if (typeof fm.status !== 'string' || !VALID_STATUSES.includes(fm.status)) {
    errors.push({ path: '$.status', message: `must be one of: ${VALID_STATUSES.join(', ')}` });
  }
  if (typeof fm.started !== 'string' || !date.test(fm.started)) {
    errors.push({ path: '$.started', message: 'must be ISO-8601 date YYYY-MM-DD' });
  }
  if (fm.status === 'closed') {
    if (typeof fm.closed !== 'string' || !date.test(fm.closed)) {
      errors.push({ path: '$.closed', message: 'required when status=closed' });
    }
  }
  if (typeof fm.owner !== 'string' || fm.owner.length === 0) {
    errors.push({ path: '$.owner', message: 'required non-empty string' });
  }
  if (!Array.isArray(fm.repos) || fm.repos.length === 0 || !fm.repos.every((s) => typeof s === 'string')) {
    errors.push({ path: '$.repos', message: 'required non-empty array of strings' });
  }
  // contributions — optional and additive (ADR-0016). Initiatives written
  // before Phase 31a have none and must keep validating unchanged.
  if (fm.contributions !== undefined) {
    if (!Array.isArray(fm.contributions)) {
      errors.push({ path: '$.contributions', message: 'must be an array if present' });
    } else {
      fm.contributions.forEach((c, i) => {
        if (typeof c !== 'string' || !CONTRIBUTION_RE.test(c)) {
          errors.push({
            path: `$.contributions[${i}]`,
            message: 'must be "member:kind:ref" with kind one of: '
              + `${VALID_CONTRIBUTION_KINDS.join(', ')}`,
          });
        }
      });
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Parse a `member:kind:ref` contribution triple into its parts.
 * Returns null when the string is malformed.
 *
 * Note there is deliberately no `status` or `evidence` here: a contribution's
 * completion state is resolved LIVE from the member's own record at completion
 * time (Rule 12). A status the agent previously wrote into the initiative is
 * self-reported completion, which is exactly what Rule 12 exists to reject.
 */
function parseContribution(entry) {
  if (typeof entry !== 'string' || !CONTRIBUTION_RE.test(entry)) return null;
  const [member, kind, ref] = entry.split(':');
  return { member, kind, ref };
}

/**
 * Build a `member:kind:ref` triple. Throws on invalid input rather than
 * emitting a malformed entry that would fail validation later.
 */
function formatContribution({ member, kind, ref }) {
  const entry = `${member}:${kind}:${ref}`;
  if (!CONTRIBUTION_RE.test(entry)) {
    throw new TypeError(`formatContribution: invalid contribution ${JSON.stringify(entry)}`);
  }
  return entry;
}

// ─────────────────────────────────────────────────────────────────────────────
// File operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Discover the next available initiative id by scanning filenames in
 * <ecosystem-root>/initiatives/. Pure function over directory contents.
 */
function nextInitiativeId(ecosystemRoot) {
  const dir = path.join(ecosystemRoot, INITIATIVES_DIR);
  if (!fs.existsSync(dir)) return 1;
  const entries = fs.readdirSync(dir);
  let max = 0;
  for (const name of entries) {
    const m = name.match(/^(\d{4})-[a-z][a-z0-9-]*\.md$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return max + 1;
}

function initiativeFilename(id, slug) {
  const padded = String(id).padStart(4, '0');
  return `${padded}-${slug}.md`;
}

function initiativePath(ecosystemRoot, id, slug) {
  return path.join(ecosystemRoot, INITIATIVES_DIR, initiativeFilename(id, slug));
}

/**
 * Read + parse an initiative by slug. Searches by filename suffix.
 * Returns { frontmatter, content, filePath } or null if not found.
 */
function loadInitiative(ecosystemRoot, slug) {
  const dir = path.join(ecosystemRoot, INITIATIVES_DIR);
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir);
  const match = entries.find((name) => name.endsWith(`-${slug}.md`));
  if (!match) return null;
  const filePath = path.join(dir, match);
  const raw = fs.readFileSync(filePath, 'utf8');
  const { frontmatter, content } = parseFrontmatter(raw);
  return { frontmatter, content, filePath };
}

/**
 * Write an initiative file. Caller passes already-validated frontmatter
 * + content. The fenced YAML block is regenerated; content is preserved
 * verbatim below the closing fence.
 */
function writeInitiative(filePath, frontmatter, content) {
  const v = validateFrontmatter(frontmatter);
  if (!v.ok) {
    throw new Error(
      `writeInitiative: frontmatter validation failed:\n` +
      v.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n'),
    );
  }
  const fm = serializeFrontmatter(frontmatter);
  const body = content == null ? '' : content;
  fs.writeFileSync(filePath, fm + body, 'utf8');
}

/**
 * Set the active initiative for the ecosystem. Empty string clears.
 */
function setActive(ecosystemRoot, slug) {
  fs.mkdirSync(path.join(ecosystemRoot, STATE_DIR), { recursive: true });
  fs.writeFileSync(
    path.join(ecosystemRoot, STATE_DIR, ACTIVE_FILE),
    slug == null ? '' : String(slug),
    'utf8',
  );
}

function getActive(ecosystemRoot) {
  const file = path.join(ecosystemRoot, STATE_DIR, ACTIVE_FILE);
  if (!fs.existsSync(file)) return null;
  const s = fs.readFileSync(file, 'utf8').trim();
  return s || null;
}

function clearActive(ecosystemRoot) {
  setActive(ecosystemRoot, '');
}

module.exports = {
  INITIATIVES_DIR,
  STATE_DIR,
  ACTIVE_FILE,
  parseFrontmatter,
  serializeFrontmatter,
  validateFrontmatter,
  VALID_CONTRIBUTION_KINDS,
  parseContribution,
  formatContribution,
  nextInitiativeId,
  initiativeFilename,
  initiativePath,
  loadInitiative,
  writeInitiative,
  setActive,
  getActive,
  clearActive,
};
