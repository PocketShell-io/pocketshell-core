import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // tests/ui needs the UI package's own toolchain: `npm run test:ui`.
    exclude: ['tests/ui/**', 'node_modules/**'],
  },
});
