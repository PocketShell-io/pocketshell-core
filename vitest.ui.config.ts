import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Unit tests for the shared UI package's pure modules and Pinia stores. They
 * resolve the package's aliases and its own Vue/Pinia install (the root
 * package deliberately carries no UI runtime), so run them after
 * `npm ci` in packages/ui: `npm run test:ui`.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@ui\/(.*)$/, replacement: fromRoot('./packages/ui/src/$1') },
      { find: /^@pocketshell\/core\/(.*)$/, replacement: fromRoot('./src/$1') },
      { find: /^@pocketshell\/core$/, replacement: fromRoot('./src/index.ts') },
      { find: /^vue$/, replacement: fromRoot('./packages/ui/node_modules/vue/index.mjs') },
      { find: /^pinia$/, replacement: fromRoot('./packages/ui/node_modules/pinia/dist/pinia.mjs') },
    ],
  },
  test: {
    include: ['tests/ui/**/*.test.ts'],
  },
});
