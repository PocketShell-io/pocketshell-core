import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as core from '../src/index';

/**
 * The package face. Every app imports from here, so the index must keep
 * re-exporting the whole contract layer — a module dropped from the index
 * silently reverts an app to its own stale copy, which is exactly the bug
 * this package exists to kill.
 */
describe('@pocketshell/core index', () => {
  it('exposes every contract module', () => {
    for (const name of [
      'shellQuote',
      'shellQuoteRemotePath',
      'USER_BIN_PATH',
      'APLEXER_LIST_SORT',
      'parseAplexerSnapshot',
      'parseAplexerWarnings',
      'parseSingleAplexerRecord',
      'AplexerCore',
      'aplexerStartCommand',
      'aplexerSnapshotCommand',
      'buildLaunchCommand',
      'KIND_LABELS',
      'LOOPBACK_HOST',
      'MAX_PORT',
      'formatBytes',
    ]) {
      expect(core, `missing export: ${name}`).toHaveProperty(name);
    }
  });

  it('re-exports each module exactly once', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const modules = [...source.matchAll(/^export \* from '([^']+)';$/gm)].map((match) => match[1]);
    expect(modules.length).toBeGreaterThan(0);
    const duplicates = modules.filter((name, index) => modules.indexOf(name) !== index);
    expect(duplicates, 'modules exported more than once from src/index.ts').toEqual([]);
  });
});
