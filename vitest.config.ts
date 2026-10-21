import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 120_000,
    // Each integration suite boots its own throwaway PostgreSQL server, so
    // running files one at a time keeps port/initdb setup deterministic.
    pool: 'forks',
    fileParallelism: false,
    reporters: ['default'],
  },
});
