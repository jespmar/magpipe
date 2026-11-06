import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';
import prettier from 'eslint-config-prettier/flat';

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'out/**',
      'dist-electron/**',
      'release/**',
      'next-env.d.ts',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    // The Electron main/preload processes are plain Node — no React/Next rules apply.
    files: ['electron/**/*.ts', 'scripts/**/*.mjs'],
    rules: { '@next/next/no-assign-module-variable': 'off' },
  },
  prettier,
];

export default config;
