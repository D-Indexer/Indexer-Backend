// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Express augments Request through a global namespace declaration.
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
      // Ban non-null assertions (`!`) so the compiler's strictness (issue #256) is not
      // bypassed. Justified exceptions must use an inline
      // `// eslint-disable-next-line @typescript-eslint/no-non-null-assertion`
      // with an explanatory comment.
      '@typescript-eslint/no-non-null-assertion': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
    },
  },
  {
    // Tests build loose fakes; the logger and CLI write to the console by design.
    files: ['src/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
  {
    files: ['src/utils/logger.ts', 'src/indexer/cli.ts'],
    rules: { 'no-console': 'off' },
  },
  prettier
);