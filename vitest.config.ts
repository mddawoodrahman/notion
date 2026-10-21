import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 120_000,
    // Integration suites share one PostgreSQL database; they opt into
    // `describe.sequential` and this pool keeps files isolated. Files are also
    // run one at a time because each suite boots its own embedded server and
    // parallel initdb/port setup is a needless source of CI flakes.
    pool: 'forks',
    fileParallelism: false,
    reporters: ['default'],
  },
});
