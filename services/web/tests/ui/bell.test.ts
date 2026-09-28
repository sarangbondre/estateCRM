import { describe, expect, it } from 'vitest';
import { mergeNotifications } from '@/ui/shell/NotificationBell';

describe('notification bell (R-6): web + journeys merged client-side', () => {
  it('sorts both lists newest first and keeps the source for mark-read', () => {
    const merged = mergeNotifications(
      [
        {
          notificationId: 'w1',
          kind: 'upload_completed',
          title: 'UPL-1 processed',
          subjectCode: 'UPL-1',
          createdAt: '2026-09-28T10:00:00Z',
          readAt: null,
        },
      ],
      [
        { id: 'j1', kind: 'match_suggested', title: 'New match', subjectCode: 'DEM-1', createdAt: '2026-09-28T11:00:00Z', readAt: null },
        { id: 'j2', kind: 'enquiry', title: 'Old', createdAt: '2026-09-27T11:00:00Z', readAt: '2026-09-27T12:00:00Z' },
      ],
    );
    expect(merged.map((m) => `${m.source}:${m.id}:${m.read}`)).toEqual(['journeys:j1:false', 'web:w1:false', 'journeys:j2:true']);
    expect(merged[1]?.code).toBe('UPL-1');
  });
});
