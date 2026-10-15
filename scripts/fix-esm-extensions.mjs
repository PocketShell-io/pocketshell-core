/**
 * Sources keep extensionless relative imports (verbatim from the desktop
 * repo). Every bundler resolves those, but plain-Node ESM needs explicit
 * specifiers to import dist/esm directly. This pass rewrites only the emitted
 * specifiers, never the sources, in every .js file under dist/esm (all
 * subdirectories): `import … from`, `export … from`, bare `import '…'` and
 * dynamic `import('…')`. A specifier naming a directory becomes `…/index.js`.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not .pathname: a file:// URL decodes to /D:/a/... on
// Windows, which fs then mangles into a doubled drive letter.
const root = fileURLToPath(new URL('../dist/esm', import.meta.url));

function* jsFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* jsFiles(path);
    else if (name.endsWith('.js')) yield path;
  }
}

function fixSpecifier(file, spec) {
  if (/\.(m?js|json)$/.test(spec)) return spec;
  const target = resolve(dirname(file), spec);
  if (existsSync(`${target}.js`)) return `${spec}.js`;
  if (existsSync(join(target, 'index.js'))) return `${spec}/index.js`;
  return `${spec}.js`;
}

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.\.?\/[^'"]*)\2/g;
let count = 0;
for (const file of jsFiles(root)) {
  const before = readFileSync(file, 'utf8');
  const after = before.replace(SPECIFIER, (_, head, quote, spec) => `${head}${quote}${fixSpecifier(file, spec)}${quote}`);
  if (after !== before) {
    writeFileSync(file, after);
    count += 1;
  }
}
console.log(`fixed esm import extensions (${count} files)`);
