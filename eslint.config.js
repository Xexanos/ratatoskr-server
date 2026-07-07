// @ts-check
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/generated/**', '**/node_modules/**', 'spike/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain Node scripts (build-time generators) — give them Node globals so no-undef
    // doesn't trip on console/process. TS files get this from the TypeScript types.
    files: ['**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // SPEC section 13: @ratatoskr/position must stay pure and I/O-free. The zero-dependency
    // package.json guard (purity.test.ts) does not catch Node built-ins, which need no
    // dependency entry — this boundary does. Scoped to src only; tests may use node: APIs.
    files: ['packages/position/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*'],
              message: '@ratatoskr/position must stay I/O-free (SPEC section 13): no Node built-ins.',
            },
            {
              group: ['@ratatoskr/*'],
              message: '@ratatoskr/position is a leaf module (SPEC section 13): no workspace imports.',
            },
          ],
        },
      ],
    },
  },
)
