import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseUsageNdjson } from '../src/usageParsers.js';
import {
  usageDisplayName,
  usageIsBlocked,
  usageIsNearLimit,
  usageMostConstrainedWindow,
  usageThresholdState,
  usageWindowDisplayLabel,
  usageWindowPercent,
} from '../src/usagePolicy.js';
import type { UsageRow } from '../src/transport.js';

const fixture = readFileSync(
  new URL('./fixtures/usage/quse-0.0.15-usage.ndjson', import.meta.url),
  'utf8',
);

/**
 * Captured verbatim from the quse build (0.0.16) that unified every
 * provider's banked resets into one `banked_resets` shape — the provider's
 * own records, flattened by the helper's passthrough boundary into the
 * per-provider NDJSON.
 */
const bankedFixture = readFileSync(
  new URL('./fixtures/usage/quse-0.0.16-banked-usage.ndjson', import.meta.url),
  'utf8',
);

function row(status: string, remaining: number | null): UsageRow {
  return {
    provider: 'codex',
    status,
    windows: [{ window: 'weekly', percent_remaining: remaining, reset_at: null }],
    error: null,
    details: {},
    resets_available: null,
    resets_expire_at: null,
  };
}

describe('usage display and quota policy over transport rows', () => {
  it('consumes the shared quse fixture through the current canonical parser', () => {
    const records = parseUsageNdjson(fixture);
    expect(records.map((record) => record.provider)).toEqual([
      'claude', 'codex', 'copilot', 'go', 'grok', 'zai',
    ]);
    expect(records[0]?.windows.map((window) => window.window)).toEqual(['5h', '7d']);
    expect(usageMostConstrainedWindow(records[0]!)?.window).toBe('7d');
    expect(usageWindowPercent(records[0]!.windows[0]!)).toBe(6);
  });

  it('maps known providers and gives unfamiliar names readable labels', () => {
    expect(usageDisplayName('claude')).toBe('Claude Code');
    expect(usageDisplayName('open-code')).toBe('OpenCode');
    expect(usageDisplayName('github_copilot')).toBe('GitHub Copilot');
    expect(usageDisplayName('new_vendor')).toBe('New Vendor');
  });

  it('labels named windows case-insensitively and formats custom spans', () => {
    expect(usageWindowDisplayLabel('5h')).toBe('5h window');
    expect(usageWindowDisplayLabel('7d')).toBe('7d window');
    expect(usageWindowDisplayLabel('weekly')).toBe('Weekly limit');
    expect(usageWindowDisplayLabel('MONTHLY')).toBe('Monthly limit');
    expect(usageWindowDisplayLabel('per-provider_window')).toBe('Per Provider Window');
    expect(usageWindowDisplayLabel('')).toBe('Custom span');
  });

  it('derives used percentage and threshold state from remaining percentage', () => {
    const recordAt = (used: number) => row('ok', 100 - used);
    expect(usageWindowPercent(recordAt(75).windows[0]!)).toBe(75);
    expect(usageThresholdState(recordAt(79.9))).toBe('ok');
    expect(usageThresholdState(recordAt(80))).toBe('approaching');
    expect(usageThresholdState(recordAt(95))).toBe('critical');
    expect(usageThresholdState(recordAt(100))).toBe('exceeded');
    expect(usageIsNearLimit(recordAt(85))).toBe(true);
    expect(usageIsBlocked(recordAt(100))).toBe(true);
    expect(usageThresholdState(recordAt(50), 50)).toBe('approaching');
  });

  it('treats limited status as blocked and ignores windows without a meter', () => {
    expect(usageThresholdState(row('limited', null))).toBe('exceeded');
    expect(usageIsBlocked(row('blocked', 50))).toBe(true);
    expect(usageWindowPercent(row('ok', null).windows[0]!)).toBeNull();
    expect(usageMostConstrainedWindow(row('ok', null))).toBeNull();
    expect(usageThresholdState(row('ok', null))).toBe('ok');
  });

  it('skips malformed host lines and still reads valid partial output', () => {
    const partial = [
      'not json',
      JSON.stringify({
        provider: 'codex',
        status: 'ok',
        error: null,
        windows: { weekly: { percent_remaining: 5, reset_at: null } },
      }),
    ].join('\n');
    const records = parseUsageNdjson(partial);
    expect(records).toHaveLength(1);
    expect(usageThresholdState(records[0]!)).toBe('critical');
  });

  it('reads the unified banked_resets shape, and dates the count with its soonest entry', () => {
    const records = parseUsageNdjson(bankedFixture);
    // Every provider now carries the count under `banked_resets_available` —
    // claude and zai included, which the 0.0.15 shape could not speak for.
    expect(records.map((r) => r.resets_available)).toEqual([0, 3, null, null, 0, 5]);
    // The count is dated with the soonest AVAILABLE entry's expiry — zai's
    // five banked weekly resets expire across two dates; the earliest one is
    // the note's. A spent (available: false) entry must not date it: grok's
    // count is 0 and its array empty, so no expiry either way.
    expect(records[1]!.resets_expire_at).toBe('2026-10-05T04:19:54Z');
    expect(records[4]!.resets_expire_at).toBeNull();
    expect(records[5]!.resets_expire_at).toBe('2026-10-18T09:47:03Z');
  });
});
