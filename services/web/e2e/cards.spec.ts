// Every card and panel renders against the service contract mocks (Prism, random schema-valid data), without
// crashing, and passes WCAG 2.1 AA checks (WEB-05 … WEB-07). Flows with real clicks are in flows.spec.ts.
import type { Page } from '@playwright/test';
import { expect, expectAccessible, send, test } from './fixtures';
import type { E2eRole } from './users';

async function cardFor(page: Page, kicker: string) {
  const card = page.locator('section.card').filter({ has: page.locator('.card-h .k', { hasText: kicker }) }).last();
  await expect(card).toBeVisible();
  await expect(card).not.toContainText('Not available yet');
  return card;
}

const CARDS: { role: E2eRole; say: string; kicker: string }[] = [
  { role: 'operator', say: '/upload', kicker: 'Upload' },
  { role: 'operator', say: '/review', kicker: 'Review' },
  { role: 'demand', say: '/add demand', kicker: 'Quick add' },
  { role: 'supply', say: '/add supply', kicker: 'Add supply' },
  { role: 'demand', say: 'Qualify DEM-000127', kicker: 'Qualify' },
  { role: 'demand', say: 'matches for DEM-000127', kicker: 'Matches' },
  { role: 'supply', say: 'Called the owner about INV-00452, available now', kicker: 'Call outcome' },
  { role: 'demand', say: 'source supply for DEM-000127', kicker: 'Sourcing request' },
  { role: 'demand', say: 'Send proposal for DEM-000127', kicker: 'Proposal' },
  { role: 'demand', say: 'schedule visit for DEM-000127', kicker: 'Site visit' },
  { role: 'demand', say: 'start deal DEM-000127 with INV-00452', kicker: 'Deal' },
  { role: 'demand', say: 'Client for DEM-000127 postponed to April', kicker: 'Exit' },
  { role: 'supply', say: 'INV-00452 is gone', kicker: 'Close / retire offer' },
  { role: 'supply', say: 'Publish INV-00452', kicker: 'Publication' },
  { role: 'manager', say: '/exports', kicker: 'Exports' },
  { role: 'manager', say: '/dashboard', kicker: 'Dashboard' },
];

for (const c of CARDS) {
  test(`card "${c.kicker}" (${c.say}) renders and is accessible`, async ({ as }) => {
    const page = await as(c.role);
    await send(page, c.say);
    const card = await cardFor(page, c.kicker);
    // Let the first loads settle (live state, R-CHAT-3).
    await page.waitForLoadState('networkidle');
    await expect(card.getByRole('alert').filter({ hasText: /Something went wrong|internal/i })).toHaveCount(0);
    await expectAccessible(page);
  });
}

const PANELS: { role: E2eRole; say: string; title: RegExp | string }[] = [
  { role: 'supply', say: '/queue', title: 'My queue' },
  { role: 'demand', say: '/queue', title: 'My queue' },
  { role: 'manager', say: '/desks', title: 'Desks & Watchlist' },
  { role: 'manager', say: '/dashboard', title: 'Dashboards' },
  { role: 'supply', say: 'open INV-00452', title: 'INV-00452' },
  { role: 'demand', say: 'open DEM-000127', title: 'DEM-000127' },
  { role: 'demand', say: 'open PER-000010', title: 'PER-000010' },
  { role: 'supply', say: 'open PRJ-000005', title: 'PRJ-000005' },
];

for (const p of PANELS) {
  test(`panel ${String(p.title)} (${p.role}) renders, tabs work by keyboard, and it is accessible`, async ({ as }) => {
    const page = await as(p.role);
    await send(page, p.say);
    const panel = page.locator('aside.panel');
    await expect(panel.getByRole('heading', { name: p.title })).toBeVisible();
    await page.waitForLoadState('networkidle');
    const tabs = panel.getByRole('tab');
    if ((await tabs.count()) > 1) {
      await tabs.first().focus();
      await page.keyboard.press('ArrowRight');
      await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
      await page.waitForLoadState('networkidle');
    }
    await expectAccessible(page);
  });
}

test('settings: Admin sees every tab; each tab is accessible', async ({ as }) => {
  const page = await as('admin');
  await page.goto('/settings');
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(10);
  for (let i = 0; i < 10; i++) {
    await tabs.nth(i).click();
    await page.waitForLoadState('networkidle');
    await expectAccessible(page);
  }
});

test('settings: a Demand agent is told it is not available', async ({ as }) => {
  const page = await as('demand');
  await page.goto('/settings');
  await expect(page.getByText(/not available for your role/i)).toBeVisible();
});
