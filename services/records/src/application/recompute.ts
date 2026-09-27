// Job recompute-launch-area (records LLD §4.9): after a launch-area or hierarchy change, re-resolve micromarkets and
// the outside flag of existing records in batches of 1,000, emitting updated events for records that changed.
import { demandOutside, launchAreaVerdict } from '../domain/launch-area.js';
import type { Actor, App } from './context.js';
import { launchCitiesOf, micromarketIndexOf } from './context.js';
import { activeOfferIdsOf, bumpDemandsUpdated, bumpOffersUpdated, emitProject } from './emit.js';
import type { Tx } from './ports.js';

const PHASES = ['properties', 'demands', 'projects', 'desk_items'] as const;
type Phase = (typeof PHASES)[number];
interface Cursor {
  phase: Phase;
  after: string | null;
}
const BATCH = 1000;

/** One bounded step for one tenant. Returns rows processed and whether more work remains. */
export async function recomputeLaunchAreaStep(app: App, actor: Actor): Promise<{ processed: number; more: boolean }> {
  app.cache.invalidate(actor.tenantId);
  return app.uow.run(
    actor,
    async (tx) => {
      const [ref] = await tx.store.find('reference_versions', { kind: 'launch_area' }, { limit: 1, lock: true });
      if (!ref || (ref.recompute_status !== 'queued' && ref.recompute_status !== 'running')) return { processed: 0, more: false };
      const cursor = (ref.recompute_cursor as Cursor | null) ?? { phase: 'properties', after: null };
      const processed = await step(app, tx, cursor);
      let next: Cursor | null;
      if (processed.count < BATCH) {
        const i = PHASES.indexOf(cursor.phase);
        next = i + 1 < PHASES.length ? { phase: PHASES[i + 1] as Phase, after: null } : null;
      } else next = { phase: cursor.phase, after: processed.last };
      await tx.store.updateWhere(
        'reference_versions',
        { kind: 'launch_area' },
        next ? { recompute_status: 'running', recompute_cursor: next } : { recompute_status: 'done', recompute_cursor: null },
      );
      return { processed: processed.count, more: next !== null };
    },
    { timeoutMs: 30_000 },
  );
}

async function step(app: App, tx: Tx, cursor: Cursor): Promise<{ count: number; last: string | null }> {
  const tree = await micromarketIndexOf(app, tx);
  const cities = await launchCitiesOf(app, tx);
  switch (cursor.phase) {
    case 'properties': {
      const rows = await tx.store.scan('properties', cursor.after, BATCH, { status: 'active' });
      const flipped: string[] = [];
      for (const p of rows) {
        const node = p.locality ? tree.resolve(p.locality) : p.micromarket_id ? tree.byId(p.micromarket_id) : undefined;
        const micromarketId = node?.id ?? (p.locality ? null : p.micromarket_id);
        const verdict = launchAreaVerdict({ city: p.city, resolvedInLaunchArea: node?.in_launch_area }, cities);
        if (verdict.outside !== p.outside_launch_area || micromarketId !== p.micromarket_id) {
          await tx.store.update('properties', p.id, {
            outside_launch_area: verdict.outside,
            micromarket_id: micromarketId,
            version: p.version + 1,
          });
          flipped.push(p.id);
        }
      }
      await bumpOffersUpdated(tx, await activeOfferIdsOf(tx, flipped));
      return { count: rows.length, last: rows.at(-1)?.id ?? null };
    }
    case 'demands': {
      const rows = await tx.store.scan('demands', cursor.after, BATCH, { status: 'active' });
      const flipped: string[] = [];
      for (const d of rows) {
        const places = d.micromarket_ids.map((id) => ({ inLaunchArea: tree.byId(id)?.in_launch_area }));
        const outside = demandOutside(places);
        if (outside !== d.outside_launch_area) {
          await tx.store.update('demands', d.id, { outside_launch_area: outside });
          flipped.push(d.id);
        }
      }
      await bumpDemandsUpdated(tx, flipped);
      return { count: rows.length, last: rows.at(-1)?.id ?? null };
    }
    case 'projects': {
      const rows = await tx.store.scan('projects', cursor.after, BATCH);
      for (const p of rows) {
        const node = p.locality ? tree.resolve(p.locality) : undefined;
        const verdict = launchAreaVerdict({ city: p.city, resolvedInLaunchArea: node?.in_launch_area }, cities);
        if (verdict.outside !== p.outside_launch_area) {
          await tx.store.update('projects', p.id, { outside_launch_area: verdict.outside, version: p.version + 1 });
          await emitProject(tx, 'project.updated.v1', p.id);
        }
      }
      return { count: rows.length, last: rows.at(-1)?.id ?? null };
    }
    case 'desk_items': {
      const rows = await tx.store.scan('desk_items', cursor.after, BATCH, { status: 'active' });
      const linked = new Map(
        (await tx.store.getMany('properties', rows.map((r) => r.linked_property_id).filter((x): x is string => !!x))).map((p) => [p.id, p]),
      );
      for (const item of rows) {
        const prop = item.linked_property_id ? linked.get(item.linked_property_id) : undefined;
        if (prop && prop.outside_launch_area !== item.outside_launch_area) {
          await tx.store.update('desk_items', item.id, { outside_launch_area: prop.outside_launch_area });
        }
      }
      return { count: rows.length, last: rows.at(-1)?.id ?? null };
    }
  }
}
