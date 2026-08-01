import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const IGNORED = ['**/node_modules/**', '**/dist/**']

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/**
 * Workspace packages resolve to source, not to dist.
 *
 * Their `exports` point at built output, so without this the acl job would
 * have to run `pnpm build` first — and would then be testing an artifact
 * rather than the tree under review. It also means a stale dist cannot make a
 * test pass. Mirrors the `paths` in tsconfig.typecheck.json; the two should be
 * changed together.
 */
const alias = {
  '@nacre.work/core': src('./packages/core/index.ts'),
  '@nacre.work/api': src('./packages/api/src/index.ts'),
  '@nacre.work/mcp': src('./packages/mcp/src/index.ts'),
}

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
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
        resolve: { alias },
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
