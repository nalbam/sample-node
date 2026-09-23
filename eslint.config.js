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
    files: ['server.js', 'lib/**/*.js', 'test/**/*.js', 'eslint.config.js'],
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
