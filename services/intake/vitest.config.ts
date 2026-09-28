// Test files share the local Postgres and the intake_svc connection cap (5); run them one at a time.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
