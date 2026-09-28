// Scheduled maintenance (REC-12, records LLD §7, §8): retention purge of personal data (NFR-18: 24 months after
// the last activity) and the nightly counter reconciliation. Bounded batches; `more` asks the scheduler to continue.
import type { Actor, App } from './context.js';
import type { Tx } from './ports.js';

export const RETENTION_MONTHS = 24;
const BATCH = 500;
/** Unrouted row snapshots (PII) are kept 30 days after routing (LLD §7). */
const UNROUTED_KEEP_DAYS = 30;

export function retentionCutoff(now: Date, months = RETENTION_MONTHS): Date {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

export async function retentionPurgeStep(app: App, actor: Actor): Promise<{ processed: number; more: boolean }> {
  return app.uow.run(
    actor,
    async (tx) => {
      const cutoff = retentionCutoff(tx.now);
      let processed = 0;
      let more = false;

      const persons = await tx.q.purgeablePersons(cutoff, BATCH);
      more ||= persons.length === BATCH;
      for (const id of persons) {
        await tx.store.delete('person_phones', { person_id: id });
        await tx.store.delete('person_emails', { person_id: id });
        await tx.store.update('persons', id, { name: null, name_initials: null, other_contact: null, dependencies: [], purged_at: tx.now });
        await tx.store.updateWhere('enquiries', { person_id: id }, { message: null });
        processed++;
      }

      const ads = await tx.q.purgeableSourceAds(cutoff, BATCH);
      more ||= ads.length === BATCH;
      for (const id of ads) {
        await tx.store.update('source_ads', id, { raw_text: null, text_variants: null, sender_name: null, sender_phone: null, purged_at: tx.now });
        processed++;
      }

      const units = await tx.q.purgeableUnitDetails(cutoff, BATCH);
      more ||= units.length === BATCH;
      for (const id of units) {
        await tx.store.update('properties', id, { wing: null, unit_no: null, floor_no: null });
        processed++;
      }

      processed += await purgeOldEnquiryMessages(tx, cutoff);
      processed += await purgeRoutedSnapshots(tx);
      return { processed, more };
    },
    { timeoutMs: 30_000 },
  );
}

async function purgeOldEnquiryMessages(tx: Tx, cutoff: Date): Promise<number> {
  const ids = await tx.q.oldEnquiryMessages(cutoff, BATCH);
  for (const id of ids) await tx.store.update('enquiries', id, { message: null });
  return ids.length;
}

async function purgeRoutedSnapshots(tx: Tx): Promise<number> {
  const before = new Date(tx.now.getTime() - UNROUTED_KEEP_DAYS * 86_400_000);
  const routed = (await tx.store.find('unrouted_rows', { status: 'routed' }, { limit: BATCH, orderBy: [{ column: 'created_at' }] })).filter(
    (r) => r.routed_at !== null && r.routed_at < before,
  );
  for (const r of routed) await tx.store.delete('unrouted_rows', { id: r.id });
  return routed.length;
}

/** Nightly reconcile-counters: offer signals and demand touch counts from their children, 500 records per step. */
export async function reconcileCountersStep(app: App, actor: Actor): Promise<{ processed: number; more: boolean }> {
  return app.uow.run(
    actor,
    async (tx) => {
      const [state] = await tx.store.find('reference_versions', { kind: 'reconcile_counters' }, { limit: 1, lock: true });
      const cursor = (state?.recompute_cursor as { phase: 'offers' | 'demands'; after: string | null } | null) ?? { phase: 'offers', after: null };
      let fixed = 0;
      let rows: { id: string }[];
      if (cursor.phase === 'offers') {
        const offers = await tx.store.scan('offers', cursor.after, BATCH);
        rows = offers;
        const counts = await tx.q.offerCounters(offers.map((o) => o.id));
        for (const o of offers) {
          const c = counts.get(o.id);
          if (!c) continue;
          const patch = {
            sighting_count: Math.max(c.sightings, 0),
            enquiry_count: c.enquiries,
            second_source_count: c.secondSources,
            has_price_gap: c.openGap,
          };
          if (o.sighting_count !== patch.sighting_count || o.enquiry_count !== patch.enquiry_count || o.second_source_count !== patch.second_source_count || o.has_price_gap !== patch.has_price_gap) {
            await tx.store.update('offers', o.id, patch);
            fixed++;
          }
        }
      } else {
        const demands = await tx.store.scan('demands', cursor.after, BATCH);
        rows = demands;
        const counts = await tx.q.demandTouchCounts(demands.map((d) => d.id));
        for (const d of demands) {
          const n = counts.get(d.id) ?? 0;
          if (n > 0 && n !== d.touch_count) {
            await tx.store.update('demands', d.id, { touch_count: n });
            fixed++;
          }
        }
      }
      const done = rows.length < BATCH;
      const next = done ? (cursor.phase === 'offers' ? { phase: 'demands' as const, after: null } : null) : { phase: cursor.phase, after: rows.at(-1)?.id ?? null };
      if (state) await tx.store.updateWhere('reference_versions', { kind: 'reconcile_counters' }, { recompute_cursor: next, recompute_status: next ? 'running' : 'done' });
      else await tx.store.insert('reference_versions', { kind: 'reconcile_counters', version: 1, recompute_status: next ? 'running' : 'done', recompute_cursor: next });
      return { processed: fixed, more: next !== null };
    },
    { timeoutMs: 30_000 },
  );
}
