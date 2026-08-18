import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.tsbuildinfo'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // Plain-JS tooling runs on Node. no-undef is off for .ts files by default,
    // because the compiler answers that question better.
    // Build and CI tooling, wherever it lives — the repository's scripts/, the
    // per-package ones a build step invokes, and the ones a workflow runs.
    files: [
      'scripts/**/*.{js,mjs,cjs}',
      'packages/*/scripts/**/*.{js,mjs,cjs}',
      '.github/scripts/**/*.{js,mjs,cjs}',
    ],
    languageOptions: {
      // Listed rather than pulled from a `globals` package: the list being
      // short is the point. A script here reaching for something not on it is
      // worth noticing, and `fetch` and `setTimeout` earned their place by the
      // release plan asking the registry what it already holds.
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        // Earned its place the same way: the WebAuthn end-to-end signs a token
        // with a secret it builds here, exactly as the suites do.
        TextEncoder: 'readonly',
        // For the *browser* side of a `page.evaluate`, which is lexically in
        // these files and runs somewhere else entirely. `sessionStorage` and
        // friends are reached through this rather than being listed, because
        // listing them would tell the linter a Node script may use them — and
        // one that did would fail at run time with the check green.
        globalThis: 'readonly',
      },
    },
  },
  {
    rules: {
      // The permission model reads better with explicit, narrow types than
      // with inferred ones; these two catch the drift that hides a widening.
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
)
