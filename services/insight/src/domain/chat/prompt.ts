// The planner request (LLD §4.2): rules, the compact catalogue, vocabulary values, today's IST date, the caller's
// role and the optional context code — plus the REDACTED question and the last 2 redacted turns. Never read-model
// rows, never contacts. Pure.
import { CATALOGUE } from '../plans/catalogue.js';
import type { PlanTemplateDef } from '../plans/types.js';
import { ACTION_CATALOGUE } from '../cards/actionCatalogue.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface PromptInput {
  question: string;
  history: { role: 'user' | 'assistant'; text: string }[];
  role: string;
  today: string;
  contextCode?: string | undefined;
  vocabulary: Readonly<Record<string, readonly string[]>>;
}

const VOCAB_FOR_MODEL = ['deal_type', 'market', 'segment', 'property_type', 'sale_mode', 'tenancy_status', 'furnishing', 'possession_status'];

function compact(t: PlanTemplateDef): string {
  const filters = t.filters.map((f) => `${f.field}[${f.ops.join('|')}]${f.values ? `{${f.values.join('|')}}` : ''}`).join(', ');
  const parts = [`${t.planId} (${t.kind}): ${t.description}`];
  if (filters) parts.push(`filters: ${filters}`);
  if (t.groupBy.length) parts.push(`groupBy: ${t.groupBy.map((g) => g.key).join('|')}`);
  if (t.metrics.length) parts.push(`metrics: ${t.metrics.join('|')}`);
  if (t.sort.length) parts.push(`sort: ${t.sort.join('|')}`);
  if (t.periodFields?.length) parts.push(`period fields: ${t.periodFields.map((p) => p.field).join('|')}`);
  if (t.meColumn) parts.push('me: allowed');
  return `- ${parts.join('; ')}`;
}

export function buildPlannerMessages(input: PromptInput): ChatMessage[] {
  const catalogue = CATALOGUE.filter((t) => t.roles.includes(input.role)).map(compact).join('\n');
  const vocab = VOCAB_FOR_MODEL.map((f) => `${f}: ${(input.vocabulary[f] ?? []).join(' | ')}`).join('\n');
  const actions = Object.values(ACTION_CATALOGUE)
    .filter((a) => a.roles.includes(input.role))
    .map((a) => `- ${a.cardType} ${a.title}: slots ${a.slots.map((s) => s.name).join(', ')}`)
    .join('\n');
  const system = [
    'You are the query planner of the 11 Estates CRM. You never answer from your own knowledge and never write facts.',
    'Reply with exactly one JSON object and nothing else:',
    '{"kind":"plan","planId":"<catalogue id>","params":{"filters":[{"field","op","value"}],"groupBy":[],"metrics":[{"fn","field"}],"sort":[{"field","dir"}],"period":{"preset","field"},"me":false,"export":false}}',
    '| {"kind":"action","cardType":"C-xx","slots":{...}} | {"kind":"navigate","planId":"open_my_queue"|"open_record","params":{"code":"DEM-000127"}}',
    '| {"kind":"clarify","question":"..."} | {"kind":"refusal"} for anything not about 11 Estates data (general knowledge, news, rates, weather, legal advice).',
    'Rules: use only stored values from the vocabulary below (never labels like "For Rent"); prices in INR integers ("3 Cr" = 30000000, "8.5 L" = 850000);',
    'areas in sq ft; BHK in steps of 0.5 ("1 RK" = 0.5); locality names exactly as the user wrote them; placeholders like ⟨PHONE_1⟩ are never filter values.',
    '"export"/"Excel"/"download" → params.export = true on a list plan. Periods: today, this_week, this_month, this_quarter, last_month, last_30_days, next_60_days.',
    `Today (IST): ${input.today}. Caller role: ${input.role}.${input.contextCode ? ` The user has ${input.contextCode} open ("this" refers to it).` : ''}`,
    'Catalogue (plans you may choose):',
    catalogue,
    'Vocabulary (stored values):',
    vocab,
    'Offer commercial_status: Upcoming | Available | Matched | In proposal | Site visit | In process | Closed | Inactive ("active" = all but Closed and Inactive).',
    'Life stages: Fresh | Ageing | Stale | Expired | Paused. Publication: Private | Anonymous | Public. Source types: Channel | Digi | Direct.',
    actions ? `Proposed actions (the user confirms them in the UI):\n${actions}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return [
    { role: 'system', content: system },
    ...input.history.slice(-2).map((h) => ({ role: h.role, content: h.text }) as ChatMessage),
    { role: 'user', content: input.question },
  ];
}
