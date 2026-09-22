/**
 * One self-contained file for embedded JS engines (the Android path): the
 * whole contract layer as an IIFE installing a single `PocketShellCore`
 * global. The Android app evaluates this after embed/host-shims.js and talks
 * to the same functions the desktop and web apps import.
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'PocketShellCore',
  target: 'es2020',
  outfile: 'embed/pocketshell-core.js',
  minify: false,
  sourcemap: false,
  logLevel: 'info',
});
