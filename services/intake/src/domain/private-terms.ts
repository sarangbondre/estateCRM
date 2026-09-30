// CR-012: building_name and floor are private (never public) and must not reach the model. They are never sent as
// fields; this masks their values inside the classifier text before the redactor runs. The masks use the redactor's
// UNIT placeholder form, so @11e/redaction leaves them alone and numbers its own UNIT placeholders after them.

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Word-bounded, case-insensitive, whitespace-tolerant pattern of a literal value. */
function literal(value: string): string {
  return value
    .trim()
    .split(/\s+/u)
    .map(escape)
    .join('\\s+');
}

const ORDINAL = '(?:st|nd|rd|th)?';
const FLOOR_WORD = '(?:floor|flr\\.?|fl\\.?)';

/**
 * Replaces the row's building name (any mention, ≥ 3 characters) and floor (as "12th floor", "floor 12", or the
 * whole value when it is not a bare short number such as "12 of 20") with `[UNIT_n]` placeholders.
 */
export function maskPrivateTerms(
  text: string,
  terms: { buildingName?: unknown; floor?: unknown },
): string {
  let out = text;
  let n = 0;
  const mask = (pattern: string) => {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, 'giu');
    if (!re.test(out)) return;
    n += 1;
    out = out.replace(re, `[UNIT_${n}]`);
  };
  const building = typeof terms.buildingName === 'string' ? terms.buildingName.trim() : '';
  if (building.length >= 3) mask(literal(building));
  const floor = typeof terms.floor === 'string' ? terms.floor.trim() : '';
  if (floor) {
    const f = literal(floor);
    mask(`${f}\\s*${ORDINAL}\\s*${FLOOR_WORD}|${FLOOR_WORD}\\s*(?:no\\.?\\s*)?${f}${ORDINAL}`);
    if (!/^\d{1,3}$/.test(floor) && floor.length >= 3) mask(f);
  }
  return out;
}
