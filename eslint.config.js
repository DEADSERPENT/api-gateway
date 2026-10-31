import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // load/ runs inside k6 (its own runtime and globals such as __ENV), not Node.
  { ignores: ['dist', 'node_modules', 'load', 'benchmarks', '.dev'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
);
