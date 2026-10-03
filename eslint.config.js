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
    // Los módulos de negocio acceden a datos SOLO con tenantDb(). El cliente base (sin filtro de cuenta)
    // queda para core/, auth, me (datos del propio usuario) y el panel de plataforma.
    files: ['src/modules/**/*.ts'],
    // public: busca la iglesia por slug antes de que haya cuenta en contexto; escribe con tenantClientFor.
    // billing: el webhook, el proceso diario y la plataforma operan sobre cualquier cuenta.
    ignores: [
      'src/modules/auth/**',
      'src/modules/billing/**',
      'src/modules/me/**',
      'src/modules/health/**',
      'src/modules/platform/**',
      'src/modules/public/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/core/db/prisma.js'],
              message: 'Usá tenantDb() de core/db/tenant.js: el cliente base no filtra por cuenta.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/core/db/**', 'prisma/seed/**', 'scripts/**', 'test/**'],
    rules: { 'no-restricted-syntax': 'off', 'no-console': 'off' },
  },
);
