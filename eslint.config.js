import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/',
      'reports/',
    ],
  },
  js.configs.recommended,
  {
    files: ['server.js', 'lib/**/*.js', 'scripts/**/*.mjs', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
  },
  {
    // Application code logs through lib/logger.js so every line is JSON with
    // request_id; scripts/ and tests keep plain console output.
    files: ['server.js', 'lib/**/*.js'],
    rules: {
      'no-console': 'error',
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    files: ['public/pods.js', 'public/telemetry.js'],
    languageOptions: { sourceType: 'module' },
  },
];
