// Flat config shared by every service and lib (docs/06-implementation-rules.md §1.5).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/.turbo/**', 'tools/**', 'docs/**', '.momentum/**', '.githooks/**', 'scripts/**', '.agent/**', '*.cjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // PII must never reach logs: use libs/observability, never console (conventions §7).
      'no-console': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
