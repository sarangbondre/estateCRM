// Imported notes (CR-012): record.note_imported.v1 says an upload row's crm_notes value belongs to a record. The event
// carries ids only; the text (PII possible) is fetched from intake with a service token off the drain transaction (work
// queue q_journeys_work) and stored once per (upload, row), marked "imported from upload <code>". The text is never
// logged, emitted, published or sent to AI.
import type { EventDataMap } from '@11e/contracts/events';
import type { ImportNoteMessage, Tx, TxRunner, UploadNotesPort } from './ports.js';

/** Tries while journeys has not seen an offer/demand subject yet (out of order); after that the note is kept anyway. */
export const NOTE_SUBJECT_WAIT_ATTEMPTS = 3;
const MAX_NOTE_LENGTH = 4000;

export class SubjectNotYetKnownError extends Error {
  override readonly name = 'SubjectNotYetKnownError';
}

export const importedLabel = (uploadCode: string | null, uploadId: string) =>
  `imported from upload ${uploadCode ?? uploadId}`;

/** Event handler (drain transaction): queue the fetch unless the upload row already has a note. */
export async function noteImported(
  tx: Tx,
  e: { data: EventDataMap['record.note_imported.v1'] },
): Promise<void> {
  const d = e.data;
  if (await tx.q.noteOfUploadRow(d.uploadId, d.rowNo)) return; // already imported (replay)
  await tx.work.send({
    kind: 'import_note',
    tenantId: tx.tenantId,
    correlationId: tx.correlationId,
    subjectType: d.subjectType,
    subjectId: d.subjectId,
    uploadId: d.uploadId,
    rowNo: d.rowNo,
    uploadCode: d.uploadCode ?? null,
  });
}

/** The subject id to attach the note to: the survivor when journeys knows the subject was merged. */
async function resolveSubject(tx: Tx, msg: ImportNoteMessage, attempt: number): Promise<string> {
  if (msg.subjectType !== 'offer' && msg.subjectType !== 'demand') return msg.subjectId; // not projected in journeys
  let id = msg.subjectId;
  for (let hop = 0; hop < 5; hop++) {
    const view =
      msg.subjectType === 'offer'
        ? await tx.rows.get('offer_view', id)
        : await tx.rows.get('demand_view', id);
    if (!view) {
      // The record's created event may not have reached journeys yet: let the work queue retry with backoff.
      if (hop === 0 && attempt < NOTE_SUBJECT_WAIT_ATTEMPTS)
        throw new SubjectNotYetKnownError(`${msg.subjectType} not yet known to journeys`);
      return id;
    }
    if (!view.merged_into) return id;
    id = view.merged_into;
  }
  return id;
}

export interface NoteWorkDeps {
  runner: TxRunner;
  uploadNotes: UploadNotesPort;
}

/**
 * import_note work item: fetch the text from intake and store it. 404 (no note, or raw rows purged) → nothing is
 * recorded and the item is acknowledged. Other intake failures throw, so the work queue retries (then dead-letters).
 */
export async function importNote(deps: NoteWorkDeps, msg: ImportNoteMessage, attempt: number): Promise<void> {
  const meta = { correlationId: msg.correlationId };
  const subjectId = await deps.runner.run(msg.tenantId, meta, async (tx) =>
    (await tx.q.noteOfUploadRow(msg.uploadId, msg.rowNo)) ? null : resolveSubject(tx, msg, attempt),
  );
  if (!subjectId) return; // already imported
  const fetched = await deps.uploadNotes.rowNote(msg.tenantId, msg.uploadId, msg.rowNo);
  if (!fetched) return;
  const note = fetched.note.trim().slice(0, MAX_NOTE_LENGTH);
  if (!note) return;
  const uploadCode = msg.uploadCode ?? fetched.uploadCode;
  await deps.runner.run(msg.tenantId, meta, (tx) =>
    tx.q.insertSubjectNote({
      subject_type: msg.subjectType,
      subject_id: subjectId,
      source: 'upload',
      upload_id: msg.uploadId,
      upload_code: uploadCode,
      row_no: msg.rowNo,
      label: importedLabel(uploadCode, msg.uploadId),
      note,
      imported_at: tx.now,
    }),
  );
}
