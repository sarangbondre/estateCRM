// vocabulary-refresh (contract jobs enum): after vocabulary.released.v1 / micromarkets.updated.v1 the projector marks
// the tenant pending; this job fetches the active release and the micromarket hierarchy from records (service token)
// and stores them. Without a service credential (local development) nothing is fetched and libs/vocabulary v0.6 is
// the active release.
import type { RecordsReference, ReferenceStore } from './ports.js';

export async function refreshReferenceData(
  records: RecordsReference,
  store: ReferenceStore,
  budgetMs: number,
): Promise<{ processed: number; remaining: number }> {
  if (!records.available) return { processed: 0, remaining: 0 };
  const deadline = Date.now() + budgetMs;
  const tenants = await store.pendingTenants(50);
  let processed = 0;
  for (const tenantId of tenants) {
    if (Date.now() > deadline) break;
    const [vocabulary, nodes] = await Promise.all([records.vocabulary(tenantId), records.micromarkets(tenantId)]);
    await store.saveVocabulary(tenantId, vocabulary);
    await store.replaceMicromarkets(tenantId, nodes);
    await store.markRefreshed(tenantId);
    processed++;
  }
  return { processed, remaining: tenants.length - processed };
}
