// CR-012 in journeys: crm_notes imported from upload rows (record.note_imported.v1 → intake note endpoint → imported
// note, one per upload row) and the dedicated notification kinds queue_reassigned and demand_touch (proposal_failed is
// covered with the snapshot failure in sourcing-proposals.int.test.ts).
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@11e/db';
import type { EventDataMap } from '@11e/contracts/events';
import {
  NOTE_SUBJECT_WAIT_ATTEMPTS,
  SubjectNotYetKnownError,
  importNote,
  noteImported,
} from '../src/application/notes.js';
import type { ImportNoteMessage, WorkMessage } from '../src/application/ports.js';
import { ensureMigrated, eventProblems, harness, ids } from './helpers.js';

const h = harness();
const supply = ids();
const demandAgent = ids();
const manager = ids();
beforeAll(async () => {
  await ensureMigrated();
  h.clock.day('2026-10-01');
  for (const [userId, role] of [
    [supply, 'Supply agent'],
    [demandAgent, 'Demand agent'],
    [manager, 'Manager'],
  ] as const)
    await h.deliver('user.changed.v1', { userId, role, active: true }, { aggregateId: userId });
});
afterAll(() => h.close());

let n = 0;
async function offer() {
  n++;
  const data: EventDataMap['offer.created.v1'] = {
    offerId: ids(),
    code: `INV-7${String(n).padStart(4, '0')}`,
    propertyId: ids(),
    dealType: 'Sale',
    segment: 'Residential',
    micromarket: 'Worli',
    ownerUserId: supply,
  };
  await h.deliver('offer.created.v1', data, { aggregateId: data.offerId });
  return data;
}
async function demand() {
  n++;
  const d: EventDataMap['demand.created.v1'] = {
    demandId: ids(),
    code: `DEM-7${String(n).padStart(5, '0')}`,
    dealTypes: ['Sale'],
    segment: 'Residential',
    micromarkets: ['Worli'],
    ownerUserId: demandAgent,
  };
  await h.deliver('demand.created.v1', d, { aggregateId: d.demandId });
  return d;
}

/** Runs the event handler in a transaction and captures the work items it queues (no shared queue state). */
async function handle(data: EventDataMap['record.note_imported.v1']): Promise<WorkMessage[]> {
  const sent: WorkMessage[] = [];
  await h.tx((tx) => noteImported({ ...tx, work: { send: async (m) => void sent.push(m) } }, { data }));
  return sent;
}
const deps = () => ({ runner: h.runner, uploadNotes: h.integrations.uploadNotes });
const notesOf = (subjectId: string) =>
  h.rows<{
    subject_type: string;
    subject_id: string;
    label: string;
    note: string | null;
    upload_code: string | null;
    row_no: number;
  }>(
    sql`select subject_type, subject_id, label, note, upload_code, row_no from subject_notes where tenant_id = ${h.tenantId}
      and subject_id = ${subjectId} order by row_no`,
  );

describe('imported notes (record.note_imported.v1, CR-012)', () => {
  it('the contract fixture passes the AsyncAPI schema and journeys has a handler for it', () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL('../../../contracts/fixtures/events/record.note_imported.v1.json', import.meta.url),
        'utf8',
      ),
    ) as unknown;
    expect(eventProblems(fixture)).toBeNull();
  });

  it('queues the fetch, stores the text from intake marked "imported from upload <code>", once per (upload, row)', async () => {
    const o = await offer();
    const uploadId = ids();
    h.intake.set(uploadId, 7, '  Owner prefers calls after 6 pm; flexible on price.  ', 'UPL-0042');
    const data = {
      subjectType: 'offer' as const,
      subjectId: o.offerId,
      uploadId,
      rowNo: 7,
      uploadCode: 'UPL-0042',
    };
    const [msg, ...more] = await handle(data);
    expect(more).toEqual([]);
    expect(msg).toEqual({ kind: 'import_note', tenantId: h.tenantId, correlationId: 'test', ...data });

    await importNote(deps(), msg as ImportNoteMessage, 1);
    expect(await notesOf(o.offerId)).toEqual([
      {
        subject_type: 'offer',
        subject_id: o.offerId,
        label: 'imported from upload UPL-0042',
        note: 'Owner prefers calls after 6 pm; flexible on price.',
        upload_code: 'UPL-0042',
        row_no: 7,
      },
    ]);

    // redelivery: the handler queues nothing, a replayed work item neither calls intake nor stores a second note
    expect(await handle(data)).toEqual([]);
    const calls = h.intake.calls.length;
    await importNote(deps(), msg as ImportNoteMessage, 1);
    expect(h.intake.calls.length).toBe(calls);
    expect(await notesOf(o.offerId)).toHaveLength(1);

    // the text never reaches an event
    for (const e of await h.outbox()) expect(JSON.stringify(e.payload)).not.toContain('flexible on price');
  });

  it('intake 404 (no note, or raw rows purged) → nothing recorded, acknowledged; other failures throw for a retry', async () => {
    const o = await offer();
    const purged: ImportNoteMessage = {
      kind: 'import_note',
      tenantId: h.tenantId,
      correlationId: 't',
      subjectType: 'offer',
      subjectId: o.offerId,
      uploadId: ids(),
      rowNo: 3,
      uploadCode: 'UPL-0043',
    };
    await expect(importNote(deps(), purged, 1)).resolves.toBeUndefined();
    expect(await notesOf(o.offerId)).toEqual([]);

    const down = { ...purged, uploadId: ids() };
    h.intake.set(down.uploadId, 3, 'call the owner');
    h.intake.failing = true;
    await expect(importNote(deps(), down, 1)).rejects.toThrow('intake unavailable');
    h.intake.failing = false;
    expect(await notesOf(o.offerId)).toEqual([]);
    await importNote(deps(), down, 2);
    expect((await notesOf(o.offerId)).map((r) => r.note)).toEqual(['call the owner']);
  });

  it('out of order: waits (retry) for a demand journeys has not seen yet, then keeps the note anyway', async () => {
    const demandId = ids();
    const uploadId = ids();
    h.intake.set(uploadId, 1, 'wants sea view', 'UPL-0044');
    const msg: ImportNoteMessage = {
      kind: 'import_note',
      tenantId: h.tenantId,
      correlationId: 't',
      subjectType: 'demand',
      subjectId: demandId,
      uploadId,
      rowNo: 1,
      uploadCode: null,
    };
    await expect(importNote(deps(), msg, 1)).rejects.toBeInstanceOf(SubjectNotYetKnownError);
    expect(await notesOf(demandId)).toEqual([]);
    await h.deliver(
      'demand.created.v1',
      { demandId, code: 'DEM-7OOO01', dealTypes: ['Sale'], ownerUserId: demandAgent },
      { aggregateId: demandId },
    );
    await importNote(deps(), msg, 2);
    // uploadCode absent in the event: taken from intake's response
    expect(await notesOf(demandId)).toMatchObject([
      { label: 'imported from upload UPL-0044', note: 'wants sea view' },
    ]);

    const never = { ...msg, subjectId: ids(), uploadId: ids() };
    h.intake.set(never.uploadId, 1, 'kept anyway');
    await expect(importNote(deps(), never, NOTE_SUBJECT_WAIT_ATTEMPTS - 1)).rejects.toBeInstanceOf(
      SubjectNotYetKnownError,
    );
    await importNote(deps(), never, NOTE_SUBJECT_WAIT_ATTEMPTS);
    expect((await notesOf(never.subjectId)).map((r) => r.note)).toEqual(['kept anyway']);
  });

  it('people and properties are not projected: stored at once; merges re-point notes to the survivor and undo restores them', async () => {
    const [personId, propertyId, survivorProperty] = [ids(), ids(), ids()];
    const up = ids();
    h.intake.set(up, 1, 'person note');
    h.intake.set(up, 2, 'property note');
    await importNote(
      deps(),
      {
        kind: 'import_note',
        tenantId: h.tenantId,
        correlationId: 't',
        subjectType: 'person',
        subjectId: personId,
        uploadId: up,
        rowNo: 1,
        uploadCode: 'UPL-0045',
      },
      1,
    );
    await importNote(
      deps(),
      {
        kind: 'import_note',
        tenantId: h.tenantId,
        correlationId: 't',
        subjectType: 'property',
        subjectId: propertyId,
        uploadId: up,
        rowNo: 2,
        uploadCode: 'UPL-0045',
      },
      1,
    );
    expect((await notesOf(personId)).map((r) => r.note)).toEqual(['person note']);

    const mergeId = ids();
    await h.deliver(
      'records.merged.v1',
      { mergeId, aggregateType: 'property', survivorId: survivorProperty, mergedIds: [propertyId] },
      { aggregateId: mergeId },
    );
    expect(await notesOf(propertyId)).toEqual([]);
    expect((await notesOf(survivorProperty)).map((r) => r.note)).toEqual(['property note']);
    await h.deliver(
      'records.merge_undone.v1',
      { mergeId, aggregateType: 'property', restoredIds: [propertyId] },
      { aggregateId: mergeId },
    );
    expect((await notesOf(propertyId)).map((r) => r.note)).toEqual(['property note']);
  });

  it('an offer already merged in journeys: the note goes to the survivor', async () => {
    const [loser, survivor] = [await offer(), await offer()];
    const mergeId = ids();
    await h.deliver(
      'records.merged.v1',
      { mergeId, aggregateType: 'offer', survivorId: survivor.offerId, mergedIds: [loser.offerId] },
      { aggregateId: mergeId },
    );
    const up = ids();
    h.intake.set(up, 9, 'second source says 2 parking');
    await importNote(
      deps(),
      {
        kind: 'import_note',
        tenantId: h.tenantId,
        correlationId: 't',
        subjectType: 'offer',
        subjectId: loser.offerId,
        uploadId: up,
        rowNo: 9,
        uploadCode: 'UPL-0046',
      },
      1,
    );
    expect(await notesOf(loser.offerId)).toEqual([]);
    expect((await notesOf(survivor.offerId)).map((r) => r.note)).toEqual(['second source says 2 parking']);
  });

  it('retention-purge nulls imported note text after 24 months', async () => {
    const o = await offer();
    const up = ids();
    h.intake.set(up, 1, 'old note');
    await importNote(
      deps(),
      {
        kind: 'import_note',
        tenantId: h.tenantId,
        correlationId: 't',
        subjectType: 'offer',
        subjectId: o.offerId,
        uploadId: up,
        rowNo: 1,
        uploadCode: 'UPL-0047',
      },
      1,
    );
    await h.rows(
      sql`update subject_notes set updated_at = now() - interval '25 months' where tenant_id = ${h.tenantId} and upload_id = ${up}`,
    );
    await h.runJob('retention-purge');
    expect(await notesOf(o.offerId)).toMatchObject([{ note: null, label: 'imported from upload UPL-0047' }]);
  });
});

describe('notification kinds (CR-012)', () => {
  const bell = async (userId: string, role: 'Manager' | 'Demand agent') =>
    (await (await h.as(userId, role)).get('/v1/notifications')).body.items ?? [];

  it('demand_touch: another touch on a demand notifies its owner (was the enquiry stand-in)', async () => {
    const d = await demand();
    await h.deliver(
      'demand.touch_added.v1',
      { demandId: d.demandId, touchId: ids(), sourceType: 'Digi', isFirstTouch: false },
      { aggregateId: d.demandId },
    );
    const mine = (await bell(demandAgent, 'Demand agent')).filter((i) => i['subjectId'] === d.demandId);
    expect(mine).toMatchObject([
      {
        kind: 'demand_touch',
        subjectType: 'demand',
        subjectCode: d.code,
        title: `Another touch on ${d.code} via Digi`,
      },
    ]);
  });

  it('queue_reassigned: deactivating a user tells the Managers (was the watchlist_task stand-in)', async () => {
    const leaving = ids();
    await h.deliver(
      'user.changed.v1',
      { userId: leaving, role: 'Supply agent', active: true },
      { aggregateId: leaving },
    );
    await h.deliver(
      'user.changed.v1',
      { userId: leaving, role: 'Supply agent', active: false },
      { aggregateId: leaving },
    );
    const items = (await bell(manager, 'Manager')).filter((i) => i['kind'] === 'queue_reassigned');
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0]).toMatchObject({
      title: expect.stringMatching(/queue items reassigned from a deactivated user$/),
      subjectType: null,
    });
    expect((await bell(manager, 'Manager')).filter((i) => i['kind'] === 'watchlist_task')).toEqual([]);
  });
});
