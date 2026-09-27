// Pure logic for the insight cards (no React): the SSE stream parser and answer reducer for chat (C-02/C-03,
// contracts/openapi/insight.yaml postMessage), message part → view mapping, "How I got this" lines (R-CHAT-2),
// proposed-action request building (R-CHAT-1), dashboard tabs by role (P-06, x-roles), table sort/filter (P-07) and
// export status helpers (US-32).
import type { components } from '@11e/contracts/insight';

type S = components['schemas'];
/** openapi-typescript rewrites `kind` discriminators to schema names; on the wire they are the contract consts. */
type WithKind<T, K extends string> = Omit<T, 'kind'> & { kind: K };

export type HowIGotThisData = S['HowIGotThis'];
export type QueryPlan = S['QueryPlan'];
export type QueryResult = S['QueryResult'];
export type Column = QueryResult['columns'][number];
export type Row = QueryResult['rows'][number];
export type Tile = S['Tile'];
export type GridTile = S['GridTile'];
export type Dashboard = S['Dashboard'];
export type Export = S['Export'];

export type AnswerPart = WithKind<S['AnswerCard'], 'answer'>;
export type TablePart = WithKind<S['TableCard'], 'table'>;
export type DashboardPart = WithKind<S['DashboardSummaryCard'], 'dashboard'>;
export type NoticePart = WithKind<S['NoticeCard'], 'notice'>;
export type NavigatePart = WithKind<S['NavigateCard'], 'navigate'>;
export type ActionPart = WithKind<S['ProposedActionCard'], 'action'>;
export type MessagePart = AnswerPart | TablePart | DashboardPart | NoticePart | NavigatePart | ActionPart;

// ------------------------------------------------------------------ SSE parsing

export interface SseFrame {
  event: string;
  data: string;
  id?: string;
}

/**
 * Incremental text/event-stream parser (WHATWG rules we need): frames end at a blank line; `event:`, `data:` (several
 * data lines join with "\n"), `id:`; lines starting with ":" are comments; CRLF, CR and LF all end a line. Chunks may
 * split anywhere, including inside a line or between "\r" and "\n".
 */
export function createSseParser() {
  let buffer = '';
  let event = '';
  let data: string[] = [];
  let id: string | undefined;
  let hasData = false;

  const dispatch = (out: SseFrame[]) => {
    if (hasData) out.push({ event: event || 'message', data: data.join('\n'), ...(id !== undefined ? { id } : {}) });
    event = '';
    data = [];
    hasData = false;
  };

  const line = (l: string, out: SseFrame[]) => {
    if (l === '') return dispatch(out);
    if (l.startsWith(':')) return;
    const colon = l.indexOf(':');
    const field = colon < 0 ? l : l.slice(0, colon);
    let value = colon < 0 ? '' : l.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') {
      data.push(value);
      hasData = true;
    } else if (field === 'id') id = value;
  };

  return {
    push(chunk: string): SseFrame[] {
      const out: SseFrame[] = [];
      buffer += chunk;
      for (;;) {
        const m = /\r\n|\r|\n/.exec(buffer);
        if (!m) break;
        // A trailing lone "\r" may be the first half of "\r\n": wait for the next chunk.
        if (m[0] === '\r' && m.index === buffer.length - 1) break;
        line(buffer.slice(0, m.index), out);
        buffer = buffer.slice(m.index + m[0].length);
      }
      return out;
    },
    /** End of stream: a last frame without the closing blank line still counts. */
    flush(): SseFrame[] {
      const out: SseFrame[] = [];
      if (buffer) line(buffer.replace(/\r$/, ''), out);
      buffer = '';
      dispatch(out);
      return out;
    },
  };
}

export type StreamEvent =
  | { type: 'plan'; howIGotThis: HowIGotThisData }
  | { type: 'token'; text: string }
  | { type: 'card'; card: MessagePart }
  | {
      type: 'done';
      messageId: string;
      fallbackUsed: boolean;
      outcome?: string;
      model?: string | null;
      timings?: Record<string, number>;
    }
  | { type: 'error'; code: string; title: string; detail?: string; correlationId?: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One SSE frame → a typed stream event; unknown or malformed frames → null (ignored). */
export function toStreamEvent(frame: SseFrame): StreamEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(frame.data);
  } catch {
    return frame.event === 'token' ? { type: 'token', text: frame.data } : null;
  }
  if (!isObj(data)) return null;
  const type = frame.event !== 'message' ? frame.event : String(data.type ?? '');
  switch (type) {
    case 'plan':
      return isObj(data.howIGotThis) ? { type, howIGotThis: data.howIGotThis as unknown as HowIGotThisData } : null;
    case 'token':
      return typeof data.text === 'string' ? { type, text: data.text } : null;
    case 'card':
      return isObj(data.card) && typeof data.card.kind === 'string'
        ? { type, card: data.card as unknown as MessagePart }
        : null;
    case 'done':
      return {
        type,
        messageId: String(data.messageId ?? ''),
        fallbackUsed: data.fallbackUsed === true,
        ...(typeof data.outcome === 'string' ? { outcome: data.outcome } : {}),
        ...(typeof data.model === 'string' || data.model === null ? { model: data.model as string | null } : {}),
        ...(isObj(data.timings) ? { timings: data.timings as Record<string, number> } : {}),
      };
    case 'error':
      return {
        type,
        code: String(data.code ?? 'internal'),
        title: String(data.title ?? 'The answer failed'),
        ...(typeof data.detail === 'string' ? { detail: data.detail } : {}),
        ...(typeof data.correlationId === 'string' ? { correlationId: data.correlationId } : {}),
      };
    default:
      return null;
  }
}

// ------------------------------------------------------------------ answer state

export interface AnswerState {
  status: 'idle' | 'streaming' | 'done' | 'error';
  text: string;
  how: HowIGotThisData | null;
  parts: MessagePart[];
  messageId?: string;
  fallbackUsed?: boolean;
  outcome?: string;
  error?: { code: string; title: string; detail?: string; correlationId?: string; retryable: boolean };
}

export const initialAnswer: AnswerState = { status: 'idle', text: '', how: null, parts: [] };

/** Applies one stream event. Tokens append; cards dedupe on cardId (an idempotent replay re-sends them). */
export function applyStreamEvent(state: AnswerState, ev: StreamEvent): AnswerState {
  if (state.status === 'done' || state.status === 'error') return state;
  switch (ev.type) {
    case 'plan':
      return { ...state, status: 'streaming', how: ev.howIGotThis };
    case 'token':
      return { ...state, status: 'streaming', text: state.text + ev.text };
    case 'card': {
      const id = ev.card.cardId;
      const parts = id && state.parts.some((p) => p.cardId === id) ? state.parts : [...state.parts, ev.card];
      return { ...state, status: 'streaming', parts };
    }
    case 'done':
      return {
        ...state,
        status: 'done',
        messageId: ev.messageId,
        fallbackUsed: ev.fallbackUsed,
        ...(ev.outcome ? { outcome: ev.outcome } : {}),
      };
    case 'error':
      return {
        ...state,
        status: 'error',
        error: {
          code: ev.code,
          title: chatErrorText(ev.code, ev.title),
          ...(ev.detail ? { detail: ev.detail } : {}),
          ...(ev.correlationId ? { correlationId: ev.correlationId } : {}),
          retryable: ev.code !== 'forbidden',
        },
      };
  }
}

/** True once there is something to show instead of the typing indicator. */
export const hasContent = (s: AnswerState): boolean => s.text.length > 0 || s.parts.length > 0;

/** Non-streaming fallback: a JSON Message (as listMessages returns it) → the final answer state. */
export function answerFromMessage(msg: unknown): AnswerState | null {
  if (!isObj(msg) || typeof msg.text !== 'string') return null;
  const parts = Array.isArray(msg.cards) ? (msg.cards.filter((c) => isObj(c) && typeof c.kind === 'string') as MessagePart[]) : [];
  const failed = msg.status === 'error';
  return {
    status: failed ? 'error' : 'done',
    text: msg.text,
    how: isObj(msg.howIGotThis) ? (msg.howIGotThis as unknown as HowIGotThisData) : null,
    parts,
    ...(typeof msg.messageId === 'string' ? { messageId: msg.messageId } : {}),
    fallbackUsed: msg.fallbackUsed === true,
    ...(failed ? { error: { code: 'internal', title: 'The answer failed.', retryable: true } } : {}),
  };
}

/** Friendly text for chat errors (HTTP problem codes and stream error codes). */
export function chatErrorText(code: string, fallback?: string): string {
  switch (code) {
    case 'rate-limited':
      return 'One chat answer at a time (and at most 30 questions a minute). Wait for the current answer, then try again.';
    case 'query-timeout':
    case 'client-timeout':
      return 'The answer took longer than 15 seconds and was stopped. Try again, or ask a narrower question.';
    case 'dependency-unavailable':
      return 'The data service is not reachable right now. Try again shortly.';
    case 'forbidden':
      return 'Your role cannot see this data.';
    case 'payload-too-large':
      return 'The question is too long (2,000 characters at most).';
    case 'stream-incomplete':
      return 'The answer stopped before it finished. Try again.';
    default:
      return fallback || 'The answer failed. Try again.';
  }
}

// ------------------------------------------------------------------ message parts → views

export type PartView =
  | { view: 'answer'; part: AnswerPart }
  | { view: 'table'; part: TablePart }
  | { view: 'dashboard'; part: DashboardPart }
  | { view: 'notice'; part: NoticePart }
  | { view: 'navigate'; part: NavigatePart; panel: { kind: string; title: string; props: Record<string, unknown> } | null }
  | { view: 'action'; part: ActionPart }
  | { view: 'unknown'; kind: string };

/** PRD §5.4 panels → UI panel kinds (P-02…P-05 need a record code). */
const PANEL_KINDS: Record<string, { kind: string; title: string } | 'record'> = {
  'P-01': { kind: 'queue', title: 'My queue' },
  'P-02': 'record',
  'P-03': 'record',
  'P-04': 'record',
  'P-05': 'record',
  'P-06': { kind: 'dashboards', title: 'Dashboards' },
  'P-07': { kind: 'table', title: 'Table' },
  'P-08': { kind: 'desks', title: 'Desks & Watchlist' },
};

const RECORD_PANEL: Record<string, string> = {
  INV: 'offer',
  DEM: 'demand',
  PER: 'person',
  PRJ: 'project',
  PRP: 'property',
};

export function navigatePanel(part: Pick<NavigatePart, 'panel' | 'subjectCode' | 'params'>) {
  const target = PANEL_KINDS[part.panel];
  if (!target) return null;
  if (target === 'record') {
    const code = part.subjectCode ?? '';
    const kind = RECORD_PANEL[code.split('-')[0] ?? ''];
    return kind ? { kind, title: code, props: { code } as Record<string, unknown> } : null;
  }
  return { ...target, props: { ...(isObj(part.params) ? part.params : {}) } };
}

export function viewForPart(part: MessagePart | { kind?: unknown }): PartView {
  const p = part as MessagePart;
  switch (p.kind) {
    case 'answer':
      return { view: 'answer', part: p };
    case 'table':
      return isObj(p.result) ? { view: 'table', part: p } : { view: 'unknown', kind: 'table' };
    case 'dashboard':
      return { view: 'dashboard', part: p };
    case 'notice':
      return { view: 'notice', part: p };
    case 'navigate':
      return { view: 'navigate', part: p, panel: navigatePanel(p) };
    case 'action':
      return { view: 'action', part: p };
    default:
      return { view: 'unknown', kind: String((part as { kind?: unknown }).kind ?? 'unknown') };
  }
}

/** "How I got this" lines (R-CHAT-2): description, plan, filters, rows, freshness, versions, legacy terms. */
export function howParts(how: HowIGotThisData | null | undefined): string[] {
  if (!how) return [];
  const out: string[] = [];
  if (how.description) out.push(how.description);
  if (how.plan?.planId) out.push(`plan ${how.plan.planId} v${how.plan.templateVersion ?? '?'}`);
  for (const f of how.filtersApplied ?? []) {
    const name = f.label || f.field;
    if (name) out.push(`${name} = ${f.value ?? '—'}`);
  }
  if (!how.filtersApplied?.length)
    for (const f of how.plan?.filters ?? []) out.push(`${f.field} ${f.op} ${JSON.stringify(f.value)}`);
  if (how.plan?.groupBy?.length) out.push(`grouped by ${how.plan.groupBy.join(', ')}`);
  if (typeof how.rowCount === 'number') out.push(`${how.rowCount} row${how.rowCount === 1 ? '' : 's'}`);
  if (how.dataAsOf) out.push(`data as of ${how.dataAsOf.replace('T', ' ').slice(0, 16)}`);
  if (how.catalogueVersion || how.vocabularyVersion)
    out.push(`catalogue ${how.catalogueVersion ?? '?'} · vocabulary ${how.vocabularyVersion ?? '?'}`);
  for (const t of how.translatedTerms ?? []) out.push(t);
  return [...new Set(out)];
}

export const howNote = (how: HowIGotThisData | null | undefined, fallbackUsed?: boolean): string | undefined =>
  how?.fallbackUsed || fallbackUsed
    ? 'The AI model was unavailable, so a keyword parser built this query.'
    : how
      ? `Source: ${how.source}.`
      : undefined;

// ------------------------------------------------------------------ proposed actions (R-CHAT-1)

export interface ActionRequest {
  method: 'POST' | 'PUT' | 'PATCH';
  path: string;
  body: Record<string, unknown>;
  idempotencyKey: string;
  ifMatch?: string;
  contentType: string;
}

const SAFE_PATH = /^\/v1\/[A-Za-z0-9\-._~%/:@]+$/;

/**
 * The request a proposed-action card sends through web's gateway on click. Only `editableFields` can be changed by the
 * person; the card's pre-generated Idempotency-Key is reused so a double click cannot apply twice. Returns an error
 * string when the card is not safe to send (method or path outside the gateway's /v1 space).
 */
export function buildActionRequest(card: ActionPart, edits: Record<string, unknown> = {}): ActionRequest | string {
  const method = String(card.method ?? '').toUpperCase();
  if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') return `Unsupported method ${card.method}.`;
  const path = String(card.path ?? '');
  if (!SAFE_PATH.test(path) || path.includes('..') || path.includes('//')) return 'The proposed action has an invalid path.';
  if (!card.idempotencyKey) return 'The proposed action has no idempotency key.';
  const editable = new Set(card.editableFields ?? []);
  const body: Record<string, unknown> = { ...(isObj(card.payload) ? card.payload : {}) };
  for (const [k, v] of Object.entries(edits)) if (editable.has(k)) body[k] = v;
  return {
    method,
    path,
    body,
    idempotencyKey: card.idempotencyKey,
    ...(card.ifMatch != null && card.ifMatch !== '' ? { ifMatch: card.ifMatch } : {}),
    contentType: method === 'PATCH' ? 'application/merge-patch+json' : 'application/json',
  };
}

export type ActionAvailability = { ok: true } | { ok: false; reason: string };

export function actionAvailability(card: Pick<ActionPart, 'allowedRoles' | 'expiresAt'>, role: string, now = Date.now()): ActionAvailability {
  const roles = Array.isArray(card.allowedRoles) ? card.allowedRoles : [];
  if (roles.length && !roles.includes(role)) return { ok: false, reason: `Your role (${role}) cannot do this.` };
  const exp = Date.parse(card.expiresAt ?? '');
  if (Number.isFinite(exp) && exp < now)
    return { ok: false, reason: 'This proposal is older than 30 minutes. Ask again to get it with the current state.' };
  return { ok: true };
}

/** Payload value → editable input kind; objects and arrays are shown read-only. */
export function fieldKind(v: unknown): 'text' | 'number' | 'boolean' | 'readonly' {
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string' || v === null || v === undefined) return 'text';
  return 'readonly';
}

export const humanize = (key: string): string =>
  key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());

// ------------------------------------------------------------------ dashboards (P-06, C-20)

export type DashboardKey = Dashboard['dashboard'];

export interface DashboardTab {
  key: DashboardKey;
  label: string;
  roles: readonly string[];
}

const STAFF = ['Admin', 'Manager', 'Demand agent', 'Supply agent'] as const;

/** Tabs in the prototype's order with each endpoint's x-roles (Data operators only see Data quality). */
export const DASHBOARD_TABS: readonly DashboardTab[] = [
  { key: 'demand', label: 'Demand', roles: STAFF },
  { key: 'supply', label: 'Supply', roles: STAFF },
  { key: 'scopes', label: 'Other scopes', roles: STAFF },
  { key: 'quality', label: 'Data quality', roles: [...STAFF, 'Data operator'] },
];

export const dashboardTabsFor = (role: string | null | undefined): DashboardTab[] =>
  DASHBOARD_TABS.filter((t) => !!role && t.roles.includes(role));

export const isGridTile = (t: Tile | GridTile): t is GridTile =>
  Array.isArray((t as GridTile).cells) && Array.isArray((t as GridTile).rows) && Array.isArray((t as GridTile).columns);

/** Bar widths (0–100 %) relative to the largest value; negatives and non-numbers count as 0. */
export function barWidths(values: readonly (number | null | undefined)[]): number[] {
  const clean = values.map((v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0));
  const max = Math.max(0, ...clean);
  return clean.map((v) => (max ? Math.round((v / max) * 1000) / 10 : 0));
}

/** The question sent to chat for a tile without a drill-down plan ("every tile opens the list"). */
export const tileQuestion = (dashboard: string, tile: string, part?: string): string =>
  `List ${part ? `${part} ` : ''}${tile}`.replace(/\s+/g, ' ').trim() + ` (${dashboard} dashboard)`;

// ------------------------------------------------------------------ tables (C-03, P-07)

export type SortDir = 'asc' | 'desc';

const NUMERIC = new Set(['number', 'integer', 'inr']);

function compare(a: unknown, b: unknown, type: string): number {
  const na = a === null || a === undefined || a === '';
  const nb = b === null || b === undefined || b === '';
  if (na || nb) return na === nb ? 0 : na ? 1 : -1;
  if (NUMERIC.has(type)) return Number(a) - Number(b);
  if (type === 'boolean') return Number(a === true) - Number(b === true);
  return String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
}

/** Stable sort by one column; empty values always last. */
export function sortRows(rows: readonly Row[], key: string, dir: SortDir, type = 'string'): Row[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((x, y) => {
      const c = compare(x.r[key], y.r[key], type);
      const empty = (v: unknown) => v === null || v === undefined || v === '';
      if (empty(x.r[key]) || empty(y.r[key])) return c || x.i - y.i;
      return (dir === 'asc' ? c : -c) || x.i - y.i;
    })
    .map((x) => x.r);
}

/** Case-insensitive "contains" filter on one stored column (or all columns when `key` is empty). */
export function filterRows(rows: readonly Row[], columns: readonly Column[], key: string, text: string): Row[] {
  const q = text.trim().toLowerCase();
  if (!q) return [...rows];
  const keys = key ? [key] : columns.map((c) => c.key);
  return rows.filter((r) => keys.some((k) => r[k] !== null && r[k] !== undefined && String(r[k]).toLowerCase().includes(q)));
}

// ------------------------------------------------------------------ exports (US-32)

export const EXPORT_STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'plain'> = {
  queued: 'plain',
  running: 'warn',
  completed: 'good',
  failed: 'bad',
  expired: 'plain',
};

export const exportTone = (status: string | null | undefined) => EXPORT_STATUS_TONE[status ?? ''] ?? 'plain';
export const exportPending = (status: string | null | undefined) => status === 'queued' || status === 'running';

/** Contract pattern for fileName: letters, digits, space, _ . - (≤ 80). */
export function cleanFileName(name: string): string {
  return name
    .replace(/[^A-Za-z0-9 _.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** Roles that may include contact columns in an export (Data operator: open question A-I3 → not offered). */
export const canExportContacts = (role: string) => (STAFF as readonly string[]).includes(role);
