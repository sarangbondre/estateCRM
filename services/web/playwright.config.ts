// Playwright E2E for the core cards and WCAG 2.1 AA checks (WEB-09). Runs against the local stack: Supabase Auth +
// Postgres (`pnpm db:start`), web on 127.0.0.1:3000 (built and started here), and the Prism contract mocks for the six
// services (`pnpm mock`, ports 4011–4016). Signed-in storage states per role come from e2e/global-setup.ts.
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env['E2E_PORT'] ?? 3000);
export const BASE_URL = `http://127.0.0.1:${PORT}`;
const channel = process.env['PW_CHANNEL'] ?? (process.env['CI'] ? undefined : 'chrome');

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    ...(channel ? { channel } : {}),
    ...devices['Desktop Chrome'],
    viewport: { width: 1360, height: 900 },
  },
  webServer: [
    {
      command: 'node ../../tools/contracts/mock.mjs intake records journeys crm-engine listings insight',
      url: 'http://127.0.0.1:4012/health/live',
      reuseExistingServer: true,
      timeout: 60_000,
      stdout: 'ignore',
    },
    {
      command: `pnpm exec next start --port ${PORT} --hostname 127.0.0.1`,
      url: `${BASE_URL}/health/live`,
      reuseExistingServer: true,
      timeout: 120_000,
      env: { WEB_LOCAL_EMAIL_SIGNIN: 'true' },
    },
  ],
});
