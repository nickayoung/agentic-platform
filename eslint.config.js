import tseslint from 'typescript-eslint';
import kairos from 'eslint-plugin-kairos';

export default [
  { ignores: ['**/node_modules/**', '**/.wrangler/**', '**/dist/**', '.claude/**', 'tools/**'] },
  {
    files: ['**/*.ts'],
    languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' },
    plugins: { kairos, '@typescript-eslint': tseslint.plugin },
    rules: { 'kairos/no-async-in-tx': 'error' },
  },
  {
    // principle 4 / §14.1: engines and workflows never branch on kind; only packages/export may read it (D-56)
    files: ['packages/engine/**/*.ts', 'packages/workflow/**/*.ts'],
    rules: { 'kairos/no-kind-branch': 'error' },
  },
];
