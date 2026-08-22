// Flat config (ESLint 9). Advisory linting for a large legacy codebase:
// correctness rules from js.configs.recommended run as ERRORS, while noisy
// style/consistency rules are demoted to WARNINGS so CI fails only on real
// problems. Tighten over time.
import js from '@eslint/js';

const nodeGlobals = {
  console: 'readonly',
  process: 'readonly',
  Buffer: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  performance: 'readonly',
  crypto: 'readonly',
  global: 'writable',
  globalThis: 'readonly',
};

export default [
  {
    ignores: ['node_modules/**', 'build/**', 'web/**', 'scratch/**', 'content/**', 'check_*.js'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      globals: nodeGlobals,
    },
    rules: {
      // Demoted to warnings — legacy codebase hygiene, fix opportunistically:
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|next' }],
      'no-empty': 'warn',
      'no-control-regex': 'off',
      'no-useless-escape': 'warn',
      'no-prototype-builtins': 'warn',
      'no-fallthrough': 'warn',
      'no-async-promise-executor': 'warn',
      'no-constant-condition': ['warn', { checkLoops: false }],
      // Emoji-heavy duel-marker regexes rely on surrogate-pair matching; adding
      // the 'u' flag would change their semantics.
      'no-misleading-character-class': 'warn',
    },
  },
  {
    // ESM app code
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: { describe: 'readonly', it: 'readonly', before: 'readonly', after: 'readonly' },
    },
  },
  {
    // Ad-hoc CommonJS probe scripts (*.cjs)
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
  },
];
