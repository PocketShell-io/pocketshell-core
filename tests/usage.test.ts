import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  parseUsageNdjson,
  UsageParseError,
  usageDisplayName,
  usageIsBlocked,
  usageIsNearLimit,
  usageMostConstrainedWindow,
  usageThresholdState,
} from '../src/usage.js';

const quseFixture = readFileSync(
  new URL('./fixtures/usage/quse-0.0.15-usage.ndjson', import.meta.url),
  'utf8',
);

function line(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    provider: 'codex',
    status: 'ok',
    error: null,
    windows: { '7d': { percent_remaining: 25, reset_at: '2026-09-03T16:26:48Z' } },
    ...overrides,
  });
}

describe('usage NDJSON contract', () => {
  it('reads the pinned quse producer fixture and keeps its canonical window keys', () => {
    const records = parseUsageNdjson(quseFixture);
    expect(records.map((record) => record.provider)).toEqual([
      'claude', 'codex', 'copilot', 'go', 'grok', 'zai',
    ]);
    expect(records[0]).toMatchObject({
      provider: 'claude',
      status: 'ok',
      windows: [
        { name: '5h', used: 6, limit: 100, unit: 'percent', resetAt: '2026-08-28T16:20:00.000Z' },
        { name: '7d', used: 10, resetAt: '2026-09-03T15:00:00.000Z' },
      ],
    });
    expect(records[1]?.windows.map((window) => window.name)).toEqual(['7d']);
    expect(records[1]?.resetCredits).toEqual({
      availableCount: 1,
      credits: [{ title: 'Full reset', expiresAt: '2026-09-21T00:13:17.000Z' }],
      unavailable: false,
    });
    // Provider details may contain their own windows; only top-level windows drive quota state.
    expect(usageMostConstrainedWindow(records[1]!)?.name).toBe('7d');
  });

  it('rejects malformed NDJSON and schema drift as a whole-panel parse error', () => {
    expect(() => parseUsageNdjson(`${line()}\nnot json`)).toThrow(UsageParseError);
    expect(() => parseUsageNdjson(line({ provider: '' }))).toThrow(/provider/);
    expect(() => parseUsageNdjson(line({ windows: [] }))).toThrow(/windows/);
    expect(() => parseUsageNdjson(line({ windows: { '7d': {} } }))).toThrow(/percent_remaining/);
    expect(() => parseUsageNdjson(line({ windows: { '7d': { percent_remaining: 'NaN' } } })))
      .toThrow(/percent_remaining/);
    expect(() => parseUsageNdjson(line({ windows: { '7d': { percent_remaining: 50, reset_at: 'tomorrow' } } })))
      .toThrow(/reset_at/);
  });

  it('omits non-applicable windows and clamps percentages without inventing resets', () => {
    const [record] = parseUsageNdjson(line({ windows: {
      '5h': { percent_remaining: null, reset_at: null },
      custom: { percent_remaining: -10, reset_at: null },
    } }));
    expect(record?.windows).toEqual([{ name: 'custom', used: 100, limit: 100, unit: 'percent', resetAt: null }]);
  });

  it('maps quota status and threshold decisions at 80, 95 and 100 percent used', () => {
    const recordAt = (used: number) => parseUsageNdjson(line({
      windows: { weekly: { percent_remaining: 100 - used, reset_at: null } },
    }))[0]!;
    expect(usageThresholdState(recordAt(79.9))).toBe('ok');
    expect(usageThresholdState(recordAt(80))).toBe('approaching');
    expect(usageThresholdState(recordAt(95))).toBe('critical');
    expect(usageThresholdState(recordAt(100))).toBe('exceeded');
    expect(usageIsNearLimit(recordAt(85))).toBe(true);
    expect(usageIsBlocked(recordAt(100))).toBe(true);
    expect(usageThresholdState(recordAt(50), 50)).toBe('approaching');
  });

  it('keeps unknown statuses safe and gives known authentication errors actionable text', () => {
    const [unknown] = parseUsageNdjson(line({ status: 'future-state' }));
    expect(unknown?.status).toBe('unknown');
    expect(unknown?.rawStatus).toBe('future-state');
    const [codex] = parseUsageNdjson(line({ error: 'no auth token', status: 'error' }));
    expect(codex?.lastError).toContain('codex login');
    expect(usageDisplayName('open-code')).toBe('OpenCode');
    expect(usageDisplayName('new_vendor')).toBe('New Vendor');
  });

  it('preserves only available Codex credits in source order and rejects a count mismatch', () => {
    const credits = [
      { status: 'available', title: 'First', expires_at: '2026-09-21T00:13:17Z' },
      { status: 'used', title: 'Ignore this', expires_at: null },
      { status: 'available', title: 'First', expires_at: '2026-09-21T00:13:17Z' },
    ];
    const [record] = parseUsageNdjson(line({ details: {
      reset_credits_available: 2,
      reset_credits: credits,
      reset_credits_error: null,
    } }));
    expect(record?.resetCredits?.credits.map((credit) => credit.title)).toEqual(['First', 'First']);
    expect(() => parseUsageNdjson(line({ details: {
      reset_credits_available: 3,
      reset_credits: credits,
      reset_credits_error: null,
    } }))).toThrow(/does not match/);
    const [unavailable] = parseUsageNdjson(line({ details: {
      reset_credits_available: null,
      reset_credits: null,
      reset_credits_error: 'private error text',
    } }));
    expect(unavailable?.resetCredits).toEqual({ availableCount: null, credits: [], unavailable: true });
  });
});
