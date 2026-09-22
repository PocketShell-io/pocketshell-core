/**
 * Sources keep extensionless relative imports (verbatim from the desktop
 * repo). Every bundler resolves those, but plain-Node ESM needs the explicit
 * .js — and the embed harness imports dist/esm directly. This pass rewrites
 * only the emitted specifiers, never the sources.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = new URL('../dist/esm', import.meta.url).pathname;

for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
  const path = join(dir, file);
  const out = readFileSync(path, 'utf8').replace(
    /(from\s+'|import\s+'|export\s+\*\s+from\s+')(\.\.?\/[^']+?)(?=')/g,
    (full, head, spec) => (spec.endsWith('.js') ? full : `${head}${spec}.js`),
  );
  writeFileSync(path, out);
}
console.log('fixed esm import extensions');
