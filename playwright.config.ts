import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3210);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

/**
 * The pre-installed Chromium in this environment may not match the build
 * @playwright/test expects, so an explicit executablePath is honoured when set.
 * Locally and in CI, Playwright's own download is used.
 */
const executablePath = process.env.CHROMIUM_PATH || undefined;

/**
 * Device profiles with `isMobile` force a fresh browser launch rather than
 * reusing the default one, and a container running as root needs --no-sandbox
 * for that launch to succeed. Harmless in CI, required here.
 */
const launchOptions = {
  ...(executablePath ? { executablePath } : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
};

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions,
  },

  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, launchOptions },
      testIgnore: /(tablet|mobile)\.spec\.ts/,
    },
    {
      // §10.4 — NOC uses tablets on the floor, so tablet is a first-class
      // target rather than an afterthought.
      //
      // Defined explicitly rather than borrowing `devices['iPad …']`, whose
      // defaultBrowserType is webkit — that profile would try to drive the
      // Chromium binary over WebKit's protocol. What matters here is the
      // viewport and touch, not the engine.
      name: 'tablet',
      use: {
        ...devices['Desktop Chrome'],
        browserName: 'chromium',
        viewport: { width: 1080, height: 810 },
        deviceScaleFactor: 2,
        hasTouch: true,
        isMobile: false,
        launchOptions,
      },
      testMatch: /tablet\.spec\.ts/,
    },
    {
      // Mobile gets the hub and /stores only — §10.4 is explicit that a
      // 12-column store matrix does not work on a phone.
      name: 'mobile',
      use: { ...devices['Pixel 7'], launchOptions },
      testMatch: /mobile\.spec\.ts/,
    },
  ],

  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : {
        command: `npx next start -p ${PORT}`,
        url: BASE_URL,
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
