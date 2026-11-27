import { defineConfig } from "@playwright/test";

// The built page in a real browser, against the real backend in tools/preview.ts with its pretend
// switcher and tally sender. Run `pnpm build` first. Nothing reaches a real switcher or router.
const port = Number(process.env.TSL_UI_PORT || 43198);
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 5_000 },
  reporter: [["list"]],
  outputDir: "artifacts/ui-test-results",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1500, height: 900 },
    colorScheme: "dark",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm preview",
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 20_000,
    env: {
      TSL_PREVIEW_PORT: String(port),
      TSL_PREVIEW_LISTEN_PORT: String(Number(process.env.TSL_UI_LISTEN_PORT || 45728)),
      TSL_PREVIEW_CAMERAS: "4",
    },
  },
});
