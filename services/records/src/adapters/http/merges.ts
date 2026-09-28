// Merge review routes (REC-06): candidates queue, dismiss, merge, get, undo.
import type { operations } from '@11e/contracts/records';
import type { Service } from '@11e/http';
import type { AppDeps } from '../../deps.js';
import type { Actor } from '../../application/context.js';
import { dismissCandidate, mergeRecords, undoMerge } from '../../application/merges.js';
import type { MergeCandidateRow } from '../../application/model.js';
import { notFound } from '../../domain/errors.js';
import { mergeCandidateDto, mergeDto } from './presenters.js';
import { actorOf, guard, json, page, pageOf, withIdempotency, wrap } from './support.js';

type Ops = operations;

const TABLE = { property: 'properties', offer: 'offers', demand: 'demands', person: 'persons' } as const;

export function registerMergeRoutes(svc: Service<Ops>, deps: AppDeps): void {
  const { app } = deps;

  const present = (actor: Actor, rows: MergeCandidateRow[]) =>
    app.uow.run(actor, async (tx) => {
      const codes = new Map<string, string>();
      for (const type of Object.keys(TABLE) as (keyof typeof TABLE)[]) {
        const ids = rows.filter((r) => r.aggregate_type === type).flatMap((r) => [r.left_id, r.right_id]).filter((x): x is string => !!x);
        for (const r of await tx.store.getMany(TABLE[type], ids)) codes.set(r.id, r.code);
      }
      return rows.map((r) => mergeCandidateDto(r, codes));
    });

  svc.op(
    'listMergeCandidates',
    wrap(async (c, { query }) => {
      const actor = actorOf(c);
      const { limit, after } = page(query);
      const rows = await app.uow.run(actor, (tx) =>
        tx.q.listCandidates(
          { aggregateType: query.aggregateType, reason: query.reason, status: query.status, uploadId: query.uploadId },
          { after, limit: limit + 1 },
        ),
      );
      return json(c, await pageOf(rows, limit, (r) => ({ k: r.score, id: r.id }), (items) => present(actor, items)));
    }),
  );

  svc.op(
    'dismissMergeCandidate',
    wrap(async (c, { params, body }) => {
      const actor = actorOf(c);
      return withIdempotency(c, deps, actor, body, async () => {
        const row = await dismissCandidate(app, actor, params.id, body.decision, body.note);
        const [dto] = await present(actor, [row]);
        return { status: 200, body: dto };
      });
    }),
  );

  svc.op(
    'mergeRecords',
    wrap(async (c, { body }) => {
      const actor = actorOf(c);
      return withIdempotency(c, deps, actor, body, async () => {
        const merge = await mergeRecords(app, actor, {
          aggregateType: body.aggregateType,
          survivorId: body.survivorId,
          mergedIds: body.mergedIds,
          candidateId: body.candidateId,
        });
        return { status: 201, body: mergeDto(merge) };
      });
    }),
  );

  svc.op(
    'getMerge',
    wrap(async (c, { params }) => {
      const actor = actorOf(c);
      const row = await guard(async () => {
        const m = await app.uow.run(actor, (tx) => tx.store.get('merges', params.id));
        if (!m) throw notFound('merge');
        return m;
      });
      return json(c, mergeDto(row));
    }),
  );

  svc.op(
    'undoMerge',
    wrap(async (c, { params }) => {
      const actor = actorOf(c);
      return withIdempotency(c, deps, actor, {}, async () => {
        const r = await undoMerge(app, actor, params.id);
        const dto = mergeDto(r.merge);
        return { status: 200, body: { ...dto, movedCounts: { ...dto.movedCounts, conflicts: r.conflicts } } };
      });
    }),
  );
}
