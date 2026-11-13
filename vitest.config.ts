import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "modules/**/test/**/*.test.ts",
      "test/fixtures/**/test/**/*.test.ts",
      "packages/**/test/**/*.test.ts",
    ],
    exclude: [
      "packages/module-tools/**",
      // These use node:test and run through scripts/modules.mjs test <module>.
      "modules/cyanview-config/test/**",
      "modules/venice-camera-control/test/**",
      "templates/**",
      "**/node_modules/**",
      "**/dist/**",
    ],
    testTimeout: 15000,
  },
});
