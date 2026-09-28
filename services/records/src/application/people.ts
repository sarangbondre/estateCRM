// People (REC-04, US-04/US-08): a phone identifies a person (BRD); contacts are stored with keyed hashes for lookup,
// masked on read, revealed only through /v1/reveals (REC-08).
import { RecordsError, notFound } from '../domain/errors.js';
import { normaliseEmail, normalisePhone } from '../domain/phone.js';
import { MANAGER_ROLES } from '../domain/record-stage.js';
import { initials, norm } from '../domain/text.js';
import type { Actor, App } from './context.js';
import { vocabularyOf } from './context.js';
import { agg } from './emit.js';
import type { PersonRow } from './model.js';
import type { Tx } from './ports.js';

export interface PersonInput {
  name?: string | null | undefined;
  phones?: string[] | undefined;
  whatsappPhone?: string | null | undefined;
  emails?: string[] | undefined;
  otherContact?: string | null | undefined;
  companyName?: string | null | undefined;
  partyType?: string | null | undefined;
  participantRole?: string | null | undefined;
  dependencies?: { text?: string | undefined; offerId?: string | null | undefined; demandId?: string | null | undefined }[] | undefined;
}

export const PERSON_FLAGS = ['invalid', 'broker_posing', 'unwilling', 'anonymous_shares_only', 'unreachable'] as const;

interface NormalisedContacts {
  phones: { e164: string; hash: string; kind: 'phone' | 'whatsapp' }[];
  emails: { email: string; hash: string }[];
}

/** Normalises and hashes contacts; 400 phone-invalid names the bad entries by position (never the value). */
export function normaliseContacts(app: App, tenantId: string, input: PersonInput, strict: boolean): NormalisedContacts {
  const errors: { field: string; code: string }[] = [];
  const phones: NormalisedContacts['phones'] = [];
  (input.phones ?? []).forEach((raw, i) => {
    const e164 = normalisePhone(raw);
    if (!e164) errors.push({ field: `phones/${i}`, code: 'phone-invalid' });
    else if (!phones.some((p) => p.e164 === e164)) phones.push({ e164, hash: app.hash.phone(tenantId, e164), kind: 'phone' });
  });
  if (input.whatsappPhone) {
    const e164 = normalisePhone(input.whatsappPhone);
    if (!e164) errors.push({ field: 'whatsappPhone', code: 'phone-invalid' });
    else phones.push({ e164, hash: app.hash.phone(tenantId, e164), kind: 'whatsapp' });
  }
  if (errors.length && strict) throw new RecordsError('phone-invalid', undefined, { errors });
  const emails: NormalisedContacts['emails'] = [];
  for (const raw of input.emails ?? []) {
    const e = normaliseEmail(raw);
    if (e && !emails.some((x) => x.email === e)) emails.push({ email: e, hash: app.hash.email(tenantId, e) });
  }
  return { phones, emails };
}

async function validatePersonVocabulary(app: App, tx: Tx, input: PersonInput) {
  const vocab = await vocabularyOf(app, tx);
  if (!vocab) return { partyType: input.partyType, participantRole: input.participantRole };
  const out = vocab.validate([
    { path: 'partyType', field: 'party_type', value: input.partyType },
    { path: 'participantRole', field: 'participant_role', value: input.participantRole },
  ]);
  return {
    partyType: input.partyType === undefined ? undefined : (out.get('partyType') as string | null),
    participantRole: input.participantRole === undefined ? undefined : (out.get('participantRole') as string | null),
  };
}

/** Serialises phone ownership checks (a phone belongs to at most one active person, LLD §3.3). */
async function lockPhones(tx: Tx, hashes: readonly string[]) {
  for (const h of [...new Set(hashes)].sort()) await tx.advisoryLock(`phone:${h}`);
}

async function insertContacts(app: App, tx: Tx, personId: string, c: NormalisedContacts, primary: boolean) {
  await tx.store.insert(
    'person_phones',
    c.phones.map((p, i) => ({
      id: app.ids.next(),
      person_id: personId,
      phone_e164: p.e164,
      phone_hash: p.hash,
      kind: p.kind,
      is_primary: primary && i === 0,
    })),
  );
  await tx.store.insert(
    'person_emails',
    c.emails.map((e, i) => ({ id: app.ids.next(), person_id: personId, email: e.email, email_hash: e.hash, is_primary: primary && i === 0 })),
  );
}

export interface ResolvedPerson {
  person: PersonRow;
  created: boolean;
}

/**
 * Creates a person, or reuses the active person that already holds one of the phones (`onExisting: 'reuse'`, used by
 * parties, quick add and ingestion) — or refuses with 409 person-phone-exists (`'error'`, POST /v1/people).
 */
export async function createPerson(
  app: App,
  tx: Tx,
  input: PersonInput,
  options: { onExisting: 'reuse' | 'error'; strictPhones?: boolean },
): Promise<ResolvedPerson> {
  const contacts = normaliseContacts(app, tx.tenantId, input, options.strictPhones ?? true);
  await lockPhones(tx, contacts.phones.map((p) => p.hash));
  const holders = await tx.q.personsByPhoneHashes(contacts.phones.map((p) => p.hash));
  const existing = holders[0]?.person;
  if (existing) {
    if (options.onExisting === 'error') {
      throw new RecordsError('person-phone-exists', `phone belongs to person ${existing.id}`, {
        extensions: { personId: existing.id, personCode: existing.code },
      });
    }
    await addMissingContacts(app, tx, existing, contacts);
    await tx.store.update('persons', existing.id, { last_activity_at: tx.now });
    return { person: { ...existing, last_activity_at: tx.now }, created: false };
  }
  if (!contacts.phones.length && contacts.emails.length) {
    const byEmail = await tx.q.personsByEmailHashes(contacts.emails.map((e) => e.hash));
    if (byEmail[0] && options.onExisting === 'reuse') return { person: byEmail[0].person, created: false };
  }
  const vocab = await validatePersonVocabulary(app, tx, input);
  const person: PersonRow = {
    id: app.ids.next(),
    tenant_id: tx.tenantId,
    code: await tx.codes.next('PER', 6),
    name: input.name?.trim() || null,
    name_initials: initials(input.name),
    company_name: input.companyName?.trim() || null,
    company_norm: norm(input.companyName),
    party_type: vocab.partyType ?? null,
    participant_role: vocab.participantRole ?? null,
    other_contact: input.otherContact?.trim() || null,
    flags: [],
    dependencies: input.dependencies ?? [],
    status: 'active',
    merged_into_id: null,
    last_activity_at: tx.now,
    purged_at: null,
    created_at: tx.now,
    updated_at: tx.now,
    version: 1,
  };
  await tx.store.insert('persons', person);
  await insertContacts(app, tx, person.id, contacts, true);
  return { person, created: true };
}

/** Adds contacts the person does not have yet (reuse path). */
async function addMissingContacts(app: App, tx: Tx, person: PersonRow, c: NormalisedContacts) {
  const [phones, emails] = await Promise.all([
    tx.store.find('person_phones', { person_id: person.id }, { limit: 50 }),
    tx.store.find('person_emails', { person_id: person.id }, { limit: 50 }),
  ]);
  const newPhones = c.phones.filter((p) => !phones.some((x) => x.phone_hash === p.hash && x.kind === p.kind));
  const holders = await tx.q.personsByPhoneHashes(newPhones.map((p) => p.hash));
  const free = newPhones.filter((p) => !holders.some((h) => h.phoneHash === p.hash && h.person.id !== person.id));
  const newEmails = c.emails.filter((e) => !emails.some((x) => x.email_hash === e.hash));
  await insertContacts(app, tx, person.id, { phones: free, emails: newEmails }, false);
}

/** PATCH /v1/people/{id}: contacts are write-only (never echoed); lists replace the stored ones. */
export async function patchPerson(app: App, actor: Actor, id: string, input: PersonInput, ifMatch: number | undefined) {
  return app.uow.run(actor, async (tx) => {
    const person = await tx.store.get('persons', id, { lock: true });
    if (!person) throw notFound('person');
    if (person.status === 'merged') throw mergedError(person.merged_into_id);
    if (ifMatch !== undefined && ifMatch !== person.version) throw new RecordsError('version-mismatch');
    const vocab = await validatePersonVocabulary(app, tx, input);
    const patch: Partial<PersonRow> = { version: person.version + 1, last_activity_at: tx.now };
    if (input.name !== undefined) {
      patch.name = input.name?.trim() || null;
      patch.name_initials = initials(input.name);
    }
    if (input.companyName !== undefined) {
      patch.company_name = input.companyName?.trim() || null;
      patch.company_norm = norm(input.companyName);
    }
    if (input.otherContact !== undefined) patch.other_contact = input.otherContact?.trim() || null;
    if (vocab.partyType !== undefined) patch.party_type = vocab.partyType;
    if (vocab.participantRole !== undefined) patch.participant_role = vocab.participantRole;
    if (input.dependencies !== undefined) patch.dependencies = input.dependencies;
    if (input.phones !== undefined || input.whatsappPhone !== undefined || input.emails !== undefined) {
      const c = normaliseContacts(app, tx.tenantId, input, true);
      await lockPhones(tx, c.phones.map((p) => p.hash));
      const holders = await tx.q.personsByPhoneHashes(c.phones.map((p) => p.hash));
      const taken = holders.find((h) => h.person.id !== id);
      if (taken) {
        throw new RecordsError('person-phone-exists', `phone belongs to person ${taken.person.id}`, {
          extensions: { personId: taken.person.id, personCode: taken.person.code },
        });
      }
      if (input.phones !== undefined) await tx.store.delete('person_phones', { person_id: id, kind: 'phone' });
      if (input.whatsappPhone !== undefined) await tx.store.delete('person_phones', { person_id: id, kind: 'whatsapp' });
      if (input.emails !== undefined) await tx.store.delete('person_emails', { person_id: id });
      await insertContacts(
        app,
        tx,
        id,
        {
          phones: c.phones.filter((p) => (p.kind === 'phone' ? input.phones !== undefined : input.whatsappPhone !== undefined)),
          emails: input.emails !== undefined ? c.emails : [],
        },
        true,
      );
    }
    await tx.store.update('persons', id, patch);
    return id;
  });
}

/** Adds or removes a flag (removal Admin/Manager only); no event when nothing changes. */
export async function flagPerson(
  app: App,
  actor: Actor,
  id: string,
  flag: string,
  action: 'add' | 'remove',
  reason: string | undefined,
): Promise<string> {
  if (action === 'remove' && !MANAGER_ROLES.includes(actor.role)) {
    throw new RecordsError('forbidden', 'removing a flag needs Admin or Manager');
  }
  return app.uow.run(actor, async (tx) => {
    const person = await tx.store.get('persons', id, { lock: true });
    if (!person) throw notFound('person');
    if (person.status === 'merged') throw mergedError(person.merged_into_id);
    await setFlag(tx, person, flag, action, reason);
    return id;
  });
}

/** Shared by the API and consumers (call.logged unreachable, demand.exited flagPerson). */
export async function setFlag(tx: Tx, person: PersonRow, flag: string, action: 'add' | 'remove', reason?: string) {
  const has = person.flags.includes(flag);
  if ((action === 'add' && has) || (action === 'remove' && !has)) return false;
  const flags = action === 'add' ? [...person.flags, flag] : person.flags.filter((f) => f !== flag);
  const version = person.version + 1;
  await tx.store.update('persons', person.id, { flags, version, last_activity_at: tx.now });
  if (action === 'add') {
    await tx.events.emit('person.flagged.v1', agg('person', person.id, version), {
      personId: person.id,
      flag,
      ...(reason ? { reason } : {}),
    });
  } else {
    await tx.events.emit('person.flag_removed.v1', agg('person', person.id, version), { personId: person.id, flag });
  }
  return true;
}

export function mergedError(mergedIntoId: string | null) {
  return new RecordsError('record-merged', 'the record was merged', { extensions: { mergedIntoId } });
}

/** Retention anchor (NFR-18): bump last_activity_at of linked people. */
export async function touchPeople(tx: Tx, personIds: readonly (string | null | undefined)[]) {
  for (const id of new Set(personIds.filter((x): x is string => !!x))) {
    await tx.store.update('persons', id, { last_activity_at: tx.now });
  }
}
