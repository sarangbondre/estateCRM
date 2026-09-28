import { describe, expect, it } from 'vitest';
import { count, greeting, initials, inr, relative, sqft } from '@/ui/lib/format';
import { suggestionsFor, tilesFor } from '@/ui/home/tiles';
import type { MyQueue } from '@/ui/home/tiles';

describe('format', () => {
  it('formats INR in Indian units', () => {
    expect(inr(110_000_000)).toBe('₹11 Cr');
    expect(inr(12_500_000)).toBe('₹1.25 Cr');
    expect(inr(850_000)).toBe('₹8.5 L');
    expect(inr(45_000)).toBe('₹45,000');
    expect(inr(null)).toBe('—');
  });
  it('formats areas, counts, names', () => {
    expect(sqft(4000)).toBe('4,000 sq ft');
    expect(count(1234567)).toBe('12,34,567');
    expect(initials('Priya Shah')).toBe('PS');
    expect(initials('Admin')).toBe('A');
  });
  it('relative times', () => {
    const now = Date.parse('2026-09-28T12:00:00Z');
    expect(relative('2026-09-28T11:57:00Z', now)).toBe('3 mins ago');
    expect(relative('2026-09-27T12:00:00Z', now)).toBe('yesterday');
    expect(relative('2026-09-30T12:00:00Z', now)).toBe('in 2 days');
  });
  it('greets by India time', () => {
    expect(greeting(new Date('2026-09-28T03:00:00Z'))).toBe('Good morning'); // 08:30 IST
    expect(greeting(new Date('2026-09-28T09:00:00Z'))).toBe('Good afternoon'); // 14:30 IST
    expect(greeting(new Date('2026-09-28T14:00:00Z'))).toBe('Good evening'); // 19:30 IST
  });
});

describe('Today tiles (C-01)', () => {
  const q: MyQueue = {
    userId: '00000000-0000-4000-8000-000000000001',
    capacity: 40,
    callsLoggedToday: 3,
    plannedToday: 20,
    sections: [
      { section: 'must_call', team: 'supply', count: 4 },
      { section: 'should_call', team: 'supply', count: 90, plannedToday: 36 },
      { section: 'sourcing_requests', team: 'supply', count: 2 },
      { section: 'to_contact', team: 'demand', count: 5 },
      { section: 'reconfirm_due', team: 'demand', count: 7 },
      { section: 'open_matches', team: 'demand', count: 3 },
      { section: 'deals_follow_up', team: 'demand', count: 2, overdue: 1 },
      { section: 'proposals_out', team: 'demand', count: 4, overdue: 2 },
    ],
  };
  it('demand agent: to contact, reconfirm due, open matches, follow-ups overdue', () => {
    expect(tilesFor('Demand agent', q).map((t) => t.count)).toEqual([5, 7, 3, 3]);
  });
  it('supply agent: must call, should call (planned today), sourcing requests', () => {
    expect(
      tilesFor('Supply agent', q)
        .map((t) => t.count)
        .slice(0, 3),
    ).toEqual([4, 36, 2]);
  });
  it('no counts while loading; data operators have no queue tiles', () => {
    expect(tilesFor('Manager', undefined).every((t) => t.count === undefined)).toBe(true);
    expect(tilesFor('Data operator', q)).toEqual([]);
    expect(suggestionsFor('Data operator')).toContain('/upload');
  });
});
