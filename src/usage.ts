/** Strict, portable parser and quota policy for `pocketshell usage --json`. */

export type UsageStatus = 'ok' | 'warn' | 'blocked' | 'error' | 'unsupported' | 'unknown';
export type UsageThresholdState = 'ok' | 'approaching' | 'critical' | 'exceeded';

export interface UsageWindow {
  /** Producer-owned span key, such as `5h`, `7d`, `weekly`, or `monthly`. */
  name: string;
  /** Used percent points, normalized to 0..100. */
  used: number;
  limit: 100;
  unit: string;
  /** Canonical ISO timestamp, or null when no reset is reported. */
  resetAt: string | null;
}

export interface UsageResetCredit {
  title: string;
  /** Credit expiry is inventory metadata and is never a quota reset. */
  expiresAt: string | null;
}

export interface UsageResetCredits {
  availableCount: number | null;
  credits: UsageResetCredit[];
  unavailable: boolean;
}

export interface UsageProviderRecord {
  provider: string;
  status: UsageStatus;
  rawStatus: string;
  blockReason: string | null;
  lastError: string | null;
  windows: UsageWindow[];
  resetCredits: UsageResetCredits | null;
}

export class UsageParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UsageParseError';
  }
}

const RESET_CREDIT_TITLE_FALLBACK = 'Reset credit';
const RESET_CREDIT_TITLE_MAX_CHARS = 160;
export const USAGE_DEFAULT_WARN_PERCENT = 80;
export const USAGE_CRITICAL_PERCENT = 95;
export const USAGE_EXCEEDED_PERCENT = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new UsageParseError(`missing required string '${field}'`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new UsageParseError(`'${field}' must be a string or null`);
  return value.trim() || null;
}

function parseIsoInstant(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new UsageParseError(`invalid '${field}'`);
  const raw = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(raw);
  if (!match || !Number.isFinite(Date.parse(raw))) {
    throw new UsageParseError(`invalid '${field}': ${raw}`);
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) {
    throw new UsageParseError(`invalid '${field}': ${raw}`);
  }
  return new Date(raw).toISOString();
}

function parseResetAt(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const timestamp = value * 1000;
    if (Number.isFinite(timestamp)) {
      const date = new Date(timestamp);
      if (Number.isFinite(date.getTime())) return date.toISOString();
    }
    throw new UsageParseError(`invalid 'reset_at': ${String(value)}`);
  }
  return parseIsoInstant(value, 'reset_at');
}

function parseStatus(rawStatus: string): UsageStatus {
  const normalized = rawStatus.toLowerCase().replace(/[- ]/g, '_');
  if (['ok', 'healthy', 'available'].includes(normalized)) return 'ok';
  if (['warn', 'warning', 'near_limit'].includes(normalized)) return 'warn';
  if ([
    'blocked', 'limit_reached', 'limited', 'exhausted', 'exceeded', 'exhausted_quota',
    'quota_exhausted', 'quota_exceeded', 'usage_exhausted', 'usage_limit_reached', 'rate_limited',
  ].includes(normalized)) return 'blocked';
  if (normalized === 'error') return 'error';
  if (normalized === 'unsupported') return 'unsupported';
  return 'unknown';
}

function actionableProviderError(provider: string, error: string | null): string | null {
  const text = error?.trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  if (provider.toLowerCase() === 'claude' && (
    lower.includes('claude /login') || lower.includes('run `claude') || lower.includes('run claude') ||
    lower.includes('authentication failed') || lower.includes('http error 401') ||
    lower.includes('unauthorized') || lower === 'no-credentials' || lower === 'no credentials'
  )) {
    return 'Claude login needed on this host. Open Claude Code on the host and sign in, then refresh usage.';
  }
  if (provider.toLowerCase() === 'codex' && (
    lower === 'no auth token' || lower === 'no-auth-token' || lower === 'no credentials'
  )) {
    return 'Codex login needed on this host. Run `codex login` in the host shell, then refresh usage.';
  }
  if (['grok', 'grok-build'].includes(provider.toLowerCase()) && (
    lower === 'no-credentials' || lower === 'no credentials' || lower === 'no-auth-token' ||
    lower === 'no auth token' || lower.includes('auth.json')
  )) {
    return 'Grok login needed on this host. Sign in with `grok` on the host, then refresh usage.';
  }
  return text;
}

function parseResetCredits(record: Record<string, unknown>, provider: string): UsageResetCredits | null {
  if (provider.toLowerCase() !== 'codex' || record.details === undefined || record.details === null) return null;
  if (!isRecord(record.details)) throw new UsageParseError("'details' for codex is not an object");
  const details = record.details;
  const hasCount = Object.hasOwn(details, 'reset_credits_available');
  const hasCredits = Object.hasOwn(details, 'reset_credits');
  const hasError = Object.hasOwn(details, 'reset_credits_error');
  if (!hasCount && !hasCredits && !hasError) return null;

  if (hasError && details.reset_credits_error !== null && details.reset_credits_error !== undefined) {
    if (typeof details.reset_credits_error !== 'string' || !details.reset_credits_error.trim()) {
      throw new UsageParseError("invalid 'reset_credits_error' for codex");
    }
    return { availableCount: null, credits: [], unavailable: true };
  }
  if (!hasCount || !hasCredits || details.reset_credits_available === null || details.reset_credits === null) {
    throw new UsageParseError('codex reset_credits_available and reset_credits must be present together');
  }
  const count = details.reset_credits_available;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    throw new UsageParseError("invalid 'reset_credits_available' for codex");
  }
  if (!Array.isArray(details.reset_credits)) {
    throw new UsageParseError("'reset_credits' for codex is not an array");
  }
  const credits: UsageResetCredit[] = [];
  for (const [index, item] of details.reset_credits.entries()) {
    if (!isRecord(item)) throw new UsageParseError(`codex reset_credits[${index}] is not an object`);
    const status = item.status;
    if (typeof status !== 'string') {
      throw new UsageParseError(`invalid 'status' for codex reset_credits[${index}]`);
    }
    if (status !== 'available') continue;
    let title = RESET_CREDIT_TITLE_FALLBACK;
    if (item.title !== undefined && item.title !== null) {
      if (typeof item.title !== 'string') throw new UsageParseError("invalid reset-credit 'title' for codex");
      title = item.title.trim() || RESET_CREDIT_TITLE_FALLBACK;
    }
    credits.push({
      title: title.slice(0, RESET_CREDIT_TITLE_MAX_CHARS),
      expiresAt: parseIsoInstant(item.expires_at, `expires_at for codex reset_credits[${index}]`),
    });
  }
  if (count !== credits.length) {
    throw new UsageParseError(
      `codex reset_credits_available=${count} does not match ${credits.length} exact-available reset_credits rows`,
    );
  }
  return { availableCount: count, credits, unavailable: false };
}

function parseWindows(record: Record<string, unknown>, provider: string): UsageWindow[] {
  if (!isRecord(record.windows)) throw new UsageParseError(`'windows' for ${provider} is not an object`);
  const windows: UsageWindow[] = [];
  for (const [name, rawWindow] of Object.entries(record.windows)) {
    if (!isRecord(rawWindow)) throw new UsageParseError(`'windows.${name}' for ${provider} is not an object`);
    if (!Object.hasOwn(rawWindow, 'percent_remaining')) {
      throw new UsageParseError(`'windows.${name}.percent_remaining' for ${provider} is missing`);
    }
    if (rawWindow.percent_remaining === null) continue;
    let percentRemaining: number;
    if (typeof rawWindow.percent_remaining === 'number') percentRemaining = rawWindow.percent_remaining;
    else if (typeof rawWindow.percent_remaining === 'string' && rawWindow.percent_remaining.trim()) {
      percentRemaining = Number(rawWindow.percent_remaining);
    } else throw new UsageParseError(`invalid 'percent_remaining' for ${provider} ${name}`);
    if (!Number.isFinite(percentRemaining)) {
      throw new UsageParseError(`invalid 'percent_remaining' for ${provider} ${name}`);
    }
    windows.push({
      name,
      used: Math.max(0, Math.min(100, 100 - percentRemaining)),
      limit: 100,
      unit: 'percent',
      resetAt: parseResetAt(rawWindow.reset_at),
    });
  }
  return windows;
}

function parseRecord(value: unknown): UsageProviderRecord {
  if (!isRecord(value)) throw new UsageParseError('usage row is not an object');
  const provider = requiredString(value.provider, 'provider');
  const rawStatus = typeof value.status === 'string' && value.status.trim() ? value.status.trim() : 'unknown';
  const details = value.details;
  if (details !== undefined && details !== null && !isRecord(details)) {
    throw new UsageParseError("'details' is not an object");
  }
  const providerError = optionalString(value.error, 'error');
  return {
    provider,
    status: parseStatus(rawStatus),
    rawStatus,
    blockReason: optionalString(value.block_reason, 'block_reason'),
    lastError: actionableProviderError(provider, providerError),
    windows: parseWindows(value, provider),
    resetCredits: parseResetCredits(value, provider),
  };
}

/** Parse canonical provider-keyed NDJSON. Any malformed nonblank line fails the full read. */
export function parseUsageNdjson(input: string): UsageProviderRecord[] {
  if (!input.trim()) return [];
  const records: UsageProviderRecord[] = [];
  for (const [index, rawLine] of input.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (cause) {
      throw new UsageParseError(`invalid usage JSON near line ${index + 1}`, { cause });
    }
    try {
      records.push(parseRecord(value));
    } catch (cause) {
      if (cause instanceof UsageParseError) {
        throw new UsageParseError(`invalid usage record near line ${index + 1}: ${cause.message}`, { cause });
      }
      throw cause;
    }
  }
  return records;
}

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

export function usageWindowPercent(window: UsageWindow): number {
  return window.unit.toLowerCase() === 'percent' || window.unit === '%' ? window.used
    : window.limit > 0 ? window.used / window.limit * 100 : 0;
}

export function usageMostConstrainedWindow(record: UsageProviderRecord): UsageWindow | null {
  return record.windows.reduce<UsageWindow | null>(
    (worst, window) => worst === null || usageWindowPercent(window) > usageWindowPercent(worst) ? window : worst,
    null,
  );
}

export function usageIsBlocked(record: UsageProviderRecord): boolean {
  return record.status === 'blocked' || record.windows.some((window) => usageWindowPercent(window) >= 100);
}

export function usageIsNearLimit(record: UsageProviderRecord): boolean {
  return !usageIsBlocked(record) && record.windows.some((window) => usageWindowPercent(window) >= 85);
}

export function usageThresholdState(
  record: UsageProviderRecord,
  warnPercent = USAGE_DEFAULT_WARN_PERCENT,
): UsageThresholdState {
  if (record.status === 'blocked') return 'exceeded';
  const worst = usageMostConstrainedWindow(record);
  if (!worst) return 'ok';
  const percent = usageWindowPercent(worst);
  if (percent >= USAGE_EXCEEDED_PERCENT) return 'exceeded';
  if (percent >= USAGE_CRITICAL_PERCENT) return 'critical';
  if (percent >= warnPercent) return 'approaching';
  return 'ok';
}
