// Mapping mode (D-15, LLD §4.2) and start (§4.1): PUT /mapping stores the column map (optionally as a template), POST
// /start pins the active vocabulary release, fixes the chunk size and queues the split job.
import { IntakeError, notFound } from '../domain/errors.js';
import { headerFingerprint, validateMapping } from '../domain/schema.js';
import type { MappingConstants } from '../domain/schema.js';
import type { Template } from '../domain/template.js';
import type { SourceType, Upload } from '../domain/upload.js';
import type { App, StaffActor } from './context.js';

export interface MappingInput {
  sheetName?: string | undefined;
  columnMap: Record<string, string | null>;
  constants?: MappingConstants | undefined;
  templateId?: string | null | undefined;
  saveAsTemplate?: { name: string } | null | undefined;
}

const MAPPABLE = ['awaiting_mapping', 'ready', 'awaiting_duplicate_confirmation'];

export async function putMapping(
  app: App,
  actor: StaffActor,
  idOrCode: string,
  input: MappingInput,
  ifMatch: number | undefined,
): Promise<Upload> {
  return app.uow.transaction(async (tx) => {
    const upload = await tx.repos.uploads.find(actor.tenantId, idOrCode, { forUpdate: true });
    if (!upload) throw notFound('upload');
    if (ifMatch !== undefined && ifMatch !== upload.version) throw new IntakeError('version-mismatch');
    if (upload.mode === 'strict') {
      throw new IntakeError('mapping-not-allowed', 'the file matches the standard schema (strict mode)');
    }
    if (!MAPPABLE.includes(upload.status) || !upload.header) {
      throw new IntakeError(
        'upload-not-ready',
        `a mapping cannot be set while the upload is ${upload.status}`,
      );
    }
    if (input.sheetName !== undefined && input.sheetName !== upload.sheetName) {
      if (!upload.sheetNames?.includes(input.sheetName)) {
        throw new IntakeError('sheet-not-found', `sheet "${input.sheetName}" is not in the workbook`, [
          { field: 'sheetName', code: 'sheet-not-found' },
        ]);
      }
      throw new IntakeError(
        'upload-not-ready',
        'change the sheet with PATCH first; the new sheet is re-inspected',
      );
    }
    if (input.templateId && !(await tx.repos.templates.find(actor.tenantId, input.templateId))) {
      throw new IntakeError('mapping-invalid', 'template not found', [
        { field: 'templateId', code: 'not-found' },
      ]);
    }
    const constants = input.constants ?? {};
    const sourceType = constants.sourceType ?? upload.sourceType;
    const issues = validateMapping(input.columnMap, constants, sourceType, upload.header);
    if (issues.length) throw new IntakeError('mapping-invalid', 'the column mapping is not valid', issues);

    let templateId = input.templateId ?? upload.templateId;
    if (input.saveAsTemplate) {
      const now = app.clock.now();
      const t: Template = {
        id: app.ids.uuid(),
        tenantId: actor.tenantId,
        name: input.saveAsTemplate.name,
        sourceType: sourceType as SourceType,
        sourceDetail: upload.sourceDetail,
        headers: upload.header,
        headerFingerprint: headerFingerprint(upload.header),
        columnMap: input.columnMap,
        constants: Object.keys(constants).length ? { ...constants } : null,
        createdBy: actor.userId,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      if (!(await tx.repos.templates.insert(t))) {
        throw new IntakeError('template-name-taken', `a template named "${t.name}" already exists`);
      }
      templateId = t.id;
    }
    const updated = await tx.repos.uploads.update(actor.tenantId, upload.id, {
      columnMap: input.columnMap,
      constants: Object.keys(constants).length ? { ...constants } : null,
      templateId,
      status: upload.status === 'awaiting_duplicate_confirmation' ? upload.status : 'ready',
    });
    return updated as Upload;
  });
}

export interface StartInput {
  allowDuplicate?: boolean | undefined;
  reprocessUnchanged?: boolean | undefined;
}

export interface SplitMessage {
  tenantId: string;
  uploadId: string;
  correlationId: string;
}

export async function startUpload(
  app: App,
  actor: StaffActor,
  idOrCode: string,
  input: StartInput,
): Promise<Upload> {
  if (input.reprocessUnchanged && actor.role !== 'Admin' && actor.role !== 'Manager') {
    throw new IntakeError('forbidden', 'reprocessUnchanged is for Admin and Manager');
  }
  return app.uow.transaction(async (tx) => {
    const upload = await tx.repos.uploads.find(actor.tenantId, idOrCode, { forUpdate: true });
    if (!upload) throw notFound('upload');
    if (upload.status === 'awaiting_duplicate_confirmation' && !input.allowDuplicate) {
      throw new IntakeError(
        'duplicate-upload',
        'an identical file was already processed; send allowDuplicate=true to process it again',
      );
    }
    if (upload.status !== 'ready' && upload.status !== 'awaiting_duplicate_confirmation') {
      throw new IntakeError('upload-not-ready', `upload is ${upload.status}`);
    }
    if (upload.mode === 'mapping' && !upload.columnMap) {
      throw new IntakeError('upload-not-ready', 'set the column mapping first');
    }
    const vocabulary = await tx.repos.vocabulary.active(actor.tenantId);
    if (!vocabulary)
      throw new IntakeError('vocabulary-unavailable', 'no controlled-vocabulary release is cached yet');
    const updated = (await tx.repos.uploads.update(actor.tenantId, upload.id, {
      status: 'queued',
      vocabularyVersion: vocabulary.version,
      chunkSize: app.policy.chunkSize,
      allowDuplicate: input.allowDuplicate ?? false,
      reprocessUnchanged: input.reprocessUnchanged ?? false,
    })) as Upload;
    const msg: SplitMessage = {
      tenantId: actor.tenantId,
      uploadId: upload.id,
      correlationId: actor.correlationId,
    };
    await tx.queue.send('q_intake_split', { ...msg });
    return updated;
  });
}
