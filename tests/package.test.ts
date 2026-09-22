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
});
