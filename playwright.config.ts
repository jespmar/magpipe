import { defineConfig, devices } from '@playwright/test';

const PORT = 3457;

export default defineConfig({
  testDir: './e2e',
  // One shared database: specs run in file order, one file at a time, so exact counts hold.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 900 },
        // Point at a pre-installed Chromium when the bundled one is not downloaded.
        launchOptions: process.env.PW_CHROMIUM_PATH
          ? { executablePath: process.env.PW_CHROMIUM_PATH }
          : undefined,
      },
    },
  ],
  webServer: {
    command: `npx next dev --port ${PORT} --hostname 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Smoke tests exercise the shell, not sign-in.
    env: {
      MAGPIPE_AUTH_DISABLED: 'true',
      MAGPIPE_DATA_DIR: '.magpipe/e2e',
      // A throwaway key so the connect flow can store a pasted token.
      MAGPIPE_SECRET_KEY: 'ZTJlLXRlc3Qta2V5LWUyZS10ZXN0LWtleS1lMmUtdHM',
      // No model credentials in CI: a scripted model lets a run go queued → running → done.
      MAGPIPE_MODEL_STUB: 'scripted',
    },
  },
});
