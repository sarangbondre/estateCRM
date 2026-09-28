// Small chat adapters: display-code lookup in the read model, the libs/redaction redactor (angle placeholders,
// LLD §4.1) and the hf_usage meter (credits flag cached 30 s, LLD §4.2).
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { redact, restore } from '@11e/redaction';
import type { CodeLookup, Ids, Redactor, UsageMeter } from '../application/ports.js';
import type { ResolvedSubject } from '../domain/cards/cardBuilder.js';
import type { SubjectKind } from '../domain/cards/actionCatalogue.js';
import { istDay } from '../domain/dates.js';
import type { InsightDb } from './db.js';

export const ids: Ids = { uuid: () => randomUUID() };

export function createCodeLookup(db: Kysely<InsightDb>): CodeLookup {
  return {
    async resolve(tenantId, codes) {
      const out = new Map<string, ResolvedSubject | null>();
      const list = [...new Set(codes.map((c) => c.toUpperCase()))].slice(0, 20);
      for (const c of list) out.set(c, null);
      if (!list.length) return out;
      const r = await sql<{ kind: SubjectKind; id: string; code: string; merged: boolean; version: number | null }>`
        with hits as (
          select 'offer' as kind, id, code, merged_into_id is not null as merged from rm_offer where tenant_id = ${tenantId} and code = any(${list})
          union all select 'demand', id, code, merged_into_id is not null from rm_demand where tenant_id = ${tenantId} and code = any(${list})
          union all select 'match', id, code, false from rm_match where tenant_id = ${tenantId} and code = any(${list})
          union all select 'project', id, code, false from rm_project where tenant_id = ${tenantId} and code = any(${list})
          union all select 'deal', id, code, false from rm_deal where tenant_id = ${tenantId} and code = any(${list})
          union all select 'desk_item', id, code, false from rm_desk_item where tenant_id = ${tenantId} and code = any(${list}))
        select h.kind, h.id, h.code, h.merged,
               (select max(v.version) from rm_version v where v.tenant_id = ${tenantId} and v.aggregate_id = h.id) as version
          from hits h`.execute(db);
      for (const row of r.rows) out.set(row.code, { kind: row.kind, id: row.id, code: row.code, merged: row.merged, version: row.version });
      return out;
    },
  };
}

export const redactor: Redactor = {
  redact(text, allowTerms) {
    const r = redact(text, { placeholderStyle: 'angle', allowTerms });
    return { text: r.text, counts: { ...r.counts }, mapping: r.mapping };
  },
  restore: (text, mapping) => restore(text, mapping),
};

/** Next 1st of the month, 00:00 IST. */
export function nextMonthIst(now: Date): Date {
  const [y, m] = istDay(now).split('-').map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m, 1)); // month index m = next month
  return new Date(first.getTime() - 330 * 60_000);
}

export function createUsageMeter(db: Kysely<InsightDb>): UsageMeter {
  const cache = new Map<string, { at: number; until: Date | null }>();
  return {
    async creditsExhausted(tenantId, now) {
      const hit = cache.get(tenantId);
      let until = hit && Date.now() - hit.at < 30_000 ? hit.until : undefined;
      if (until === undefined) {
        const r = await sql<{ until: Date | null }>`select max(credits_exhausted_until) as until from hf_usage
          where tenant_id = ${tenantId} and day >= ${istDay(new Date(now.getTime() - 40 * 86_400_000))}`.execute(db);
        until = r.rows[0]?.until ?? null;
        cache.set(tenantId, { at: Date.now(), until });
      }
      return !!until && until > now;
    },
    async record(tenantId, now, result) {
      const day = istDay(now);
      const ok = result.ok;
      const until = !ok && result.reason === 'credits' ? nextMonthIst(now) : !ok && result.reason === 'rate_limited' ? new Date(now.getTime() + 60_000) : null;
      await sql`insert into hf_usage (tenant_id, day, calls, input_tokens, output_tokens, errors, timeouts, credits_exhausted_until)
        values (${tenantId}, ${day}, 1, ${ok ? result.inputTokens : 0}, ${ok ? result.outputTokens : 0},
                ${!ok && result.reason !== 'timeout' ? 1 : 0}, ${!ok && result.reason === 'timeout' ? 1 : 0}, ${until})
        on conflict (tenant_id, day) do update set calls = hf_usage.calls + 1,
          input_tokens = hf_usage.input_tokens + excluded.input_tokens, output_tokens = hf_usage.output_tokens + excluded.output_tokens,
          errors = hf_usage.errors + excluded.errors, timeouts = hf_usage.timeouts + excluded.timeouts,
          credits_exhausted_until = coalesce(excluded.credits_exhausted_until, hf_usage.credits_exhausted_until), updated_at = now()`.execute(db);
      if (until) cache.set(tenantId, { at: Date.now(), until });
    },
    async resetCredits(now) {
      const r = await sql`update hf_usage set credits_exhausted_until = null, updated_at = now()
        where credits_exhausted_until is not null and credits_exhausted_until <= ${now}`.execute(db);
      cache.clear();
      return Number(r.numAffectedRows ?? 0);
    },
  };
}
