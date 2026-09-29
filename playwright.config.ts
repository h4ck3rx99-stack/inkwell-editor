import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3217);
const useProd = process.env.E2E_PROD !== '0';

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 } }, testIgnore: /mobile\.spec/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec/ },
  ],
  webServer: {
    // The production build is exercised by default; E2E_PROD=0 uses the dev server.
    command: useProd ? `pnpm exec next start -p ${PORT} -H 127.0.0.1` : `pnpm exec next dev -p ${PORT} -H 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/api/ai/status`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      INKWELL_AI_PROVIDER: 'mock',
      INKWELL_MOCK_LATENCY_MS: '120',
      INKWELL_RATE_LIMIT_PER_MIN: '100000',
    },
  },
});
