// Test files share the local Postgres; run them one at a time so the records_svc connection cap (6) is never hit.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
