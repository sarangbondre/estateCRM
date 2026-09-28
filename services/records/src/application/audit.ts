// audit.recorded.v1 (producer "*", consumed by web): sensitive actions with field names / ids / counts only, never
// PII values (records LLD §4.14, §4.18, §4.7).
import type { App } from './context.js';
import type { Tx } from './ports.js';

export async function emitAudit(
  app: App,
  tx: Tx,
  a: {
    id?: string;
    action: 'contact_viewed' | 'contacts_exported' | 'records_merged' | 'merge_undone';
    actorUserId: string;
    subjectType: string;
    subjectId: string;
    via?: 'ui' | 'chat' | 'system' | undefined;
    details?: Record<string, string>;
  },
): Promise<string> {
  const id = a.id ?? app.ids.next();
  await tx.events.emit('audit.recorded.v1', { aggregateType: 'audit', aggregateId: id, aggregateVersion: 1 }, {
    action: a.action,
    actorUserId: a.actorUserId,
    subjectType: a.subjectType,
    subjectId: a.subjectId,
    ...(a.via ? { via: a.via } : {}),
    ...(a.details ? { details: a.details } : {}),
  });
  return id;
}
