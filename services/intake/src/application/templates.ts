// Mapping templates CRUD (LLD §3.6, intake.yaml tag Templates).
import { IntakeError, notFound } from '../domain/errors.js';
import { headerFingerprint, validateMapping } from '../domain/schema.js';
import type { Template } from '../domain/template.js';
import type { SourceType } from '../domain/upload.js';
import type { App, StaffActor } from './context.js';
import type { Position, TemplateListFilter } from './ports.js';

export interface TemplateInput {
  name: string;
  sourceType: SourceType;
  sourceDetail?: string | undefined;
  headers: string[];
  columnMap: Record<string, string | null>;
  constants?: Record<string, unknown> | undefined;
}

/** Only structural checks: targets used once, mapped columns belong to the header. */
function check(input: TemplateInput): void {
  const issues = validateMapping(input.columnMap, {}, 'Direct', input.headers).filter(
    (i) => i.code === 'duplicate-target' || i.code === 'unknown-column',
  );
  if (issues.length) throw new IntakeError('validation-failed', 'the template mapping is not valid', issues);
}

export async function createTemplate(app: App, actor: StaffActor, input: TemplateInput): Promise<Template> {
  check(input);
  const now = app.clock.now();
  const t: Template = {
    id: app.ids.uuid(),
    tenantId: actor.tenantId,
    name: input.name,
    sourceType: input.sourceType,
    sourceDetail: input.sourceDetail ?? null,
    headers: input.headers,
    headerFingerprint: headerFingerprint(input.headers),
    columnMap: input.columnMap,
    constants: input.constants ?? null,
    createdBy: actor.userId,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  if (!(await app.uow.repos.templates.insert(t))) {
    throw new IntakeError('template-name-taken', `a template named "${t.name}" already exists`);
  }
  return t;
}

export async function getTemplate(app: App, tenantId: string, id: string): Promise<Template> {
  const t = await app.uow.repos.templates.find(tenantId, id);
  if (!t) throw notFound('template');
  return t;
}

export function listTemplates(
  app: App,
  tenantId: string,
  filter: TemplateListFilter,
  after: Position | undefined,
  limit: number,
): Promise<Template[]> {
  return app.uow.repos.templates.list(tenantId, filter, after, limit + 1);
}

export async function replaceTemplate(
  app: App,
  actor: StaffActor,
  id: string,
  input: TemplateInput,
  ifMatch: number | undefined,
): Promise<Template> {
  check(input);
  const r = await app.uow.repos.templates.replace(
    {
      id,
      tenantId: actor.tenantId,
      name: input.name,
      sourceType: input.sourceType,
      sourceDetail: input.sourceDetail ?? null,
      headers: input.headers,
      headerFingerprint: headerFingerprint(input.headers),
      columnMap: input.columnMap,
      constants: input.constants ?? null,
      updatedAt: app.clock.now(),
    },
    ifMatch,
  );
  if (r === 'name-taken')
    throw new IntakeError('template-name-taken', `a template named "${input.name}" already exists`);
  if (r) return r;
  await getTemplate(app, actor.tenantId, id); // 404 when missing
  throw new IntakeError('version-mismatch');
}

/** Soft delete; deleting an already-deleted or unknown template is a no-op (204). */
export async function deleteTemplate(app: App, actor: StaffActor, id: string): Promise<void> {
  await app.uow.repos.templates.softDelete(actor.tenantId, id);
}
