import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run the production build (vite preview serves vercel.json's
// headers, so the real CSP applies) against an offline API and RPCs
// (e2e/fixtures.ts). Nothing leaves the machine.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: 'http://localhost:4175', trace: 'retain-on-failure' },
  // Run on the installed Google Chrome with its sandbox on: Playwright's bundled
  // Chromium lags Chrome security fixes and launches with --no-sandbox by default.
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        launchOptions: { chromiumSandbox: true },
      },
    },
  ],
  webServer: {
    command: 'npx vite preview --port 4175 --strictPort',
    url: 'http://localhost:4175',
    reuseExistingServer: !process.env.CI,
  },
});
