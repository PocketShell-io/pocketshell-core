import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Plain Node (psc, the MCP server) imports dist/esm directly, with no bundler
 * to resolve extensionless specifiers. scripts/fix-esm-extensions.mjs must
 * rewrite every emitted file, subdirectories included (dist/esm/keyVault/…
 * once failed with ERR_MODULE_NOT_FOUND). CI builds before the unit suite;
 * a local run without dist/ builds first.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ESM = `${ROOT}dist/esm`;

describe('dist/esm loads in plain Node', () => {
  it('imports the package index, the key vault and every shared subpath', () => {
    if (!existsSync(`${ESM}/index.js`)) execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });
    const entries = ['index.js', 'keyVault/index.js', ...readdirSync(`${ESM}/shared`).filter((f) => f.endsWith('.js')).map((f) => `shared/${f}`)];
    const script = `Promise.all(${JSON.stringify(entries)}.map((e) => import(${JSON.stringify(`${ESM}/`)} + e)))` +
      `.then((mods) => console.log(typeof mods[0].KeyVaultStore))`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: '/', encoding: 'utf8' });
    expect(out.trim()).toBe('function');
  }, 180_000);
});
