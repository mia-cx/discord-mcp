import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // The e2e suite talks to a real test guild. PLAN.md: explicit opt-in, never in ordinary CI.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.e2e.test.ts'],
    testTimeout: 20_000,
  },
})
