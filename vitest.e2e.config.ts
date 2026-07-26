import { defineConfig } from 'vitest/config'

/**
 * The opt-in suites: real Docker, real Discord.
 *
 * A separate config rather than a flag on the default one, so there is no way to run these by
 * accident. They mutate a real guild and start real containers, and each is additionally guarded by
 * its own environment variable — running this config without those set skips everything.
 */
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.e2e.test.ts', 'apps/*/test/**/*.e2e.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Pulling an image and waiting on containers is slow, and a timeout here is a flake rather
    // than a finding.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // Serial: these share a Discord test guild and a Docker daemon, and parallel mutation of either
    // produces failures that are about the harness rather than about the code.
    fileParallelism: false,
  },
})
