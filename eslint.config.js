import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.tsbuildinfo'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // Plain-JS tooling runs on Node. no-undef is off for .ts files by default,
    // because the compiler answers that question better.
    // Build and CI tooling, wherever it lives — the repository's scripts/ and
    // the per-package ones a build step invokes.
    files: ['scripts/**/*.{js,mjs,cjs}', 'packages/*/scripts/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly' },
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
