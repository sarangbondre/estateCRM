// AskQuestion (LLD §4.1): redact → rules shortcut → plan (model | keyword fallback) → validate → execute → compose →
// stream → store. "The model plans, the service executes": the model only picks a catalogue plan; every fact in the
// answer comes from the read model through deterministic templates. Only redacted text is stored; the placeholder map
// lives in this request only (action-card payloads are refilled for the stream, stored with placeholders).
import { chunks, compose } from '../domain/answers/composer.js';
import { buildActionCard, codesOf } from '../domain/cards/cardBuilder.js';
import type { ProposedActionCard } from '../domain/cards/cardBuilder.js';
import { parsePlannerOutput } from '../domain/chat/modelOutput.js';
import type { PlannerDecision } from '../domain/chat/modelOutput.js';
import { CHAT_ALLOW_TERMS } from '../domain/chat/allowTerms.js';
import { buildPlannerMessages } from '../domain/chat/prompt.js';
import { istDay } from '../domain/dates.js';
import { parseKeywords } from '../domain/plans/keywordParser.js';
import type { QueryPlan } from '../domain/plans/types.js';
import type { ValidatedPlan } from '../domain/plans/validator.js';
import type { Dashboard, DashboardDeps } from './dashboards.js';
import { getDashboard } from './dashboards.js';
import type { CodeLookup, ConversationRepo, ConversationRow, Ids, NewMessage, Planner, Redactor, UsageMeter } from './ports.js';
import { execute, validateFor } from './queries.js';
import type { Caller, HowIGotThis, QueryDeps } from './queries.js';

export interface ChatDeps {
  query: QueryDeps;
  dashboards: DashboardDeps;
  planner: Planner;
  usage: UsageMeter;
  redactor: Redactor;
  conversations: ConversationRepo;
  codes: CodeLookup;
  ids: Ids;
}

export type StreamEvent =
  | { type: 'plan'; howIGotThis: HowIGotThis }
  | { type: 'token'; text: string }
  | { type: 'card'; card: Record<string, unknown> }
  | { type: 'done'; messageId: string; outcome: Outcome; fallbackUsed: boolean; model: string | null; timings: Timings }
  | { type: 'error'; code: 'query-timeout' | 'internal' | 'dependency-unavailable' | 'forbidden'; title: string; detail?: string; correlationId: string };

export type Outcome = 'answered' | 'action_proposed' | 'clarify' | 'refused';
export interface Timings {
  redactMs: number;
  planMs: number;
  queryMs: number;
  firstTokenMs: number;
  totalMs: number;
}

export interface AskInput {
  text: string;
  context?: { subjectType?: string; subjectCode?: string } | undefined;
  idempotencyKey?: string | null;
  correlationId: string;
  /** Wall-clock deadline (15 s stream cap). */
  deadline: number;
}

export const OUT_OF_SCOPE_TEXT = 'I can only answer from 11 Estates data.';
export const EXAMPLE_QUESTIONS = [
  'How many active 2BHK lease offers are there in Andheri West?',
  'Show demands in Sourcing for more than 7 days.',
  'Which Public offers turned Stale this week?',
];
const FALLBACK_TEXT = 'The assistant model is unavailable right now, so this answer comes from keyword matching.';

export class StreamTimeout extends Error {
  override readonly name = 'StreamTimeout';
}

interface Answer {
  text: string;
  cards: Record<string, unknown>[];
  /** Cards as streamed (placeholders refilled); `cards` keeps placeholders for storage. */
  streamCards: Record<string, unknown>[];
  howIGotThis: HowIGotThis | null;
  plan: QueryPlan | null;
  outcome: Outcome;
  queryMs: number;
  /** The keyword parser replaced an invalid model plan. */
  keywordUsed?: boolean;
}

const CODE = /^\s*([A-Z]{2,5}-\d{1,8})\s*$/i;

/** "/" quick actions and bare display codes (no model call). */
export function shortcut(text: string, counts: Record<string, number>): PlannerDecision | { kind: 'dashboard' } | { kind: 'review' } | null {
  const t = text.trim().toLowerCase();
  if (t === '/queue' || t.startsWith('/queue ')) return { kind: 'navigate', planId: 'open_my_queue' };
  if (t.startsWith('/add demand') || t.startsWith('/add supply')) {
    const slots: Record<string, string> = { side: t.startsWith('/add demand') ? 'Demand' : 'Supply' };
    const phone = /⟨PHONE_\d+⟩/.exec(text)?.[0];
    if (phone) slots['phone'] = phone;
    void counts;
    return { kind: 'action', cardType: 'C-06', slots };
  }
  if (t === '/review' || t.startsWith('/review ')) return { kind: 'review' };
  if (t === '/dashboard' || t.startsWith('/dashboard ')) return { kind: 'dashboard' };
  const code = CODE.exec(text)?.[1];
  if (code) return { kind: 'navigate', planId: 'open_record', code: code.toUpperCase() };
  return null;
}

const PANEL_OF: Record<string, { panel: string; targetService: string; targetOperation: string }> = {
  offer: { panel: 'P-02', targetService: 'records', targetOperation: 'getOffer' },
  demand: { panel: 'P-03', targetService: 'records', targetOperation: 'getDemand' },
  project: { panel: 'P-05', targetService: 'records', targetOperation: 'getProject' },
  desk_item: { panel: 'P-08', targetService: 'records', targetOperation: 'getDeskItem' },
};

export async function askQuestion(
  deps: ChatDeps,
  caller: Caller,
  conversation: ConversationRow,
  input: AskInput,
  emit: (e: StreamEvent) => void,
): Promise<{ messageId: string; outcome: Outcome | 'error' }> {
  const now = () => deps.query.clock.now();
  const started = Date.now();
  const check = () => {
    if (Date.now() > input.deadline) throw new StreamTimeout('stream cap reached');
  };
  const timings: Timings = { redactMs: 0, planMs: 0, queryMs: 0, firstTokenMs: 0, totalMs: 0 };
  const [vocabulary, locations] = await Promise.all([deps.query.refs.vocabulary(caller.tenantId), deps.query.refs.locations(caller.tenantId)]);

  // 1 redact (localities, vocabulary values and codes are allow-listed)
  const allow = [...CHAT_ALLOW_TERMS, ...Object.values(vocabulary.values).flat(), ...[...locations.values()].map((l) => l.name)];
  const red = deps.redactor.redact(input.text, allow);
  timings.redactMs = Date.now() - started;
  const assistantId = deps.ids.uuid();
  const userMessage: NewMessage = { id: deps.ids.uuid(), role: 'user', text: red.text, redactionCounts: red.counts, idempotencyKey: input.idempotencyKey ?? null };
  const restore = (s: string) => deps.redactor.restore(s, red.mapping);

  let fallbackUsed = false;
  let model: string | null = null;
  let answer: Answer;
  try {
    // 2 rules shortcut → 3 plan
    const planStarted = Date.now();
    const quick = shortcut(red.text, red.counts);
    let decision: PlannerDecision | { kind: 'dashboard' } | { kind: 'review' } | null = quick;
    const keyword = () => parseKeywords(red.text, { now: now(), vocabulary: vocabulary.values, locations: [...locations.keys()] });
    if (!decision) {
      const exhausted = await deps.usage.creditsExhausted(caller.tenantId, now());
      const result = exhausted
        ? ({ ok: false, reason: 'credits' } as const)
        : await deps.planner.plan({
            tenantId: caller.tenantId,
            messages: buildPlannerMessages({
              question: red.text,
              history: await deps.conversations.history(caller.tenantId, conversation.id, 2),
              role: caller.role,
              today: istDay(now()),
              contextCode: input.context?.subjectCode,
              vocabulary: vocabulary.values,
            }),
          });
      if (!exhausted) await deps.usage.record(caller.tenantId, now(), result);
      const parsed = result.ok ? parsePlannerOutput(result.text) : null;
      if (result.ok && parsed) {
        decision = parsed;
        model = result.model;
      } else {
        fallbackUsed = true;
        decision = keyword() ?? { kind: 'refusal' };
      }
    }
    timings.planMs = Date.now() - planStarted;
    check();

    // 4–6 validate, execute, compose
    answer = await decide(deps, caller, decision, { red, restore, keyword, fallbackUsed, now: now(), check });
    fallbackUsed = fallbackUsed || !!answer.keywordUsed;
  } catch (err) {
    const timeout = err instanceof StreamTimeout || (err as { code?: string }).code === 'query-timeout';
    emit({
      type: 'error',
      code: timeout ? 'query-timeout' : 'internal',
      title: timeout ? 'The answer took too long' : 'Something went wrong',
      correlationId: input.correlationId,
    });
    await deps.conversations.saveExchange(
      caller.tenantId,
      conversation.id,
      [userMessage, { id: assistantId, role: 'assistant', text: '', outcome: 'error', fallbackUsed, model, timings: { ...timings, totalMs: Date.now() - started } }],
      titleOf(red.text),
      now(),
    );
    return { messageId: assistantId, outcome: 'error' };
  }

  // 7 stream: plan → tokens → cards → done
  if (answer.howIGotThis) emit({ type: 'plan', howIGotThis: answer.howIGotThis });
  timings.firstTokenMs = Date.now() - started;
  timings.queryMs = answer.queryMs;
  for (const piece of chunks(answer.text)) emit({ type: 'token', text: piece });
  const fallbackCard = fallbackUsed ? [{ kind: 'notice', cardId: deps.ids.uuid(), notice: 'model_unavailable_keyword_fallback', text: FALLBACK_TEXT }] : [];
  for (const card of [...answer.streamCards, ...fallbackCard]) emit({ type: 'card', card });
  timings.totalMs = Date.now() - started;

  // 8 store (redacted text, cards with placeholders)
  await deps.conversations.saveExchange(
    caller.tenantId,
    conversation.id,
    [
      userMessage,
      {
        id: assistantId,
        role: 'assistant',
        text: answer.text,
        ...(answer.plan ? { plan: answer.plan } : {}),
        ...(answer.howIGotThis ? { howIGotThis: { ...answer.howIGotThis, fallbackUsed } } : {}),
        cards: [...answer.cards, ...fallbackCard],
        outcome: answer.outcome,
        fallbackUsed,
        model,
        timings: { ...timings },
      },
    ],
    titleOf(red.text),
    now(),
  );
  emit({ type: 'done', messageId: assistantId, outcome: answer.outcome, fallbackUsed, model, timings });
  return { messageId: assistantId, outcome: answer.outcome };
}

export function titleOf(redacted: string): string {
  const t = redacted.replace(/\s+/g, ' ').trim();
  return t.length > 80 ? `${t.slice(0, 79)}…` : t || 'New chat';
}

interface DecideCtx {
  red: { text: string; counts: Record<string, number>; mapping: ReadonlyMap<string, string> };
  restore: (s: string) => string;
  keyword: () => PlannerDecision | null;
  fallbackUsed: boolean;
  now: Date;
  check: () => void;
}

async function decide(
  deps: ChatDeps,
  caller: Caller,
  decision: PlannerDecision | { kind: 'dashboard' } | { kind: 'review' },
  ctx: DecideCtx,
): Promise<Answer> {
  const id = () => deps.ids.uuid();
  const notice = (n: string, text: string, suggestions?: string[]) => ({
    kind: 'notice',
    cardId: id(),
    notice: n,
    text,
    ...(suggestions?.length ? { suggestions: suggestions.slice(0, 5) } : {}),
  });
  const simple = (text: string, card: Record<string, unknown>, outcome: Outcome, streamCard = card): Answer => ({
    text,
    cards: [card],
    streamCards: [streamCard],
    howIGotThis: null,
    plan: null,
    outcome,
    queryMs: 0,
  });

  switch (decision.kind) {
    case 'refusal':
      return simple(OUT_OF_SCOPE_TEXT, notice('out_of_scope', OUT_OF_SCOPE_TEXT, EXAMPLE_QUESTIONS), 'refused');
    case 'clarify':
      return simple(decision.question, notice('clarify', decision.question), 'clarify');
    case 'review':
      return simple(
        'Opening the review queue.',
        { kind: 'navigate', cardId: id(), panel: 'P-07', subjectCode: null, targetService: 'intake', targetOperation: 'listReviewItems', params: { status: 'open' } },
        'answered',
      );
    case 'dashboard': {
      const name = caller.role === 'Data operator' ? 'quality' : 'demand';
      const r = await getDashboard(deps.dashboards, caller.tenantId, name, {});
      const headline = r.ok ? headlineOf(r.dashboard) : [];
      return simple(`Here is the ${name} dashboard.`, { kind: 'dashboard', cardType: 'C-20', cardId: id(), dashboard: name, headline }, 'answered');
    }
    case 'navigate': {
      if (decision.planId === 'open_my_queue')
        return simple(
          'Opening your queue.',
          { kind: 'navigate', cardId: id(), panel: 'P-01', subjectCode: null, targetService: 'journeys', targetOperation: 'getMyQueue', params: {} },
          'answered',
        );
      const code = decision.code ?? '';
      const found = (await deps.codes.resolve(caller.tenantId, [code])).get(code);
      if (!found) return simple(`I couldn’t find ${code}.`, notice('clarify', `I couldn’t find ${code}. Check the code and try again.`), 'clarify');
      const target = PANEL_OF[found.kind] ?? PANEL_OF['offer'];
      return simple(`Opening ${code}.`, { kind: 'navigate', cardId: id(), ...target, subjectCode: code, params: { idOrCode: code } }, 'answered');
    }
    case 'action': {
      const codes = codesOf(decision.cardType, decision.slots);
      const subjects = await deps.codes.resolve(caller.tenantId, codes);
      const built = buildActionCard(decision.cardType, decision.slots, subjects, { role: caller.role, cardId: id(), idempotencyKey: id(), now: ctx.now });
      if (!built.ok) return simple(built.text, notice(built.notice, built.text), 'clarify');
      const streamed: ProposedActionCard = { ...built.card, payload: refill(built.card.payload, ctx.restore) };
      return {
        text: built.card.summary,
        cards: [built.card as unknown as Record<string, unknown>],
        streamCards: [streamed as unknown as Record<string, unknown>],
        howIGotThis: null,
        plan: null,
        outcome: 'action_proposed',
        queryMs: 0,
      };
    }
    case 'plan':
      return answerPlan(deps, caller, decision, ctx, notice);
  }
}

function headlineOf(d: Dashboard): Record<string, unknown>[] {
  return d.sections
    .flatMap((s) => s.tiles)
    .filter((t): t is Extract<typeof t, { value: number | null }> => 'value' in t && !('cells' in t))
    .slice(0, 6)
    .map((t) => ({ tileId: t.tileId, title: t.title, value: t.value, unit: t.unit }));
}

function refill(payload: Record<string, unknown>, restore: (s: string) => string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, typeof v === 'string' ? restore(v) : v]));
}

async function answerPlan(
  deps: ChatDeps,
  caller: Caller,
  decision: Extract<PlannerDecision, { kind: 'plan' }>,
  ctx: DecideCtx,
  notice: (n: string, text: string, suggestions?: string[]) => Record<string, unknown>,
): Promise<Answer> {
  const id = () => deps.ids.uuid();
  let current = decision;
  let checked = await validateFor(deps.query, caller, current.plan);
  if (!checked.result.ok && !ctx.fallbackUsed) {
    // Invalid model plan → the keyword parser once (LLD §4.1 step 4).
    const kw = ctx.keyword();
    if (kw?.kind === 'plan') {
      current = kw;
      checked = await validateFor(deps.query, caller, current.plan);
    }
  }
  const r = checked.result;
  if (!r.ok) {
    if (r.errors.some((e) => e.code === 'placeholder-not-allowed') || (ctx.red.counts['PHONE'] ?? 0) > 0) {
      const phone = /⟨PHONE_\d+⟩/.exec(ctx.red.text)?.[0] ?? null;
      const stored = { kind: 'navigate', cardId: id(), panel: 'P-04', subjectCode: null, targetService: 'records', targetOperation: 'quickAddLookup', params: { phone } };
      const text = 'Contact details are not in the analytics data. Look the person up in records instead.';
      return { text, cards: [stored], streamCards: [{ ...stored, params: { phone: phone ? ctx.restore(phone) : null } }], howIGotThis: null, plan: null, outcome: 'answered', queryMs: 0 };
    }
    if (r.code === 'not-allowed-for-role') {
      const text = r.errors[0]?.message ?? 'That question isn’t available to your role.';
      return { text, cards: [notice('not_allowed_for_role', text)], streamCards: [notice('not_allowed_for_role', text)], howIGotThis: null, plan: null, outcome: 'refused', queryMs: 0 };
    }
    if (r.code === 'plan-not-in-catalogue') {
      return { text: OUT_OF_SCOPE_TEXT, cards: [notice('out_of_scope', OUT_OF_SCOPE_TEXT, EXAMPLE_QUESTIONS)], streamCards: [notice('out_of_scope', OUT_OF_SCOPE_TEXT, EXAMPLE_QUESTIONS)], howIGotThis: null, plan: null, outcome: 'refused', queryMs: 0 };
    }
    const text = `I need a bit more detail: ${r.errors.map((e) => e.message).slice(0, 2).join('; ')}.`;
    const card = notice('clarify', text, r.errors.map((e) => e.message));
    return { text, cards: [card], streamCards: [card], howIGotThis: null, plan: null, outcome: 'clarify', queryMs: 0 };
  }
  const v: ValidatedPlan = r.value;
  if (v.template.kind === 'navigate' || v.template.kind === 'export') {
    const text = OUT_OF_SCOPE_TEXT;
    const card = notice('clarify', 'Ask for a list to export, e.g. “all industrial galas for lease in Bhiwandi as an Excel file”.');
    return { text, cards: [card], streamCards: [card], howIGotThis: null, plan: null, outcome: 'clarify', queryMs: 0 };
  }
  ctx.check();
  const q0 = Date.now();
  const { result, exec } = await execute(deps.query, caller, v, {
    limit: v.template.kind === 'list' ? 25 : v.template.maxRows,
    withTotal: v.template.kind === 'list',
    vocabularyVersion: checked.vocabularyVersion,
    fallbackUsed: ctx.fallbackUsed || current !== decision,
  });
  const queryMs = Date.now() - q0;
  const composed = compose(v, result.rows, exec.total, exec.capped, current.exportRequested);
  const cards: Record<string, unknown>[] = [
    { kind: 'answer', cardType: 'C-02', cardId: id(), text: composed.text, figures: composed.figures },
  ];
  if (composed.table) cards.push({ kind: 'table', cardType: 'C-03', cardId: id(), result, exportable: v.template.kind === 'list' });
  if (composed.empty) cards.push(notice('no_results', 'No matching records.', composed.suggestions));
  if (v.template.kind === 'list' && (exec.total ?? 0) > 25 && !current.exportRequested)
    cards.push(notice('too_many_rows_use_export', 'More than 25 rows: open the table in the panel or export it to Excel.'));
  return {
    text: composed.text,
    cards,
    streamCards: cards,
    howIGotThis: result.howIGotThis,
    plan: result.howIGotThis.plan,
    outcome: 'answered',
    queryMs,
    keywordUsed: current !== decision,
  };
}
