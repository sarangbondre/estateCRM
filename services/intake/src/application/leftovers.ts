// Leftover classification (LLD §4.7 step 6, §4.8): rows whose scope, deal type or side the rules could not fill.
// Without a model every leftover row goes to review with `model_unavailable` (processing continues).
import { intakeReason } from '../domain/reasons.js';
import type { NormalisedRow } from '../domain/rows.js';
import type { App } from './context.js';

export interface LeftoverResult {
  /** Rows whose classification came (partly) from the model. */
  usedModel: Set<NormalisedRow>;
  /** Model suggestion per row, for the review item (null = none). */
  suggestions: Map<NormalisedRow, Record<string, unknown>>;
}

export async function classifyLeftovers(app: App, rows: readonly NormalisedRow[]): Promise<LeftoverResult> {
  void app;
  for (const row of rows) row.reasons.push(intakeReason('model_unavailable'));
  return { usedModel: new Set(), suggestions: new Map() };
}
