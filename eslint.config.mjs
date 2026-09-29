import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

const config = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    ignores: ['.next/**', 'node_modules/**', 'public/**', '.scratch/**', 'test-results/**', 'playwright-report/**', 'next-env.d.ts'],
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Privacy boundary: local analysis and storage must never reach the network.
    files: ['src/analysis/local/**/*.ts', 'src/storage/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error',
        { name: 'fetch', message: 'Local analysis and storage must not make network requests.' },
        { name: 'XMLHttpRequest', message: 'Local analysis and storage must not make network requests.' },
        { name: 'WebSocket', message: 'Local analysis and storage must not make network requests.' },
        { name: 'EventSource', message: 'Local analysis and storage must not make network requests.' },
      ],
      'no-restricted-imports': ['error', { patterns: [{ group: ['@/analysis/ai-client/*', '@/server/*'], message: 'Local layers must not depend on network layers.' }] }],
    },
  },
  {
    // Only the AI client may send text off the device.
    files: ['src/editor/**/*.ts', 'src/suggestions/**/*.ts', 'src/analysis/scheduler/**/*.ts', 'src/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-globals': ['error',
        { name: 'fetch', message: 'Only src/analysis/ai-client may send text over the network.' },
        { name: 'XMLHttpRequest', message: 'Only src/analysis/ai-client may send text over the network.' },
      ],
      'no-restricted-imports': ['error', { patterns: [{ group: ['@/server/*'], message: 'Client code must not import server modules.' }] }],
    },
  },
];

export default config;
