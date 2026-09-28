import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['tests/global-setup.ts'],
    // insight_svc may hold at most 3 connections (pilot cap): one per test file, two files at a time
    maxWorkers: 2,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
