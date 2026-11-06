import { defineConfig, devices } from '@playwright/test'

// End-to-end tests run against a running instance (default: the LAN staging stack).
//   E2E_BASE_URL   instance to test (default http://localhost:4325, the staging proxy)
//   E2E_SHARE_SLUG a share slug of a project with open access (never commit real slugs)
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:4325',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
})
