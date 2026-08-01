import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.tsbuildinfo'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // The permission model reads better with explicit, narrow types than
      // with inferred ones; these two catch the drift that hides a widening.
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
)
