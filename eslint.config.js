import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'src/generated/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // El aislamiento multi-tenant depende del cliente Prisma extendido: SQL crudo solo en core/db.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'MemberExpression[property.name=/^\\$(queryRaw|executeRaw)(Unsafe)?$/]',
          message: 'SQL crudo solo en src/core/db (rompe el aislamiento multi-tenant).',
        },
      ],
    },
  },
  {
    files: ['src/core/db/**', 'prisma/seed/**', 'scripts/**', 'test/**'],
    rules: { 'no-restricted-syntax': 'off', 'no-console': 'off' },
  },
);
