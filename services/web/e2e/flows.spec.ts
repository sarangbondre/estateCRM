// Core card flows with real clicks through the gateway (R-CHAT-1: nothing is sent before the click). Services are
// the Prism contract mocks, so assertions are on requests, statuses and the card's result state, not on mock data.
import type { Page } from '@playwright/test';
import { expect, expectAccessible, send, stubSignedUploads, test } from './fixtures';

const card = (page: Page, kicker: string) =>
  page.locator('section.card').filter({ has: page.locator('.card-h .k', { hasText: kicker }) }).last();

test('quick add (C-06): nothing is sent until "Look up"; phone lookup goes through the gateway', async ({ as }) => {
  const page = await as('demand');
  const calls: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/v1/quick-add')) calls.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  await send(page, '/add demand');
  const c = card(page, 'Quick add');
  await c.getByLabel('Phone').fill('+91 00000 12345');
  expect(calls).toEqual([]);
  const lookup = page.waitForResponse((r) => r.url().endsWith('/v1/quick-add/lookup'));
  await c.getByRole('button', { name: 'Look up' }).click();
  const res = await lookup;
  expect(res.status()).toBe(200);
  expect(res.request().postDataJSON()).toMatchObject({ phone: '+91 00000 12345' });
  expect(res.request().headers()['x-correlation-id'] ?? res.headers()['x-correlation-id']).toBeTruthy();
  await expect(c.getByRole('button', { name: 'Change' })).toBeVisible();
  await expectAccessible(page);
});

test('matches (C-10): Confirm sends one POST with an Idempotency-Key', async ({ as }) => {
  const page = await as('demand');
  await send(page, 'matches for DEM-000127');
  const c = card(page, 'Matches');
  await page.waitForLoadState('networkidle');
  const confirm = c.getByRole('button', { name: 'Confirm', exact: true }).first();
  test.skip((await confirm.count()) === 0 || !(await confirm.isEnabled()), 'the mock returned no confirmable match');
  const posted = page.waitForRequest((r) => r.method() === 'POST' && /\/v1\/matches\/[^/]+\/confirm$/.test(r.url()));
  await confirm.click();
  const req = await posted;
  expect(req.headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  expect((await req.response())?.status()).toBeLessThan(500);
});

test('chat answer (C-02): the SSE stream renders incrementally with "How I got this"', async ({ as }) => {
  const page = await as('manager');
  await page.route('**/v1/chat/conversations', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            conversationId: '8a4c6c1e-0000-4000-8000-000000000001',
            title: 'How are we doing?',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            messageCount: 0,
          }),
        })
      : route.continue(),
  );
  await page.route('**/v1/chat/conversations/*/messages', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform' },
          body: [
            'event: plan\ndata: {"howIGotThis":{"planId":"demand.pipeline","planVersion":1,"description":"Open demands by stage","filters":{"status":"open"},"rowCount":42}}\n\n',
            'event: token\ndata: {"text":"There are 42 open "}\n\n',
            'event: token\ndata: {"text":"demands this week."}\n\n',
            'event: done\ndata: {"messageId":"m1","fallbackUsed":false}\n\n',
          ].join(''),
        })
      : route.continue(),
  );
  await send(page, 'How are we doing?');
  const main = page.getByRole('main');
  await expect(main.getByText('There are 42 open demands this week.')).toBeVisible();
  await expect(main.getByText('How I got this')).toBeVisible();
  await expect(main.getByRole('status').filter({ hasText: 'Answer ready' })).toBeVisible();
  await expectAccessible(page);
});

test('upload (C-04): attach → create → file to the signed URL → inspect', async ({ as }) => {
  const page = await as('operator');
  await stubSignedUploads(page);
  await send(page, '/upload');
  const c = card(page, 'Upload');
  await c.locator('input[type=file]').setInputFiles({
    name: 'sheet.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('raw_text,deal_type\nSynthetic ad,Lease\n'),
  });
  const created = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/v1/uploads'));
  const inspected = page.waitForRequest((r) => /\/v1\/uploads\/[^/]+\/inspect$/.test(r.url()));
  await c.getByLabel('Source type').selectOption('Direct');
  await c.getByRole('button', { name: 'Upload and check' }).click();
  const res = await created;
  expect(res.status()).toBe(201);
  expect(res.request().postDataJSON()).toMatchObject({ fileName: 'sheet.csv', contentType: 'text/csv' });
  await inspected;
});

test('publication (C-12): a Supply agent sees the ceiling, preview and level choices', async ({ as }) => {
  const page = await as('supply');
  await send(page, 'Publish INV-00452');
  const c = card(page, 'Publication');
  await page.waitForLoadState('networkidle');
  await expect(c.getByRole('radio')).toHaveCount(3);
  await expect(c.getByLabel('Website preview')).toBeVisible();
});

test('gateway: rate-limit and correlation headers on a proxied call', async ({ as }) => {
  const page = await as('supply');
  const res = await page.request.get('/v1/queues/me', { headers: { 'x-correlation-id': 'e2e-corr-000001' } });
  expect(res.status()).toBe(200);
  expect(res.headers()['x-correlation-id']).toBe('e2e-corr-000001');
  expect(Number(res.headers()['x-ratelimit-limit'])).toBe(40);
});
