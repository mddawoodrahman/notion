import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.agents/**', 'docs/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: 'module',
      },
    },
    rules: {
      'no-console': 'error',
      'eqeqeq': ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },
  {
    // Module dependency direction (SPEC §2.3). The pure `src/` modules never
    // import inward. `src/app.ts` and `src/server.ts` are the composition root
    // and are the only files allowed to wire db/ and routes/ together.
    files: ['src/config.ts', 'src/logger.ts', 'src/errors.ts', 'src/redact.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/db/**', '../db/*', '../../db/*'], message: 'src/ must not import db/.' },
            {
              group: ['**/sync/**', '../sync/*', '../../sync/*'],
              message: 'src/ must not import sync/.',
            },
            {
              group: ['**/routes/**', '../routes/*', '../../routes/*'],
              message: 'src/ must not import routes/.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['db/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/routes/**', '../routes/*'], message: 'db/ must not import routes/.' },
            { group: ['**/sync/**', '../sync/*'], message: 'db/ must not import sync/.' },
          ],
        },
      ],
    },
  },
  {
    files: ['sync/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/routes/**', '../routes/*'], message: 'sync/ must not import routes/.' },
          ],
        },
      ],
    },
  },
  {
    // CLI entrypoints are the only place that writes to stdout/stderr directly.
    files: ['scripts/**/*.ts', 'db/migrate.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
