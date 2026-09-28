// Shell and sign-in (WEB-01, WEB-02): chat-first layout, "/" actions by keyboard, side panel, theme, accessibility.
import { test as base } from '@playwright/test';
import { expect, expectAccessible, send, test } from './fixtures';

base('unauthenticated visitors land on the accessible sign-in page', async ({ page }) => {
  await page.goto('/chat/anything');
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fchat%2Fanything/);
  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
  await expectAccessible(page);
});

base('API calls without a session are 401 RFC 7807 problems with a correlation id', async ({ request }) => {
  const res = await request.get('/v1/me');
  expect(res.status()).toBe(401);
  expect(res.headers()['content-type']).toContain('application/problem+json');
  const body = await res.json();
  expect(body).toMatchObject({ code: 'unauthenticated', status: 401 });
  expect(body.correlationId).toBeTruthy();
});

test('home: greeting, Today tiles, suggestions; accessible in light and dark', async ({ as }) => {
  const page = await as('demand');
  await expect(page.getByRole('heading', { level: 2, name: /Good (morning|afternoon|evening), Priya/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  await expect(page.getByRole('button', { name: /to contact/ })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expectAccessible(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectAccessible(page);
});

test('"/" opens the quick-action menu; arrows + Enter pick an action', async ({ as }) => {
  const page = await as('admin');
  const box = page.getByRole('combobox', { name: 'Message' });
  await box.fill('/');
  const menu = page.getByRole('listbox', { name: 'Quick actions' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('option')).toHaveCount(9);
  await box.press('ArrowDown');
  await expect(menu.getByRole('option', { name: /\/desks/ })).toHaveAttribute('aria-selected', 'true');
  await box.press('Escape');
  await expect(menu).toBeHidden();
  await box.fill('/que');
  await box.press('Enter');
  await expect(page).toHaveURL(/\/chat\//);
  await expect(page.getByRole('heading', { name: 'My queue' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'queue' })).toBeVisible(); // recent chat
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'My queue' })).toBeHidden();
});

test('the theme toggle switches to dark and back', async ({ as }) => {
  const page = await as('supply');
  const toggle = page.getByRole('button', { name: /Theme:/ });
  await toggle.click(); // system → light
  await toggle.click(); // light → dark
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await toggle.click(); // dark → system
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
});

test('sign out ends the session', async ({ as }) => {
  const page = await as('operator');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  const res = await page.request.get('/v1/me');
  expect(res.status()).toBe(401);
});

test('a free question in the composer becomes a chat card (nothing changes without a click)', async ({ as }) => {
  const page = await as('manager');
  await send(page, 'How are we doing?');
  await expect(page.getByText('How are we doing?').first()).toBeVisible();
  await expect(page.getByText('The assistant proposes. Nothing changes until you click.')).toBeVisible();
});
