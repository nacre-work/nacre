import { defineConfig } from 'vitest/config'

const IGNORED = ['**/node_modules/**', '**/dist/**']

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/**/*.test.ts'],
          // authz has its own project and its own required CI job. Running
          // those tests here too would mean a leak test that fails shows up
          // as a unit-test failure, which is how it gets triaged as a flake.
          exclude: [...IGNORED, 'packages/core/authz/**'],
        },
      },
      {
        test: {
          // No passWithNoTests here, ever, at any level. An empty acl project
          // must fail: a green leak-test job that ran nothing is worse than a
          // red one, because it gets believed.
          name: 'acl',
          include: ['packages/core/authz/__tests__/**/*.test.ts'],
          exclude: IGNORED,
        },
      },
    ],
  },
})
