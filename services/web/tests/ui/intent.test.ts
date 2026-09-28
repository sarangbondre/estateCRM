import { describe, expect, it } from 'vitest';
import { codesIn, parseIntent, slashSuggestions, SLASH_ACTIONS, titleFor } from '@/ui/lib/intent';
import { panelForCode, resolveIntent } from '@/ui/chat/intents';
import type { Me } from '@/ui/shell/types';

const me: Me = {
  userId: '00000000-0000-4000-8000-000000000001',
  tenantId: '00000000-0000-4000-8000-000000000000',
  email: 'a@example.com',
  displayName: 'Test Admin',
  role: 'Admin',
  isDataOperator: false,
  permissions: [],
  sessionIdleExpiresAt: '2026-01-01T00:00:00Z',
  environment: { name: 'local', pilot: true },
};

describe('"/" quick actions', () => {
  it('lists every action for a bare slash, in the prototype order', () => {
    expect(slashSuggestions('/').map((a) => a.command)).toEqual(SLASH_ACTIONS.map((a) => a.command));
    expect(
      slashSuggestions('/')
        .slice(0, 3)
        .map((a) => a.command),
    ).toEqual(['/queue', '/desks', '/add demand']);
  });
  it('filters by prefix and hides for plain text', () => {
    expect(slashSuggestions('/ad').map((a) => a.command)).toEqual(['/add demand', '/add supply']);
    expect(slashSuggestions('/add s').map((a) => a.command)).toEqual(['/add supply']);
    expect(slashSuggestions('hello')).toEqual([]);
  });
});

describe('parseIntent', () => {
  it.each([
    ['/queue', { kind: 'queue' }],
    ['/desks', { kind: 'desks' }],
    ['/add demand', { kind: 'quick-add', side: 'Demand' }],
    ['/add supply', { kind: 'add-supply' }],
    ['/matches', { kind: 'matches' }],
    ['/upload', { kind: 'upload' }],
    ['/review', { kind: 'review' }],
    ['/dashboard', { kind: 'dashboard' }],
    ['open inv-00452', { kind: 'open', code: 'INV-00452' }],
    ['Publish INV-00488', { kind: 'publish', code: 'INV-00488' }],
    ['Qualify DEM-000127', { kind: 'qualify', code: 'DEM-000127' }],
    ['Send proposal for DEM-000127', { kind: 'proposal', code: 'DEM-000127' }],
    ['Add supply for DEM-000127', { kind: 'add-supply', demand: 'DEM-000127' }],
    ['start deal DEM-000127 with INV-00452', { kind: 'deal', demand: 'DEM-000127', offer: 'INV-00452' }],
    ['INV-00452 is gone', { kind: 'retire', code: 'INV-00452' }],
    ['source supply for DEM-000131', { kind: 'sourcing', code: 'DEM-000131' }],
  ])('%s', (text, expected) => {
    expect(parseIntent(text)).toEqual(expected);
  });
  it('keeps the whole note for call outcomes and exits', () => {
    expect(parseIntent('Called the owner about INV-00452, available at 8.5L')).toMatchObject({
      kind: 'call',
      code: 'INV-00452',
    });
    expect(parseIntent('Client for DEM-000131 postponed to April')).toMatchObject({
      kind: 'exit',
      code: 'DEM-000131',
    });
  });
  it('treats anything else as a chat question', () => {
    expect(parseIntent('How are we doing?')).toEqual({ kind: 'ask', text: 'How are we doing?' });
    expect(parseIntent('/nope')).toEqual({ kind: 'ask', text: '/nope' });
  });
  it('finds codes and titles', () => {
    expect(codesIn('compare inv-1234 with DEM-000127')).toEqual(['INV-1234', 'DEM-000127']);
    expect(titleFor('/queue')).toBe('queue');
    expect(titleFor('x'.repeat(60))).toHaveLength(46);
  });
});

describe('resolveIntent', () => {
  const ctx = { me, conversationId: 'c1' };
  it('opens panels for queue, desks and record codes', () => {
    expect(resolveIntent({ kind: 'queue' }, ctx).panel?.kind).toBe('queue');
    expect(resolveIntent({ kind: 'open', code: 'DEM-000127' }, ctx).panel).toEqual({
      kind: 'demand',
      title: 'DEM-000127',
      props: { code: 'DEM-000127' },
    });
    expect(panelForCode('WCH-0001')?.kind).toBe('desk-item');
    expect(panelForCode('XYZ-1')).toBeNull();
  });
  it('places cards for actions and questions', () => {
    expect(resolveIntent({ kind: 'publish', code: 'INV-1' }, ctx).cards).toEqual([
      { kind: 'publication', props: { offer: 'INV-1' } },
    ]);
    expect(resolveIntent({ kind: 'ask', text: 'hi' }, ctx).cards).toEqual([
      { kind: 'answer', props: { question: 'hi', conversationId: 'c1' } },
    ]);
    expect(resolveIntent({ kind: 'open', code: 'UPL-000231' }, ctx).cards[0]?.kind).toBe('upload');
  });
});
