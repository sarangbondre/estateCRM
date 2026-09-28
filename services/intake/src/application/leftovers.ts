// Leftover classification (LLD §4.7 step 6, §4.8, ADR-0004): rows whose scope, deal type or side the rules could not
// fill. Their text is REDACTED first (@11e/redaction); text that still fails the post-check (≥ 7-digit run or "@") is
// never sent (review `redaction_uncertain`). The rest goes to the model in batches of 20. Unavailable model →
// `model_unavailable`; confidence < 0.70 → `low_confidence` (suggestion kept for the reviewer). Processing continues.
import { redact } from '@11e/redaction';
import { LOW_CONFIDENCE, mergeSuggestion, validateModelOutput } from '../domain/model-output.js';
import { intakeReason } from '../domain/reasons.js';
import { classificationOf } from '../domain/rows.js';
import type { NormalisedRow } from '../domain/rows.js';
import type { App } from './context.js';
import { ModelUnavailableError } from './ports.js';
import type { ModelOutput } from './ports.js';

export const MODEL_BATCH = 20;

export interface LeftoverResult {
  /** Rows whose classification came (partly) from the model. */
  usedModel: Set<NormalisedRow>;
  /** Model suggestion per row, for the review item. */
  suggestions: Map<NormalisedRow, Record<string, unknown>>;
}

export async function classifyLeftovers(app: App, rows: readonly NormalisedRow[]): Promise<LeftoverResult> {
  const result: LeftoverResult = { usedModel: new Set(), suggestions: new Map() };
  const items: { row: NormalisedRow; id: string; text: string }[] = [];
  for (const row of rows) {
    const r = redact(row.classifierText ?? '');
    if (r.uncertain) row.reasons.push({ code: 'other', detail: 'redaction_uncertain' });
    else items.push({ row, id: String(items.length + 1), text: r.text });
  }
  for (let i = 0; i < items.length; i += MODEL_BATCH) {
    const batch = items.slice(i, i + MODEL_BATCH);
    let outputs: ModelOutput[];
    try {
      outputs = await app.model.classify(batch.map(({ id, text }) => ({ id, text })));
    } catch (err) {
      if (!(err instanceof ModelUnavailableError)) throw err;
      for (const { row } of batch) row.reasons.push(intakeReason('model_unavailable'));
      continue;
    }
    const byId = new Map(outputs.map((o, k) => [typeof o.id === 'string' ? o.id : String(batch[k]?.id), o]));
    for (const { row, id } of batch) {
      const out = byId.get(id);
      if (!out) {
        row.reasons.push(intakeReason('low_confidence'));
        continue;
      }
      const s = validateModelOutput(out as Record<string, unknown>);
      result.suggestions.set(row, { ...s.classification, confidence: s.confidence });
      const merged =
        s.confidence >= LOW_CONFIDENCE
          ? mergeSuggestion(classificationOf(row.fields), s.classification)
          : undefined;
      if (!merged) {
        row.reasons.push(intakeReason('low_confidence'));
        continue;
      }
      Object.assign(row.fields, merged);
      result.usedModel.add(row);
    }
  }
  return result;
}
