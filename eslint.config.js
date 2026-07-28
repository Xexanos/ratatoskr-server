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
    // SPEC section 13: the contract types belong to api/, which owns the mapping between them and
    // the domain. Everything else in the app is core and must not know what the wire looks like —
    // otherwise a value shaped for one API major leaks out of a module that cannot know which major
    // is being served. Default-deny (all of src/, minus the two exemptions) so a new core module is
    // covered the moment it lands, rather than when someone remembers to list it.
    // Both patterns live in ONE config object on purpose: a second object naming
    // no-restricted-imports would REPLACE this configuration for every file it matched, not add to
    // it, silently dropping whichever pattern it left out.
    files: ['packages/app/src/**/*.ts'],
    ignores: [
      // api/ is the edge: mapping the contract types is its job.
      'packages/app/src/api/**/*.ts',
      // Must import the contract from outside api/ — it asserts that the generated types reach a
      // *consuming* package as real types, and only crossing that boundary detects the failure.
      'packages/app/src/contractTypeAssertion.ts',
      // The composition root, whose whole job is to wire the layers together — it is the one place
      // that is supposed to reach into api/. It builds no response values, so nothing can leak.
      'packages/app/src/main.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@ratatoskr/contract'],
              message:
                'The contract types belong to api/ (SPEC section 13): the core speaks domain types, and api/contractMapping.ts maps them.',
            },
            {
              // The dependency runs one way, core -> edge never. Also what stops the rule above from
              // being sidestepped by re-exporting `components` from somewhere in api/.
              group: ['**/api/*', '**/api/**'],
              message: 'The core must not import from api/ (SPEC section 13): the dependency runs one way.',
            },
          ],
        },
      ],
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
