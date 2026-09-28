// Action intent → ProposedActionCard (LLD §4.7): catalogue lookup, codes resolved through the read model (the subject
// must exist and not be merged away), slots checked against controlled values, allowed roles, a pre-generated
// idempotency key and a 30-minute expiry. Placeholders stay in the payload here; the application refills them for the
// stream only. Pure.
import { ACTION_CATALOGUE } from './actionCatalogue.js';
import type { SubjectKind } from './actionCatalogue.js';

export interface ResolvedSubject {
  kind: SubjectKind;
  id: string;
  code: string;
  merged: boolean;
  /** Latest applied aggregate version (If-Match for PATCH targets), when known. */
  version: number | null;
}

export interface ProposedActionCard {
  kind: 'action';
  cardType: string;
  cardId: string;
  title: string;
  summary: string;
  targetService: string;
  targetOperation: string;
  method: 'POST' | 'PUT' | 'PATCH';
  path: string;
  payload: Record<string, unknown>;
  editableFields: string[];
  ifMatch: string | null;
  requiresConfirmation: true;
  allowedRoles: string[];
  idempotencyKey: string;
  expiresAt: string;
}

export type CardOutcome =
  | { ok: true; card: ProposedActionCard }
  | { ok: false; notice: 'not_allowed_for_role' | 'clarify'; text: string };

const PLACEHOLDER = /^⟨[A-Z]+_\d+⟩$/;
const CODE = /^[A-Z]{2,5}-\d{1,8}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Codes named in the slots (to resolve before building). */
export function codesOf(cardType: string, slots: Record<string, unknown>): string[] {
  const def = ACTION_CATALOGUE[cardType];
  if (!def) return [];
  return def.slots
    .filter((s) => s.type === 'code')
    .map((s) => slots[s.name])
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim().toUpperCase());
}

export function buildActionCard(
  cardType: string,
  slots: Record<string, string | number | boolean>,
  subjects: ReadonlyMap<string, ResolvedSubject | null>,
  ctx: { role: string; cardId: string; idempotencyKey: string; now: Date },
): CardOutcome {
  const def = ACTION_CATALOGUE[cardType];
  if (!def) return { ok: false, notice: 'clarify', text: 'I can’t propose that action. Try one of the quick actions (/queue, /add demand, /review, /dashboard).' };
  if (!def.roles.includes(ctx.role))
    return { ok: false, notice: 'not_allowed_for_role', text: `${def.title} isn’t available to the ${ctx.role} role.` };

  const payload: Record<string, unknown> = {};
  let path = def.path;
  let ifMatch: string | null = null;
  const summary: string[] = [];
  for (const s of def.slots) {
    const raw = slots[s.name];
    if (raw === undefined || raw === '') {
      if (s.required) return { ok: false, notice: 'clarify', text: `Which ${s.name.replace(/Code$/, '')} do you mean? Please give its code.` };
      continue;
    }
    let value: unknown = raw;
    switch (s.type) {
      case 'code': {
        const code = String(raw).trim().toUpperCase();
        if (!CODE.test(code)) return { ok: false, notice: 'clarify', text: `“${String(raw)}” is not a record code.` };
        const subject = subjects.get(code);
        if (!subject || (s.subject && subject.kind !== s.subject))
          return { ok: false, notice: 'clarify', text: `I couldn’t find ${code}.` };
        if (subject.merged) return { ok: false, notice: 'clarify', text: `${code} was merged into another record; open the surviving record instead.` };
        if (def.pathSlot === s.name) {
          path = path.replace('{idOrCode}', code);
          if (def.method === 'PATCH' && subject.version !== null) ifMatch = String(subject.version);
        }
        value = s.payloadKey && s.payloadKey.endsWith('Id') ? subject.id : code;
        summary.push(code);
        break;
      }
      case 'enum': {
        const hit = s.values?.find((v) => v.toLowerCase() === String(raw).toLowerCase());
        if (!hit) return { ok: false, notice: 'clarify', text: `${s.name} must be one of ${s.values?.join(', ')}.` };
        value = hit;
        summary.push(`${s.name} ${hit}`);
        break;
      }
      case 'number': {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) return { ok: false, notice: 'clarify', text: `${s.name} must be a number.` };
        value = n;
        break;
      }
      case 'uuid':
        if (typeof raw !== 'string' || !UUID.test(raw)) return { ok: false, notice: 'clarify', text: `${s.name} must be an id.` };
        if (def.pathSlot === s.name) path = path.replace('{id}', raw);
        break;
      case 'phone':
        // Only a redaction placeholder is accepted: the real number is refilled in the stream, never stored.
        if (typeof raw !== 'string' || !PLACEHOLDER.test(raw)) continue;
        break;
      case 'date':
        if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) continue;
        break;
      case 'datetime':
        if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) continue;
        break;
      default:
        if (typeof raw !== 'string' || raw.length > 120) continue;
    }
    if (s.payloadKey !== null) payload[s.payloadKey ?? s.name] = value;
  }
  if (path.includes('{')) return { ok: false, notice: 'clarify', text: 'Which record do you mean? Please give its code.' };
  return {
    ok: true,
    card: {
      kind: 'action',
      cardType: def.cardType,
      cardId: ctx.cardId,
      title: def.title,
      summary: `${def.title}${summary.length ? `: ${summary.join(', ')}` : ''}. Nothing changes until you confirm.`,
      targetService: def.targetService,
      targetOperation: def.targetOperation,
      method: def.method,
      path,
      payload,
      editableFields: [...def.editable],
      ifMatch,
      requiresConfirmation: true,
      allowedRoles: [...def.roles],
      idempotencyKey: ctx.idempotencyKey,
      expiresAt: new Date(ctx.now.getTime() + 30 * 60_000).toISOString(),
    },
  };
}
