/** Platform-free display and quota decisions for the current transport row. */

import type { UsageRow, UsageWindow } from './transport.js';

export type UsageThresholdState = 'ok' | 'approaching' | 'critical' | 'exceeded';

export const USAGE_DEFAULT_WARN_PERCENT = 80;
export const USAGE_CRITICAL_PERCENT = 95;
export const USAGE_EXCEEDED_PERCENT = 100;
export const USAGE_NEAR_LIMIT_PERCENT = 85;

/** Stable provider labels shared by clients. Unknown providers keep a readable name. */
export function usageDisplayName(provider: string): string {
  switch (provider.toLowerCase()) {
    case 'claude': return 'Claude Code';
    case 'codex': return 'Codex';
    case 'go': return 'OpenCode Go';
    case 'opencode':
    case 'open_code':
    case 'open-code': return 'OpenCode';
    case 'copilot':
    case 'github_copilot':
    case 'github-copilot': return 'GitHub Copilot';
    case 'grok':
    case 'grok-build': return 'Grok Build';
    default: return provider.split(/[-_ ]/).filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') || provider;
  }
}

/** Display label for a producer-owned window name, including future custom spans. */
export function usageWindowDisplayLabel(name: string): string {
  switch (name.toLowerCase()) {
    case '5h': return '5h window';
    case '7d': return '7d window';
    case 'weekly': return 'Weekly limit';
    case 'monthly': return 'Monthly limit';
    default: return name.replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase()) || 'Custom span';
  }
}

/** Percent of the quota used, derived from the transport's remaining percentage. */
export function usageWindowPercent(window: UsageWindow): number | null {
  const remaining = window.percent_remaining;
  if (remaining === null || !Number.isFinite(remaining)) return null;
  return Math.max(0, Math.min(100, 100 - remaining));
}

/** The window with the highest reported usage; unmetered windows are ignored. */
export function usageMostConstrainedWindow(record: UsageRow): UsageWindow | null {
  let worst: UsageWindow | null = null;
  let worstPercent = -1;
  for (const window of record.windows) {
    const percent = usageWindowPercent(window);
    if (percent === null) continue;
    if (percent > worstPercent) {
      worst = window;
      worstPercent = percent;
    }
  }
  return worst;
}

function hasBlockedStatus(record: UsageRow): boolean {
  const status = record.status.toLowerCase().replace(/[- ]/g, '_');
  return [
    'blocked',
    'limited',
    'limit_reached',
    'exceeded',
    'exhausted',
    'exhausted_quota',
    'quota_exhausted',
    'quota_exceeded',
    'usage_exhausted',
    'usage_limit_reached',
    'rate_limited',
  ].includes(status);
}

export function usageIsBlocked(record: UsageRow): boolean {
  return hasBlockedStatus(record) ||
    record.windows.some((window) => (usageWindowPercent(window) ?? -1) >= USAGE_EXCEEDED_PERCENT);
}

export function usageIsNearLimit(record: UsageRow): boolean {
  return !usageIsBlocked(record) &&
    record.windows.some((window) => (usageWindowPercent(window) ?? -1) >= USAGE_NEAR_LIMIT_PERCENT);
}

/** Convert provider status and quota percentages to the shared meter state. */
export function usageThresholdState(
  record: UsageRow,
  warnPercent = USAGE_DEFAULT_WARN_PERCENT,
): UsageThresholdState {
  if (hasBlockedStatus(record)) return 'exceeded';
  const worst = usageMostConstrainedWindow(record);
  if (!worst) return 'ok';
  const percent = usageWindowPercent(worst);
  if (percent === null) return 'ok';
  return usagePercentThresholdState(percent, warnPercent);
}

/**
 * One meter's state from its used percentage: the user-tunable warning band,
 * then the fixed critical (95 %) and exceeded (100 %) bands.
 */
export function usagePercentThresholdState(
  usedPercent: number,
  warnPercent = USAGE_DEFAULT_WARN_PERCENT,
): UsageThresholdState {
  if (usedPercent >= USAGE_EXCEEDED_PERCENT) return 'exceeded';
  if (usedPercent >= USAGE_CRITICAL_PERCENT) return 'critical';
  if (usedPercent >= warnPercent) return 'approaching';
  return 'ok';
}

export type UsageMeterTone = 'ok' | 'approaching' | 'critical';

/**
 * A usage meter's colour band from the provider's REMAINING percentage.
 *
 * With no user threshold (`warnPercent` null — the default everywhere) the
 * shipped desktop/web bands are unchanged: more than 50 % left is ok, more
 * than 20 % left is approaching, anything less is critical. Only a user who
 * explicitly sets Settings → Advanced "Warn at" gets core's threshold bands:
 * approaching from that used percentage, critical from 95 % used.
 */
export function usageMeterTone(remainingPercent: number, warnPercent: number | null = null): UsageMeterTone {
  if (warnPercent === null) {
    if (remainingPercent > 50) return 'ok';
    if (remainingPercent > 20) return 'approaching';
    return 'critical';
  }
  const state = usagePercentThresholdState(100 - remainingPercent, warnPercent);
  if (state === 'ok') return 'ok';
  if (state === 'approaching') return 'approaching';
  return 'critical';
}

