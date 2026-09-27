import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['tests/global-setup.ts'],
    // journeys_svc may hold at most 4 connections (pilot cap): at most 3 test files at a time
    maxWorkers: 3,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
