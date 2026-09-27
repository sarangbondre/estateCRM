// Shared E2E fixtures: a page signed in as a role, WCAG 2.1 AA checks with axe, and composer helpers.
import AxeBuilder from '@axe-core/playwright';
import { test as base, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authFile } from './users';
import type { E2eRole } from './users';

export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** Fails with the list of violations (rule id, impact, first target) when axe finds WCAG 2.1 A/AA issues. */
export async function expectAccessible(page: Page, options: { include?: string; exclude?: string[] } = {}) {
  let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
  if (options.include) builder = builder.include(options.include);
  // The Next.js dev-tools badge is not part of the app.
  for (const sel of ['nextjs-portal', ...(options.exclude ?? [])]) builder = builder.exclude(sel);
  const { violations } = await builder.analyze();
  const summary = violations.map((v) => `${v.id} (${v.impact}): ${v.nodes[0]?.target.join(' ')} — ${v.help}`);
  expect(summary, summary.join('\n')).toEqual([]);
}

export const test = base.extend<{ as: (role: E2eRole) => Promise<Page> }>({
  as: async ({ browser }, use) => {
    const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
    await use(async (role) => {
      const ctx = await browser.newContext({ storageState: authFile(role) });
      contexts.push(ctx);
      const page = await ctx.newPage();
      await page.goto('/');
      await expect(page.getByRole('combobox', { name: 'Message' })).toBeVisible();
      return page;
    });
    for (const c of contexts) await c.close();
  },
});

export { expect };

/** Types into the composer and sends. */
export async function send(page: Page, text: string) {
  const box = page.getByRole('combobox', { name: 'Message' });
  await box.fill(text);
  await box.press('Enter');
}

/** Storage uploads go straight to the signed URL (not through web); in E2E the mock URL is answered here. */
export async function stubSignedUploads(page: Page) {
  await page.route(
    (url) => !url.href.startsWith('http://127.0.0.1:3000') && !url.href.startsWith('http://localhost:3000'),
    (route) => (route.request().method() === 'PUT' ? route.fulfill({ status: 200, body: '' }) : route.continue()),
  );
}
