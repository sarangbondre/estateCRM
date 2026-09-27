// WEB-07 insight + listings card logic: SSE parsing and the answer reducer (PRD §5.1), message part → view mapping,
// proposed-action requests (R-CHAT-1), dashboard tabs by role (P-06 x-roles), table sort/filter (P-07), and the
// publication levels vs the ceiling, privacy highlighting and RERA check (C-12, A7).
import { describe, expect, it } from 'vitest';
import {
  actionAvailability,
  answerFromMessage,
  applyStreamEvent,
  barWidths,
  buildActionRequest,
  cleanFileName,
  createSseParser,
  dashboardTabsFor,
  filterRows,
  hasContent,
  howParts,
  initialAnswer,
  navigatePanel,
  sortRows,
  toStreamEvent,
  viewForPart,
} from '@/ui/cards/insight/logic';
import type { ActionPart, AnswerState, HowIGotThisData, SseFrame, StreamEvent } from '@/ui/cards/insight/logic';
import {

  canSetPublication,
  highlightSpans,
  levelOptions,
  needsChecks,
  publicationBody,
  reraStatus,
  scanSummary,
} from '@/ui/cards/listings/logic';

/** The card's own Idempotency-Key (generated so it never looks like a stored secret). */
const ACTION_KEY = crypto.randomUUID();

const events = (frames: SseFrame[]) => frames.map(toStreamEvent).filter((e): e is StreamEvent => e !== null);

const how: HowIGotThisData = {
  plan: { planId: 'count_offers', templateVersion: 3, filters: [{ field: 'deal_type', op: 'eq', value: 'Lease' }] },
  description: 'Offers where deal_type = Lease, counted',
  filtersApplied: [{ field: 'deal_type', label: 'Deal type', value: 'Lease' }],
  source: '11 Estates read model (insight)',
  rowCount: 12,
  dataAsOf: '2026-09-28T09:15:00Z',
  catalogueVersion: 'c7',
  vocabularyVersion: 'v1.4',
  fallbackUsed: false,
};

describe('SSE parser', () => {
  it('parses frames split across reads, including inside a line and between \\r and \\n', () => {
    const p = createSseParser();
    const out: SseFrame[] = [];
    for (const chunk of ['event: tok', 'en\r', '\ndata: {"type":"token",', '"text":"Hel"}\r\n', '\r\nid: 2\n']) out.push(...p.push(chunk));
    expect(out).toEqual([{ event: 'token', data: '{"type":"token","text":"Hel"}' }]);
    out.push(...p.push('event: token\ndata: {"text":"lo"}\n\n'));
    expect(out[1]).toEqual({ event: 'token', data: '{"text":"lo"}', id: '2' });
  });

  it('returns several events from one chunk and ignores comments', () => {
    const p = createSseParser();
    const frames = p.push(
      ': keep-alive\n\nevent: plan\ndata: {"type":"plan","howIGotThis":{"description":"x"}}\n\nevent: token\ndata: {"text":"Twelve"}\n\nevent: token\ndata: {"text":" offers"}\n\n',
    );
    expect(frames.map((f) => f.event)).toEqual(['plan', 'token', 'token']);
    expect(events(frames).map((e) => e.type)).toEqual(['plan', 'token', 'token']);
  });

  it('joins multi-line data and flushes a last frame without the closing blank line', () => {
    const p = createSseParser();
    expect(p.push('event: done\ndata: {"messageId":"m1",\ndata: "fallbackUsed":true}')).toEqual([]);
    const [done] = events(p.flush());
    expect(done).toEqual({ type: 'done', messageId: 'm1', fallbackUsed: true });
  });

  it('maps the final error event and drops malformed or unknown frames', () => {
    expect(toStreamEvent({ event: 'error', data: '{"code":"query-timeout","title":"Timed out","correlationId":"c1"}' })).toEqual({
      type: 'error',
      code: 'query-timeout',
      title: 'Timed out',
      correlationId: 'c1',
    });
    expect(toStreamEvent({ event: 'card', data: '{"card":{}}' })).toBeNull();
    expect(toStreamEvent({ event: 'plan', data: 'not json' })).toBeNull();
    expect(toStreamEvent({ event: 'weird', data: '{}' })).toBeNull();
    // `event:` missing → the `type` in data decides.
    expect(toStreamEvent({ event: 'message', data: '{"type":"token","text":"a"}' })).toEqual({ type: 'token', text: 'a' });
  });
});

describe('answer reducer', () => {
  const table = {
    kind: 'table',
    cardType: 'C-03',
    cardId: 't1',
    result: { columns: [], rows: [], nextCursor: null, howIGotThis: how },
  };

  it('streams plan → tokens → cards → done and stops after the final event', () => {
    let s: AnswerState = { ...initialAnswer, status: 'streaming' };
    expect(hasContent(s)).toBe(false);
    const evs: StreamEvent[] = [
      { type: 'plan', howIGotThis: how },
      { type: 'token', text: 'Twelve ' },
      { type: 'token', text: 'offers.' },
      { type: 'card', card: table as never },
      { type: 'card', card: table as never },
      { type: 'done', messageId: 'm1', fallbackUsed: false, outcome: 'answered' },
      { type: 'token', text: ' late' },
    ];
    for (const e of evs) s = applyStreamEvent(s, e);
    expect(s.status).toBe('done');
    expect(s.text).toBe('Twelve offers.');
    expect(s.parts).toHaveLength(1); // replayed card deduped on cardId
    expect(s.how?.plan.planId).toBe('count_offers');
    expect(s.messageId).toBe('m1');
  });

  it('turns the error event into a friendly, retryable message', () => {
    const s = applyStreamEvent({ ...initialAnswer, status: 'streaming' }, { type: 'error', code: 'query-timeout', title: 'x' });
    expect(s.status).toBe('error');
    expect(s.error?.title).toMatch(/15 seconds/);
    expect(s.error?.retryable).toBe(true);
    const f = applyStreamEvent({ ...initialAnswer, status: 'streaming' }, { type: 'error', code: 'forbidden', title: 'x' });
    expect(f.error?.retryable).toBe(false);
  });

  it('accepts a non-streaming JSON message as the final answer', () => {
    const s = answerFromMessage({ messageId: 'm2', role: 'assistant', text: 'Hi', cards: [table, 'junk'], howIGotThis: how, fallbackUsed: true });
    expect(s?.status).toBe('done');
    expect(s?.parts).toHaveLength(1);
    expect(s?.fallbackUsed).toBe(true);
    expect(answerFromMessage({ nope: 1 })).toBeNull();
  });
});

describe('message part → view', () => {
  it('maps each contract card kind to its view', () => {
    expect(viewForPart({ kind: 'answer', cardType: 'C-02', cardId: 'a', text: 'x' } as never).view).toBe('answer');
    expect(viewForPart(table()).view).toBe('table');
    expect(viewForPart({ kind: 'table', cardId: 'b' }).view).toBe('unknown'); // no result → not rendered as a table
    expect(viewForPart({ kind: 'dashboard', cardType: 'C-20', cardId: 'c', dashboard: 'supply' } as never).view).toBe('dashboard');
    expect(viewForPart({ kind: 'notice', cardId: 'd', notice: 'out_of_scope' } as never).view).toBe('notice');
    expect(viewForPart(action()).view).toBe('action');
    expect(viewForPart({ kind: 'hologram' })).toEqual({ view: 'unknown', kind: 'hologram' });
  });

  it('opens the right panel for navigate cards', () => {
    expect(navigatePanel({ panel: 'P-02', subjectCode: 'INV-00452' })).toEqual({ kind: 'offer', title: 'INV-00452', props: { code: 'INV-00452' } });
    expect(navigatePanel({ panel: 'P-01' })).toMatchObject({ kind: 'queue' });
    expect(navigatePanel({ panel: 'P-03', subjectCode: null })).toBeNull();
    expect(navigatePanel({ panel: 'P-99' as never })).toBeNull();
  });

  it('lists the plan, filters, rows and freshness in "How I got this"', () => {
    const parts = howParts(how);
    expect(parts[0]).toBe(how.description);
    expect(parts).toContain('plan count_offers v3');
    expect(parts).toContain('Deal type = Lease');
    expect(parts).toContain('12 rows');
    expect(parts.some((p) => p.startsWith('data as of 2026-09-28'))).toBe(true);
    expect(howParts(null)).toEqual([]);
  });

  function table() {
    return { kind: 'table', cardType: 'C-03', cardId: 't', result: { columns: [], rows: [], nextCursor: null, howIGotThis: how } } as never;
  }
});

function action(over: Partial<ActionPart> = {}): ActionPart {
  return {
    kind: 'action',
    cardType: 'C-09',
    cardId: 'a1',
    title: 'Qualify DEM-000127',
    targetService: 'journeys',
    targetOperation: 'qualifyDemand',
    method: 'POST',
    path: '/v1/demands/DEM-000127/qualify',
    payload: { checklist: ['budget'], note: 'ok', budgetInr: 5000000 },
    editableFields: ['note', 'budgetInr'],
    requiresConfirmation: true,
    allowedRoles: ['Admin', 'Manager', 'Demand agent'],
    idempotencyKey: ACTION_KEY,
    expiresAt: '2026-09-28T10:00:00Z',
    ...over,
  };
}

describe('proposed action requests (R-CHAT-1)', () => {
  it('sends method, path and payload with the card idempotency key; only editable fields change', () => {
    const r = buildActionRequest(action(), { note: 'confirmed on call', checklist: [], budgetInr: 5500000 });
    expect(r).toEqual({
      method: 'POST',
      path: '/v1/demands/DEM-000127/qualify',
      body: { checklist: ['budget'], note: 'confirmed on call', budgetInr: 5500000 },
      idempotencyKey: ACTION_KEY,
      contentType: 'application/json',
    });
  });

  it('uses merge-patch and If-Match for PATCH targets', () => {
    const r = buildActionRequest(action({ method: 'PATCH', path: '/v1/offers/INV-00452', ifMatch: '7' }));
    expect(r).toMatchObject({ method: 'PATCH', contentType: 'application/merge-patch+json', ifMatch: '7' });
  });

  it('refuses paths outside the gateway /v1 space and unknown methods', () => {
    expect(typeof buildActionRequest(action({ path: 'https://evil.example/v1/x' }))).toBe('string');
    expect(typeof buildActionRequest(action({ path: '/internal/v1/relay' }))).toBe('string');
    expect(typeof buildActionRequest(action({ path: '/v1/../internal/v1/relay' }))).toBe('string');
    expect(typeof buildActionRequest(action({ method: 'DELETE' as never }))).toBe('string');
    expect(typeof buildActionRequest(action({ idempotencyKey: '' }))).toBe('string');
  });

  it('is available only to allowed roles and before it expires', () => {
    const now = Date.parse('2026-09-28T09:30:00Z');
    expect(actionAvailability(action(), 'Demand agent', now)).toEqual({ ok: true });
    expect(actionAvailability(action(), 'Supply agent', now).ok).toBe(false);
    expect(actionAvailability(action(), 'Demand agent', Date.parse('2026-09-28T10:30:00Z')).ok).toBe(false);
  });
});

describe('dashboards (P-06, C-20)', () => {
  it('shows every tab to staff and only Data quality to Data operators (x-roles)', () => {
    expect(dashboardTabsFor('Manager').map((t) => t.label)).toEqual(['Demand', 'Supply', 'Other scopes', 'Data quality']);
    expect(dashboardTabsFor('Data operator').map((t) => t.key)).toEqual(['quality']);
    expect(dashboardTabsFor(undefined)).toEqual([]);
  });

  it('scales bars to the largest value and treats bad values as zero', () => {
    expect(barWidths([5, 10, null, -3, Number.NaN])).toEqual([50, 100, 0, 0, 0]);
    expect(barWidths([0, 0])).toEqual([0, 0]);
  });
});

describe('table panel (P-07) and exports', () => {
  const columns = [
    { key: 'code', label: 'Offer', type: 'code' as const },
    { key: 'rent', label: 'Rent', type: 'inr' as const },
    { key: 'locality', label: 'Locality', type: 'string' as const },
  ];
  const rows = [
    { code: 'INV-00010', rent: 90000, locality: 'Andheri West' },
    { code: 'INV-00002', rent: null, locality: 'Bandra' },
    { code: 'INV-00003', rent: 45000, locality: 'andheri east' },
  ];

  it('sorts numerically with empty values last in both directions', () => {
    expect(sortRows(rows, 'rent', 'asc', 'inr').map((r) => r.code)).toEqual(['INV-00003', 'INV-00010', 'INV-00002']);
    expect(sortRows(rows, 'rent', 'desc', 'inr').map((r) => r.code)).toEqual(['INV-00010', 'INV-00003', 'INV-00002']);
    expect(sortRows(rows, 'code', 'asc').map((r) => r.code)).toEqual(['INV-00002', 'INV-00003', 'INV-00010']);
  });

  it('filters case-insensitively on one stored column or all', () => {
    expect(filterRows(rows, columns, 'locality', 'ANDHERI')).toHaveLength(2);
    expect(filterRows(rows, columns, '', '00002')).toHaveLength(1);
    expect(filterRows(rows, columns, 'locality', '  ')).toHaveLength(3);
  });

  it('cleans export file names to the contract pattern', () => {
    expect(cleanFileName('Andheri/2 BHK: rentals*')).toBe('Andheri 2 BHK rentals');
    expect(cleanFileName('x'.repeat(100))).toHaveLength(80);
  });
});

describe('publication (C-12)', () => {
  const reasons = [{ code: 'not_verified' as const, message: 'Not verified yet.' }];

  it('enables levels up to the ceiling and explains the locked ones', () => {
    const o = levelOptions({ level: 'Private', ceiling: 'Anonymous', ceilingReasons: reasons, allowedLevels: ['Private', 'Anonymous'] });
    expect(o.map((x) => [x.level, x.enabled])).toEqual([
      ['Private', true],
      ['Anonymous', true],
      ['Public', false],
    ]);
    expect(o[2]?.reason).toContain('Not verified yet.');
    expect(o[0]?.current).toBe(true);
  });

  it('locks everything above Private when the ceiling is Private, and respects allowedLevels', () => {
    const o = levelOptions({ level: 'Private', ceiling: 'Private', ceilingReasons: [], allowedLevels: ['Private'] });
    expect(o.filter((x) => x.enabled).map((x) => x.level)).toEqual(['Private']);
    const p = levelOptions({ level: 'Anonymous', ceiling: 'Public', ceilingReasons: [], allowedLevels: ['Private', 'Public'] });
    expect(p.find((x) => x.level === 'Anonymous')?.enabled).toBe(false);
    // Unknown ceiling values never widen visibility.
    const u = levelOptions({ level: 'Private', ceiling: 'Everyone' as never, ceilingReasons: [], allowedLevels: [] });
    expect(u.filter((x) => x.enabled).map((x) => x.level)).toEqual(['Private']);
  });

  it('lets Supply agents, Managers and Admins set the level; others view', () => {
    expect(['Admin', 'Manager', 'Supply agent'].every(canSetPublication)).toBe(true);
    expect(canSetPublication('Demand agent')).toBe(false);
    expect(canSetPublication('Data operator')).toBe(false);
  });

  it('runs checks when raising above Private only', () => {
    expect(needsChecks('Private', 'Anonymous')).toBe(true);
    expect(needsChecks('Public', 'Anonymous')).toBe(false);
    expect(needsChecks('Anonymous', 'Private')).toBe(false);
  });

  it('highlights flagged spans by offsets, merging overlaps and clamping', () => {
    const text = 'Call 9820012345 at Sea Breeze CHS';
    const segs = highlightSpans(text, [
      { kind: 'phone', severity: 'block', field: 'description', start: 5, end: 15 },
      { kind: 'building_name', severity: 'warn', field: 'description', start: 19, end: 99 },
      { kind: 'society_name', severity: 'block', field: 'description', start: 25, end: 33 },
      { kind: 'photo_text', severity: 'warn', field: 'photo' },
    ]);
    expect(segs.map((s) => [s.text, s.flagged])).toEqual([
      ['Call ', false],
      ['9820012345', true],
      [' at ', false],
      ['Sea Breeze CHS', true],
    ]);
    expect(segs[3]?.kinds).toEqual(['building_name', 'society_name']);
    expect(segs[3]?.severity).toBe('block');
    expect(segs.map((s) => s.text).join('')).toBe(text);
    expect(highlightSpans('', [])).toEqual([{ text: '', flagged: false, kinds: [] }]);
  });

  it('summarises the privacy scan', () => {
    expect(scanSummary(null).tone).toBe('warn');
    const blocked = scanSummary({ scanId: 's', result: 'blocked', findings: [{ kind: 'phone', severity: 'block', field: 'description' }], rulesVersion: '1', scannedAt: '' });
    expect(blocked.tone).toBe('bad');
    expect(blocked.text).toContain('phone number');
  });

  it('shows "MahaRERA registration pending" in the pilot when the number is missing (A7), blocks in production', () => {
    const rera = { agentNumberSet: false, projectReraRequired: false };
    const pilot = reraStatus({ mahareraAgentNumber: '' }, rera, true);
    expect(pilot.tone).toBe('warn');
    expect(pilot.preview).toBe('MahaRERA registration pending');
    expect(reraStatus({ mahareraAgentNumber: '' }, rera, false).tone).toBe('bad');
    expect(reraStatus(null, rera, true).preview).toBe('MahaRERA registration pending');
    const ok = reraStatus({ mahareraAgentNumber: 'A51900012345' }, { agentNumberSet: true, projectReraRequired: true, projectReraNumber: 'P5190001' }, false);
    expect(ok.tone).toBe('good');
    expect(ok.preview).toBe('MahaRERA agent reg. A51900012345 · Project RERA P5190001');
    expect(reraStatus({ mahareraAgentNumber: 'A51900012345' }, { agentNumberSet: true, projectReraRequired: true, projectReraNumber: null }, true).tone).toBe('bad');
  });

  it('sends the description only when it was edited (null resets to generated)', () => {
    expect(publicationBody('Anonymous', 'Nice flat', 'Nice flat')).toEqual({ level: 'Anonymous' });
    expect(publicationBody('Public', 'Nice flat', 'Nicer flat')).toEqual({ level: 'Public', publicDescription: 'Nicer flat' });
    expect(publicationBody('Public', 'Nice flat', '  ')).toEqual({ level: 'Public', publicDescription: null });
    expect(publicationBody('Private', null, '')).toEqual({ level: 'Private' });
  });
});
