import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', workers: 1, fullyParallel: false, timeout: 30000,
  reporter: [['list'], ['json', { outputFile: 'artifacts/ui-results.json' }]],
  outputDir: 'artifacts/ui-test-results',
  use: { baseURL: 'http://127.0.0.1:43127', viewport: { width: 1600, height: 1100 }, colorScheme: 'dark', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'pnpm preview', url: 'http://127.0.0.1:43127', reuseExistingServer: false, timeout: 15000 },
});
