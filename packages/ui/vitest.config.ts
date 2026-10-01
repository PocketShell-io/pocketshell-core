import vue from '@vitejs/plugin-vue';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * The ONE test setup for the shared UI (@pocketshell/ui). Any store,
 * composable or component suite drops a `tests/**\/*.test.ts` file here and
 * runs under `npm test` (core CI's "Gate @pocketshell/ui" step) with no
 * config change:
 *
 * - `.vue` single-file components compile through the Vue plugin, so a test
 *   can import and mount real components (`@vue/test-utils` is installed).
 * - Imports resolve exactly as tsconfig.json maps them: `@ui/*` is this
 *   package's `src/`, `@pocketshell/core` is the core source one level up.
 * - The default environment is `node`, like the desktop suite. A spec that
 *   needs a DOM opts in per file with a `// @vitest-environment jsdom`
 *   comment on its first line (jsdom is installed), so specs move between
 *   this package and the desktop suite unchanged.
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: [
      { find: /^@ui\/(.*)$/, replacement: `${resolve(PACKAGE_ROOT, 'src')}/$1` },
      { find: /^@pocketshell\/core\/(.*)$/, replacement: `${resolve(PACKAGE_ROOT, '../../src')}/$1` },
      { find: /^@pocketshell\/core$/, replacement: resolve(PACKAGE_ROOT, '../../src/index.ts') },
    ],
  },
  test: {
    root: PACKAGE_ROOT,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
