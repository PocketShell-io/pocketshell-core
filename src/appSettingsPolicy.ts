import { composerTiming } from './composerSend';
import { DEFAULT_MAX_BACKGROUND_GRACE_MS } from './connectionController';
import { USAGE_CRITICAL_PERCENT, USAGE_DEFAULT_WARN_PERCENT } from './usagePolicy';

/**
 * Portable preference policy shared by every PocketShell client's settings
 * store: the offered values, defaults and tolerant parsers for the lifecycle,
 * composer and usage preferences carried over from the 0.5.x Android client.
 *
 * A parser returns `undefined` for a value it cannot trust, which a settings
 * store reads as "use the default" (the shared UI store's SettingSpec shape).
 * Numeric strings are accepted so a migrated Android preference (stored as a
 * `long` string) parses the same as a JSON number.
 */

function asNumber(raw: unknown): number | undefined {
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function snap(value: number, min: number, max: number, step: number): number {
  const clamped = Math.min(max, Math.max(min, value));
  const steps = Math.round((clamped - min) / step);
  return Math.min(max, min + steps * step);
}

/* --- Background grace ---------------------------------------------------- */

export interface BackgroundGraceOption {
  milliseconds: number;
  label: string;
  detail: string;
}

/** Every window the 0.5.x client offered, ascending; the list is the whole domain. */
export const BACKGROUND_GRACE_OPTIONS: readonly BackgroundGraceOption[] = [
  { milliseconds: 30_000, label: '30 seconds', detail: 'Good for switching apps' },
  { milliseconds: 60_000, label: '1 minute', detail: 'More time between app switches' },
  { milliseconds: 90_000, label: '90 seconds', detail: 'Default recovery window' },
  { milliseconds: 5 * 60_000, label: '5 minutes', detail: 'Longer app switches' },
  { milliseconds: DEFAULT_MAX_BACKGROUND_GRACE_MS, label: '10 minutes', detail: 'Extended recovery window' },
];

/** 90 seconds: the maintainer's default since #1159, and the controller-era default. */
export const DEFAULT_BACKGROUND_GRACE_MS = 90_000;

/** An offered grace window, or undefined for anything else (never an unreachable picker state). */
export function parseBackgroundGraceMs(raw: unknown): number | undefined {
  const value = asNumber(raw);
  return BACKGROUND_GRACE_OPTIONS.find((option) => option.milliseconds === value)?.milliseconds;
}

/** Whether a dropped session reconnects automatically on return (0.5.x `reconnect_when_return`). */
export const DEFAULT_RECONNECT_ON_RETURN = true;

export function parseBoolean(raw: unknown): boolean | undefined {
  return typeof raw === 'boolean' ? raw : undefined;
}

/* --- Composer Enter delay ------------------------------------------------ */

export const SUBMIT_ENTER_DELAY_MIN_MS = 0;
export const SUBMIT_ENTER_DELAY_MAX_MS = 1_000;
export const SUBMIT_ENTER_DELAY_STEP_MS = 50;
/** The shared composer's own default, so a user who never moves the slider sees no change. */
export const DEFAULT_SUBMIT_ENTER_DELAY_MS = composerTiming.submitDelayMs;

/** Pause between a pasted body and its submit Enter, snapped to the 50 ms grid within 0–1000 ms. */
export function parseSubmitEnterDelayMs(raw: unknown): number | undefined {
  const value = asNumber(raw);
  return value === undefined
    ? undefined
    : snap(value, SUBMIT_ENTER_DELAY_MIN_MS, SUBMIT_ENTER_DELAY_MAX_MS, SUBMIT_ENTER_DELAY_STEP_MS);
}

/* --- Usage warning threshold --------------------------------------------- */

export const USAGE_WARN_MIN_PERCENT = 50;
/** One step below critical: critical (95 %) and exceeded (100 %) stay fixed. */
export const USAGE_WARN_MAX_PERCENT = USAGE_CRITICAL_PERCENT;
export const USAGE_WARN_STEP_PERCENT = 5;

/** The "approaching limit" percentage, snapped to 50–95 % in 5 % steps. */
export function parseUsageWarnPercent(raw: unknown): number | undefined {
  const value = asNumber(raw);
  return value === undefined
    ? undefined
    : snap(value, USAGE_WARN_MIN_PERCENT, USAGE_WARN_MAX_PERCENT, USAGE_WARN_STEP_PERCENT);
}

/* --- Advanced reset ------------------------------------------------------ */

/**
 * The values Settings → Advanced "Reset advanced defaults" restores, in one
 * snapshot. Theme, text size and grace have their own pages and are outside it.
 */
export const ADVANCED_SETTING_DEFAULTS = Object.freeze({
  usageWarnPercent: USAGE_DEFAULT_WARN_PERCENT,
  submitEnterDelayMs: DEFAULT_SUBMIT_ENTER_DELAY_MS,
});
