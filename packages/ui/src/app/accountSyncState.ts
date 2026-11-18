/**
 * The background account sync, as the rest of the picker sees it
 * (pocketshell#3189).
 *
 * Saved servers are usable at once; the Google identity check, the vault
 * refresh and the server list reload run behind them. Their outcome is one
 * small state the account chip renders: syncing, synced, not synced (retrying
 * on its own), or "signed out". TrustedServersSection owns the sync and
 * writes this state; HostPickerView only reads it. Nothing here blocks a tap,
 * and nothing here ever starts a sign-in: a lost sign-in is shown as signed
 * out, and only the user's tap on Sign in opens Google's sheet.
 *
 * Failures are described in plain words. Platform errors use the shared
 * account-bridge codes: `SYNC_NETWORK_FAILED` (the sync service could not be
 * reached) and `NOT_SIGNED_IN` (the sign-in is gone: signed out elsewhere,
 * revoked or deleted). The raw text, which can carry a Java exception class,
 * stays behind "Copy details".
 */
import { reactive } from 'vue';

export type AccountSyncPhase = 'idle' | 'syncing' | 'synced' | 'offline' | 'reauth';

export interface AccountSyncState {
  phase: AccountSyncPhase;
  /** "Copy details" text for the last failure; empty when there is none. */
  detail: string;
  /** Retry now; null while no sync owner is mounted. */
  retry: (() => void) | null;
}

export const accountSyncState = reactive<AccountSyncState>({ phase: 'idle', detail: '', retry: null });

export interface SyncProblem {
  kind: 'offline' | 'signedOut' | 'failed';
  /** One plain sentence for the UI; never an exception class name. */
  message: string;
  /** Everything known about the failure, for "Copy details". */
  detail: string;
}

export const SYNC_OFFLINE_TEXT = "Not synced. PocketShell sync can't be reached right now; retrying.";
const FAILED_TEXT = "Not synced. Your servers couldn't be refreshed; retrying.";

/** Java/JS exception class names in parentheses, e.g. "(SocketTimeoutException)". */
const CLASS_NAME = /\s*\((?:[\w$]+\.)*[\w$]*(?:Exception|Error)\)/g;
const OFFLINE_TEXT = /could not be reached|can't be reached|unreachable|timed out|timeout|network|offline|failed to fetch|unavailable/i;

/** True when the text names an exception class anywhere. */
export function namesExceptionClass(text: string): boolean {
  return /\b[A-Z]\w*(?:Exception|Error)\b/.test(text);
}

/** Classify a background-sync or open-time failure into one plain sentence plus details. */
export function describeSyncProblem(error: unknown): SyncProblem {
  const record = (typeof error === 'object' && error !== null ? error : {}) as {
    code?: unknown; message?: unknown; data?: { detail?: unknown } | null;
  };
  const code = typeof record.code === 'string' ? record.code : '';
  const raw = typeof record.message === 'string' ? record.message : typeof error === 'string' ? error : '';
  const extra = record.data && typeof record.data.detail === 'string' ? record.data.detail : '';
  const detail = [code, raw, extra].filter((part) => part !== '').join(' · ') || 'Unknown sync failure';
  if (code === 'NOT_SIGNED_IN') {
    return { kind: 'signedOut', message: "You're signed out.", detail };
  }
  if (code === 'SYNC_NETWORK_FAILED' || OFFLINE_TEXT.test(raw)) {
    return { kind: 'offline', message: SYNC_OFFLINE_TEXT, detail };
  }
  const cleaned = raw.replace(CLASS_NAME, '').trim();
  const message = cleaned === '' || namesExceptionClass(cleaned) ? FAILED_TEXT : cleaned;
  return { kind: 'failed', message, detail };
}

/**
 * Background retry schedule (#3189): 30 s, 1 min, 5 min, then every 15 min.
 * The network coming back, the app returning to the front and any Retry tap
 * retry at once; nothing retries faster than this on its own.
 */
export const SYNC_RETRY_DELAYS_MS = [30_000, 60_000, 300_000, 900_000] as const;

export function syncRetryDelay(attempt: number): number {
  return SYNC_RETRY_DELAYS_MS[Math.min(Math.max(attempt, 0), SYNC_RETRY_DELAYS_MS.length - 1)]!;
}
