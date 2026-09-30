import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));

// The shared UI's logic tests (stores, pure modules), resolved the way
// tsconfig.json resolves them: @pocketshell/core is this repo's own source.
// Components render in the clients' suites, which mount real views.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@pocketshell\/core$/, replacement: resolve(PACKAGE_ROOT, '../../src/index.ts') },
      { find: /^@pocketshell\/core\/(.*)$/, replacement: resolve(PACKAGE_ROOT, '../../src/$1') },
      { find: /^@ui\/(.*)$/, replacement: resolve(PACKAGE_ROOT, 'src/$1') },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
