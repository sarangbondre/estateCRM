// Voiding (records LLD §4.16): a record whose side/scope changed on review (or that was discarded) is kept for lineage
// but hidden, never matched or published; offer.voided.v1 / demand.voided.v1 tell the consumers.
import { agg } from './emit.js';
import type { IngestedRecordRow, VoidReason } from './model.js';
import type { Tx } from './ports.js';

export async function voidSubject(tx: Tx, rec: IngestedRecordRow, reason: VoidReason): Promise<void> {
  if (rec.primary_subject_type === 'offer') {
    const offers = [
      ...(rec.property_id ? await tx.store.find('offers', { property_id: rec.property_id, ingested_record_id: rec.id }, { limit: 20 }) : []),
      ...(rec.primary_subject_id ? await tx.store.getMany('offers', [rec.primary_subject_id]) : []),
    ];
    for (const o of new Map(offers.map((x) => [x.id, x])).values()) {
      if (o.status !== 'active') continue;
      const version = o.version + 1;
      await tx.store.update('offers', o.id, { status: 'voided', void_reason: reason, version });
      await tx.events.emit('offer.voided.v1', agg('offer', o.id, version), { offerId: o.id, reason });
    }
  } else if (rec.primary_subject_type === 'demand' && rec.primary_subject_id) {
    const d = await tx.store.get('demands', rec.primary_subject_id, { lock: true });
    if (d && d.status === 'active') {
      const version = d.version + 1;
      await tx.store.update('demands', d.id, { status: 'voided', void_reason: reason, version });
      await tx.events.emit('demand.voided.v1', agg('demand', d.id, version), { demandId: d.id, reason });
    }
  } else if (rec.primary_subject_type === 'desk_item' && rec.primary_subject_id) {
    await tx.store.update('desk_items', rec.primary_subject_id, { status: 'voided' });
  } else if (rec.primary_subject_type === 'unrouted') {
    await tx.store.updateWhere('unrouted_rows', { external_source: rec.external_source, external_ref: rec.external_ref }, { status: 'routed', routed_at: tx.now });
  }
}
