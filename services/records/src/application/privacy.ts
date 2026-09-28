// Contact privacy (REC-08, R-VIS-3, NFR-13, R-20, R-21): audited reveals (60/hour/user), the contacts batch for
// insight exports, and salted scan terms for listings. PII leaves only in these responses and never in events/logs.
import { RecordsError, notFound } from '../domain/errors.js';
import { buildingTokens, unitTokens } from '../domain/privacy.js';
import { emitAudit } from './audit.js';
import type { Actor, App } from './context.js';
import type { Tx } from './ports.js';

export const REVEALS_PER_HOUR = 60;
export type RevealSubject = 'person' | 'property' | 'source_ad' | 'enquiry';

export interface RevealFields {
  name?: string | null;
  phones?: string[];
  whatsappPhone?: string | null;
  emails?: string[];
  otherContact?: string | null;
  wing?: string | null;
  unitNo?: string | null;
  floorNo?: number | null;
  rawText?: string | null;
  textVariants?: string | null;
  senderName?: string | null;
  senderPhone?: string | null;
  message?: string | null;
}

/** The revealable fields of one subject (no audit); `applicable` is false when there is nothing to reveal. */
export async function revealableFields(tx: Tx, subjectType: RevealSubject, subjectId: string): Promise<{ fields: RevealFields; applicable: boolean }> {
  switch (subjectType) {
    case 'person': {
      const p = await tx.store.get('persons', subjectId);
      if (!p) throw notFound('person');
      if (p.purged_at) return { fields: { name: null, phones: [], whatsappPhone: null, emails: [], otherContact: null }, applicable: true };
      const [phones, emails] = await Promise.all([
        tx.store.find('person_phones', { person_id: p.id }, { limit: 20, orderBy: [{ column: 'is_primary', direction: 'desc' }, { column: 'created_at' }] }),
        tx.store.find('person_emails', { person_id: p.id }, { limit: 20 }),
      ]);
      const fields = {
        name: p.name,
        phones: phones.filter((x) => x.kind === 'phone').map((x) => x.phone_e164),
        whatsappPhone: phones.find((x) => x.kind === 'whatsapp')?.phone_e164 ?? null,
        emails: emails.map((e) => e.email),
        otherContact: p.other_contact,
      };
      return { fields, applicable: !!(fields.name || fields.phones.length || fields.whatsappPhone || fields.emails.length || fields.otherContact) };
    }
    case 'property': {
      const p = await tx.store.get('properties', subjectId);
      if (!p) throw notFound('property');
      const fields = { wing: p.wing, unitNo: p.unit_no, floorNo: p.floor_no };
      return { fields, applicable: fields.wing !== null || fields.unitNo !== null || fields.floorNo !== null };
    }
    case 'source_ad': {
      const a = await tx.store.get('source_ads', subjectId);
      if (!a) throw notFound('source ad');
      const fields = { rawText: a.raw_text, textVariants: a.text_variants, senderName: a.sender_name, senderPhone: a.sender_phone };
      return { fields, applicable: !!a.purged_at || Object.values(fields).some((v) => v !== null) };
    }
    case 'enquiry': {
      const e = await tx.store.get('enquiries', subjectId);
      if (!e) throw notFound('enquiry');
      return { fields: { message: e.message }, applicable: e.message !== null };
    }
  }
}

const presentFieldNames = (f: RevealFields) =>
  Object.entries(f)
    .filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0))
    .map(([k]) => k)
    .sort();

/**
 * POST /v1/reveals: writes the audit (field names only) in the same transaction as the reveal log; 429 above
 * 60 reveals per user and hour.
 */
export async function revealContact(
  app: App,
  actor: Actor,
  input: { subjectType: RevealSubject; subjectId: string; purpose: string; via?: 'ui' | 'chat' | undefined },
): Promise<{ auditId: string; fields: RevealFields }> {
  return app.uow.run(actor, async (tx) => {
    await tx.advisoryLock(`reveal:${actor.userId}`);
    const hourAgo = new Date(tx.now.getTime() - 60 * 60 * 1000);
    const recent = await tx.store.find('reveal_log', { user_id: actor.userId }, { limit: REVEALS_PER_HOUR + 1, orderBy: [{ column: 'created_at', direction: 'desc' }] });
    const inWindow = recent.filter((r) => r.created_at > hourAgo);
    if (inWindow.length >= REVEALS_PER_HOUR) {
      const oldest = inWindow.at(-1)?.created_at ?? tx.now;
      const retry = Math.max(1, Math.ceil((oldest.getTime() + 60 * 60 * 1000 - tx.now.getTime()) / 1000));
      throw new RecordsError('rate-limited', 'reveal limit reached (60 per hour)', { headers: { 'retry-after': String(retry) } });
    }
    const { fields, applicable } = await revealableFields(tx, input.subjectType, input.subjectId);
    if (!applicable) throw new RecordsError('reveal-not-applicable');
    const auditId = app.ids.next();
    const names = presentFieldNames(fields);
    await tx.store.insert('reveal_log', {
      id: auditId,
      user_id: actor.userId,
      subject_type: input.subjectType,
      subject_id: input.subjectId,
      purpose: input.purpose,
      fields: names,
    });
    await emitAudit(app, tx, {
      id: auditId,
      action: 'contact_viewed',
      actorUserId: actor.userId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      via: input.via ?? 'ui',
      details: { subjectType: input.subjectType, purpose: input.purpose, fields: names.join(',') },
    });
    return { auditId, fields };
  });
}

/** Replay of an idempotent reveal: the same audit id, the fields read again, no second audit. */
export async function replayReveal(app: App, actor: Actor, subjectType: RevealSubject, subjectId: string): Promise<RevealFields> {
  return app.uow.run(actor, async (tx) => (await revealableFields(tx, subjectType, subjectId)).fields);
}

/** R-21: contacts for an insight export (≤ 1,000 people), one audit entry per call. */
export async function contactsBatch(
  app: App,
  actor: Actor,
  input: { personIds: string[]; exportId: string; requestedBy: string },
): Promise<{ auditId: string; items: { personId: string; purged: boolean; name?: string | null; phones?: string[]; emails?: string[]; whatsappPhone?: string | null }[] }> {
  return app.uow.run(actor, async (tx) => {
    const ids = [...new Set(input.personIds)];
    const [persons, phones, emails] = await Promise.all([
      tx.store.getMany('persons', ids),
      tx.store.findIn('person_phones', 'person_id', ids),
      tx.store.findIn('person_emails', 'person_id', ids),
    ]);
    const items = persons.map((p) =>
      p.purged_at
        ? { personId: p.id, purged: true }
        : {
            personId: p.id,
            purged: false,
            name: p.name,
            phones: phones.filter((x) => x.person_id === p.id && x.kind === 'phone').map((x) => x.phone_e164),
            emails: emails.filter((x) => x.person_id === p.id).map((x) => x.email),
            whatsappPhone: phones.find((x) => x.person_id === p.id && x.kind === 'whatsapp')?.phone_e164 ?? null,
          },
    );
    const auditId = await emitAudit(app, tx, {
      action: 'contacts_exported',
      actorUserId: input.requestedBy,
      subjectType: 'export',
      subjectId: input.exportId,
      via: 'system',
      details: { exportId: input.exportId, count: String(items.length), caller: 'insight' },
    });
    return { auditId, items };
  });
}

/** R-20: salted hashes of building/society name tokens, wing and unit (no plain names leave records). */
export async function scanTerms(app: App, actor: Actor, propertyId: string) {
  return app.uow.run(actor, async (tx) => {
    const p = await tx.store.get('properties', propertyId);
    if (!p) throw notFound('property');
    return {
      propertyId: p.id,
      saltVersion: app.hash.scanSaltVersion,
      buildingTokenHashes: buildingTokens(p.building_name).map((t) => app.hash.scanTerm(t)),
      wingHashes: unitTokens(p.wing).map((t) => app.hash.scanTerm(t)),
      unitHashes: unitTokens(p.unit_no).map((t) => app.hash.scanTerm(t)),
    };
  });
}
