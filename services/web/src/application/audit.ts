// Audit sink and log (US-35, web LLD §4.6) and web's notifications (R-6, §4.7): events from q_web, the Admin audit
// log, the caller's notifications, and the retention / chain-verify jobs.
import { PRODUCERS, actionFilter, scrubDetails, verifyChain } from '../domain/audit';
import type { AuditEntry, Producer, Via } from '../domain/audit';
import { WebError } from '../domain/errors';
import {
  NOTIFICATION_RETENTION_DAYS,
  UNREAD_CAP,
  exportFailedTitle,
  exportLink,
  exportReadyTitle,
  uploadCompletedTitle,
  uploadFailedTitle,
  uploadLink,
} from '../domain/notifications';
import type { AuditRepo, Clock, NotificationRecord, NotificationRepo, Tx, UserRepo } from './ports';
import type { StaffContext } from './sessions';

/** The event envelope fields the sink needs (conventions §5). */
export interface InboundEvent {
  eventId: string;
  eventType: string;
  occurredAt: string;
  correlationId: string;
  producer: string;
  tenantId: string;
  data: Record<string, unknown>;
}

export interface AuditDeps {
  audit: AuditRepo;
  notifications: NotificationRepo;
  users: UserRepo;
  clock: Clock;
  /** libs/redaction-style detector for phone / e-mail patterns. */
  looksLikePii: (value: string) => boolean;
  /** Alarm hooks (logged; wired to metrics in the adapter). */
  onScrubbed?: (eventId: string) => void;
  onChainBroken?: (tenantId: string, entryId: string) => void;
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export class AuditAndNotifications {
  constructor(private readonly d: AuditDeps) {}

  /**
   * One q_web event inside the drain's transaction (dedupe on eventId is done by libs/outbox + a unique index).
   * Invalid payloads throw so the message goes to the DLQ after retries.
   */
  async apply(e: InboundEvent, tx: Tx): Promise<void> {
    switch (e.eventType) {
      case 'audit.recorded.v1': {
        if (!PRODUCERS.includes(e.producer as Producer)) throw new WebError('validation-failed', 'unknown producer');
        const action = str(e.data['action']);
        const actor = str(e.data['actorUserId']);
        const subjectType = str(e.data['subjectType']);
        const subjectId = str(e.data['subjectId']);
        if (!action || !actor || !subjectType || !subjectId) throw new WebError('validation-failed', 'audit event incomplete');
        const { details, scrubbed } = scrubDetails(e.data['details'] as Record<string, unknown> | undefined, this.d.looksLikePii);
        if (scrubbed) this.d.onScrubbed?.(e.eventId);
        const via = (str(e.data['via']) ?? 'ui') as Via;
        await tx.audit.append({
          tenantId: e.tenantId,
          eventId: e.eventId,
          occurredAt: new Date(e.occurredAt),
          producer: e.producer as Producer,
          action: action.slice(0, 80),
          actorUserId: actor,
          subjectType: subjectType.slice(0, 40),
          subjectId,
          via: ['ui', 'chat', 'system'].includes(via) ? via : 'ui',
          details,
          correlationId: e.correlationId ?? null,
        });
        return;
      }
      case 'upload.completed.v1':
      case 'upload.failed.v1': {
        const code = str(e.data['code']) ?? 'Upload';
        const counts = (e.data['counts'] ?? {}) as Record<string, unknown>;
        await tx.notifications.insert(
          this.record(e, str(e.data['uploadedBy']), {
            kind: e.eventType === 'upload.completed.v1' ? 'upload_completed' : 'upload_failed',
            subjectType: 'upload',
            subjectId: str(e.data['uploadId']),
            subjectCode: code,
            title:
              e.eventType === 'upload.completed.v1'
                ? uploadCompletedTitle(code, {
                    accepted: num(counts['accepted']),
                    rejected: num(counts['rejected']),
                    needsReview: num(counts['needsReview']),
                  })
                : uploadFailedTitle(code, str(e.data['reason']) ?? ''),
            link: uploadLink(code),
          }),
        );
        return;
      }
      case 'export.completed.v1':
      case 'export.failed.v1': {
        const code = str(e.data['code']) ?? 'Export';
        await tx.notifications.insert(
          this.record(e, str(e.data['requestedBy']), {
            kind: e.eventType === 'export.completed.v1' ? 'export_ready' : 'export_failed',
            subjectType: 'export',
            subjectId: str(e.data['exportId']),
            subjectCode: code,
            title:
              e.eventType === 'export.completed.v1'
                ? exportReadyTitle(code, num(e.data['rowCount']))
                : exportFailedTitle(code, str(e.data['reason']) ?? ''),
            link: exportLink(code),
          }),
        );
        return;
      }
      default:
        // Not a web subscription: ignore (the topology never routes others here).
        return;
    }
  }

  private record(
    e: InboundEvent,
    userId: string | undefined,
    n: Pick<NotificationRecord, 'kind' | 'subjectType' | 'subjectCode' | 'title' | 'link'> & { subjectId: string | undefined },
  ): NotificationRecord {
    if (!userId || !n.subjectId) throw new WebError('validation-failed', `${e.eventType} without recipient or subject`);
    return {
      tenantId: e.tenantId,
      id: crypto.randomUUID(),
      userId,
      kind: n.kind,
      subjectType: n.subjectType,
      subjectId: n.subjectId,
      subjectCode: n.subjectCode,
      title: n.title,
      link: n.link,
      sourceEventId: e.eventId,
      createdAt: new Date(e.occurredAt),
      readAt: null,
    };
  }

  /** GET /v1/audit-log (Admin): newest first; actor names resolved at read time. */
  async list(
    ctx: StaffContext,
    q: {
      actorUserId?: string;
      action?: string;
      subjectType?: string;
      subjectId?: string;
      producer?: Producer;
      from?: Date;
      to?: Date;
      limit: number;
      after?: { occurredAt: Date; id: string };
    },
  ): Promise<{ entries: AuditEntry[]; names: Map<string, string> }> {
    const entries = await this.d.audit.list(ctx.tenantId, {
      ...(q.actorUserId ? { actorUserId: q.actorUserId } : {}),
      ...(q.action ? { action: actionFilter(q.action) } : {}),
      ...(q.subjectType ? { subjectType: q.subjectType } : {}),
      ...(q.subjectId ? { subjectId: q.subjectId } : {}),
      ...(q.producer ? { producer: q.producer } : {}),
      ...(q.from ? { from: q.from } : {}),
      ...(q.to ? { to: q.to } : {}),
      ...(q.after ? { after: q.after } : {}),
      limit: q.limit,
    });
    const ids = [...new Set(entries.map((e) => e.actorUserId))];
    const users = await this.d.users.getMany(ctx.tenantId, ids);
    return { entries, names: new Map(users.map((u) => [u.id, u.displayName])) };
  }

  async myNotifications(ctx: StaffContext, q: { unreadOnly: boolean; limit: number; after?: { createdAt: Date; id: string } }) {
    const [items, unreadCount] = await Promise.all([
      this.d.notifications.list(ctx.tenantId, ctx.userId, q),
      this.d.notifications.unreadCount(ctx.tenantId, ctx.userId, UNREAD_CAP),
    ]);
    return { items, unreadCount };
  }

  async markRead(ctx: StaffContext, sel: { ids?: string[]; upTo?: Date }) {
    const updated = await this.d.notifications.markRead(ctx.tenantId, ctx.userId, sel, this.d.clock.now());
    const unreadCount = await this.d.notifications.unreadCount(ctx.tenantId, ctx.userId, UNREAD_CAP);
    return { updated, unreadCount };
  }

  /** notification-prune (daily): older than 90 days, bounded. */
  async pruneNotifications(limit = 5000) {
    const before = new Date(this.d.clock.now().getTime() - NOTIFICATION_RETENTION_DAYS * 86_400_000);
    const processed = await this.d.notifications.prune(before, limit);
    return { processed, remaining: processed === limit ? 1 : 0 };
  }

  /** audit-chain-verify (daily): re-verify the last 48 h per tenant; alarm on a break; keep partitions ahead. */
  async verifyChains(sha256: (b: Uint8Array) => Uint8Array, limit = 50_000) {
    await this.d.audit.ensurePartitions();
    const since = new Date(this.d.clock.now().getTime() - 48 * 3600_000);
    let processed = 0;
    for (const tenant of await this.d.audit.tenantsWithEntriesSince(since)) {
      const chain = await this.d.audit.chainSince(tenant, since, limit);
      processed += chain.length;
      const broken = verifyChain(chain, sha256);
      if (broken) this.d.onChainBroken?.(tenant, broken);
    }
    return { processed, remaining: 0 };
  }
}
