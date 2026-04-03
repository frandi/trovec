import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/__stress__/**/*.test.ts'],
    testTimeout: 120_000,
  },
});
