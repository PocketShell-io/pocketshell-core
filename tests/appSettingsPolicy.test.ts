import { describe, expect, it } from 'vitest';
import {
  ADVANCED_SETTING_DEFAULTS,
  BACKGROUND_GRACE_OPTIONS,
  DEFAULT_BACKGROUND_GRACE_MS,
  DEFAULT_MAX_BACKGROUND_GRACE_MS,
  DEFAULT_SUBMIT_ENTER_DELAY_MS,
  USAGE_DEFAULT_WARN_PERCENT,
  composerTiming,
  parseBackgroundGraceMs,
  parseBoolean,
  parseSubmitEnterDelayMs,
  parseUsageWarnPercent,
  parseUsageWarnPercentSetting,
} from '../src';

describe('shared app settings policy', () => {
  it('offers every 0.5.x grace window up to the controller cap and refuses anything else', () => {
    expect(BACKGROUND_GRACE_OPTIONS.map((option) => option.milliseconds)).toEqual([30_000, 60_000, 90_000, 300_000, 600_000]);
    expect(Math.max(...BACKGROUND_GRACE_OPTIONS.map((option) => option.milliseconds))).toBe(DEFAULT_MAX_BACKGROUND_GRACE_MS);
    expect(DEFAULT_BACKGROUND_GRACE_MS).toBe(90_000);
    expect(parseBackgroundGraceMs(600_000)).toBe(600_000);
    expect(parseBackgroundGraceMs('60000')).toBe(60_000);
    expect(parseBackgroundGraceMs(45_000)).toBeUndefined();
    expect(parseBackgroundGraceMs('')).toBeUndefined();
    expect(parseBackgroundGraceMs(null)).toBeUndefined();
  });

  it('snaps the composer Enter delay to the 0–1000 ms grid and defaults to the composer timing', () => {
    expect(DEFAULT_SUBMIT_ENTER_DELAY_MS).toBe(composerTiming.submitDelayMs);
    expect(parseSubmitEnterDelayMs(150)).toBe(150);
    expect(parseSubmitEnterDelayMs(174)).toBe(150);
    expect(parseSubmitEnterDelayMs(176)).toBe(200);
    expect(parseSubmitEnterDelayMs(-10)).toBe(0);
    expect(parseSubmitEnterDelayMs(5_000)).toBe(1_000);
    expect(parseSubmitEnterDelayMs('abc')).toBeUndefined();
  });

  it('snaps the usage warning threshold to 50–95 % in 5 % steps', () => {
    expect(parseUsageWarnPercent(65)).toBe(65);
    expect(parseUsageWarnPercent(67)).toBe(65);
    expect(parseUsageWarnPercent(68)).toBe(70);
    expect(parseUsageWarnPercent(10)).toBe(50);
    expect(parseUsageWarnPercent(99)).toBe(95);
    expect(parseUsageWarnPercent({})).toBeUndefined();
    expect(ADVANCED_SETTING_DEFAULTS).toEqual({ usageWarnPercent: null, submitEnterDelayMs: DEFAULT_SUBMIT_ENTER_DELAY_MS });
    expect(parseUsageWarnPercentSetting(null)).toBeNull();
    expect(parseUsageWarnPercentSetting(62)).toBe(60);
    expect(parseUsageWarnPercentSetting('x')).toBeUndefined();
    expect(USAGE_DEFAULT_WARN_PERCENT).toBe(80);
  });

  it('accepts only real booleans for switches', () => {
    expect(parseBoolean(false)).toBe(false);
    expect(parseBoolean('false')).toBeUndefined();
  });
});
