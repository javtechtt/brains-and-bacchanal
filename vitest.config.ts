import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve @bb/* workspace packages to TypeScript source so tests run against
  // current code without a build step. Node at runtime uses the default
  // condition instead, which points at built JS in dist/.
  resolve: {
    conditions: ['bb-source'],
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    environment: 'node',
    // CLAUDE.md — "Use a deterministic/fake clock for timing tests."
    // No test may depend on real elapsed time; FakeClock is advanced explicitly.
    testTimeout: 5_000,
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
    },
  },
});
