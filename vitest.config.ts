import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: { reporter: ['text', 'json'] },
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    testTimeout: 10_000,
  },
})
