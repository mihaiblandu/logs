import { defineConfig } from '@playwright/test';

// Needs the stack running: ../start-all.sh (6 services on ELK), the ELK backend, and the Vue dev
// server (cd ../todo-vue && npx vite) for the UI test.
export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.UI_URL || 'http://localhost:5173',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
