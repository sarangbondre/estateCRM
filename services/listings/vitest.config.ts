// Integration tests share one local database and the service's pgmq queues, so test files run one after another
// (each file still uses its own tenant).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
