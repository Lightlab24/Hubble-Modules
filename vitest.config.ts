import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['modules/**/test/**/*.test.ts', 'packages/**/test/**/*.test.ts'],
    exclude: ['packages/module-tools/**', 'templates/**', '**/node_modules/**', '**/dist/**'],
    testTimeout: 15000,
  },
})
