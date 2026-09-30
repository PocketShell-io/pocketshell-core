import { describe, expect, it } from 'vitest';
import * as core from '../src/index';

/**
 * Value assertions that used to live only in the deleted embed verifier
 * (scripts/verify-embed.mjs). They run through the package index, the way
 * every client imports them.
 */
describe('portable core values', () => {
  it('formats byte counts', () => {
    expect(core.formatBytes(512)).toBe('512 B');
    expect(core.formatBytes(1536)).toBe('1.5 KB');
  });

  it('single-quotes shell words', () => {
    expect(core.shellQuote('a b')).toBe("'a b'");
  });

  it('builds the aplexer snapshot command with and without a sort key', () => {
    expect(core.aplexerSnapshotCommand()).toBe('a snapshot --json');
    expect(core.aplexerSnapshotCommand('created')).toBe('a snapshot --json --sort created');
  });

  it('parses an ssh_config directive line', () => {
    expect(core.parseDirectiveLine('Host dev-box', 1)).toEqual({ key: 'host', value: 'dev-box', line: 1 });
    expect(core.parseDirectiveLine('# comment', 2)).toBeNull();
  });

  it('accepts only valid TCP ports', () => {
    expect(core.isValidTcpPort(8080)).toBe(true);
    expect(core.isValidTcpPort(0)).toBe(false);
    expect(core.isValidTcpPort(65536)).toBe(false);
  });
});
