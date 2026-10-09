import {
  applyAccountToSelection,
  assembleSyncSet,
  parseSyncPayloadResult,
  serializeSyncPayload,
  type SyncHostEntry,
  type SyncPayloadParseResult,
  type SyncSelectionState,
} from './syncMerge.js';
import { describeError } from './sshExec.js';

/**
 * One settings-sync round — pull → auto-check → assemble → push, re-based and
 * retried on a version conflict — shared by every client (docs/SYNC.md).
 *
 * The round owns every decision: which aliases join the selection, how local
 * and account entries merge, when a payload is unsafe to upload. Platform
 * effects are injected and only move bytes: `pull` returns the decrypted
 * account, `push` uploads a replacement on a base version. They never choose
 * aliases, parse payloads, or merge host fields.
 *
 * The round fails closed. Malformed account data ({@link parseSyncPayloadResult}
 * `invalid`), an invalid version or effect answer, or an empty assembled set
 * stop the round before anything is uploaded — an unreadable or empty
 * account must never turn into an account reset.
 */

/** The decrypted account slot a platform's `pull` effect returns. */
export type SyncRoundSnapshot =
  | { kind: 'absent' }
  | { kind: 'ok'; version: number; plaintext: string };

/** A platform's `push` answer; `conflict` means another device wrote first. */
export type SyncRoundPushResult =
  | { kind: 'ok'; version: number }
  | { kind: 'conflict'; currentVersion: number }
  | { kind: 'error'; message: string };

/** What a round saw on one successful pull. */
export interface SyncRoundPulled {
  /** The pulled slot version; null for an absent (fresh) account. */
  version: number | null;
  /** The account's hosts; empty for an absent account. */
  hosts: SyncHostEntry[];
  /** The selection after this pull's auto-check ({@link applyAccountToSelection}). */
  selectedAliases: string[];
  /** The explicit unticks still pending after this pull (spent ones dropped). */
  untickedAliases: string[];
}

export interface SyncRoundEffects {
  pull(): Promise<SyncRoundSnapshot>;
  /** `baseVersion` is null when the account was absent. */
  push(input: { baseVersion: number | null; plaintext: string }): Promise<SyncRoundPushResult>;
  /**
   * Optional observer, called after every pull that parsed cleanly and
   * before assembly — including each re-pull after a conflict. A client uses
   * it to show the account copy and persist the auto-checked selection and
   * the remaining unticks.
   */
  onPulled?(pulled: SyncRoundPulled): void;
}

/** How many times a conflict is re-based before the round gives up. */
export const SYNC_ROUND_CONFLICT_RETRIES = 3;

export type SyncRoundResult =
  | {
      kind: 'synced';
      version: number;
      selectedAliases: string[];
      untickedAliases: string[];
      hosts: SyncHostEntry[];
      attempts: number;
    }
  | {
      kind: 'invalid-payload';
      reason: Extract<SyncPayloadParseResult, { kind: 'invalid' }>['reason'];
      index?: number;
    }
  | { kind: 'empty-selection' }
  | { kind: 'error'; stage: 'pull' | 'push'; message: string }
  | { kind: 'conflict-limit'; version: number; attempts: number };

/**
 * Run one bounded sync round for a selection. `localHosts` are this client's
 * host entries with only the fields it owns (docs/SYNC.md: omitted fields are
 * carried over from the account). Every pulled account alias joins the
 * selection unless `selection.unticked` holds it — the one tick rule
 * (pocketshell#3072), so an untouched round never removes an account host.
 * Effect rejections become `error` results; only a throwing `onPulled`
 * observer rejects the round.
 */
export async function runSyncRound(
  localHosts: readonly SyncHostEntry[],
  selection: SyncSelectionState,
  effects: SyncRoundEffects,
): Promise<SyncRoundResult> {
  let selected = [...new Set(selection.checked)];
  let unticked = [...new Set(selection.unticked)];

  for (let attempts = 1; attempts <= SYNC_ROUND_CONFLICT_RETRIES + 1; attempts += 1) {
    let snapshot: SyncRoundSnapshot;
    try {
      snapshot = await effects.pull();
    } catch (error) {
      return { kind: 'error', stage: 'pull', message: describeError(error) };
    }
    if (!isSyncRoundSnapshot(snapshot)) {
      return { kind: 'error', stage: 'pull', message: 'The sync service returned an invalid snapshot.' };
    }

    let version: number | null = null;
    let remoteHosts: SyncHostEntry[] = [];
    if (snapshot.kind === 'ok') {
      if (!Number.isSafeInteger(snapshot.version) || snapshot.version < 0) {
        return { kind: 'error', stage: 'pull', message: 'The sync service returned an invalid version.' };
      }
      version = snapshot.version;
      const parsed = parseSyncPayloadResult(snapshot.plaintext);
      if (parsed.kind === 'invalid') {
        return {
          kind: 'invalid-payload',
          reason: parsed.reason,
          ...(parsed.index === undefined ? {} : { index: parsed.index }),
        };
      }
      remoteHosts = parsed.hosts;
    }
    ({ checked: selected, unticked } = applyAccountToSelection(remoteHosts, { checked: selected, unticked }));
    effects.onPulled?.({
      version,
      hosts: remoteHosts,
      selectedAliases: [...selected],
      untickedAliases: [...unticked],
    });

    const hosts = assembleSyncSet(localHosts, remoteHosts, selected);
    // An empty assembled list would replace the account with an empty
    // payload. Explicit account clearing needs a separate user action.
    if (hosts.length === 0) return { kind: 'empty-selection' };

    const plaintext = serializeSyncPayload(hosts);
    let pushed: SyncRoundPushResult;
    try {
      pushed = await effects.push({ baseVersion: version, plaintext });
    } catch (error) {
      return { kind: 'error', stage: 'push', message: describeError(error) };
    }
    if (!isSyncRoundPushResult(pushed)) {
      return { kind: 'error', stage: 'push', message: 'The sync service returned an invalid response.' };
    }

    if (pushed.kind === 'error') {
      return { kind: 'error', stage: 'push', message: pushed.message };
    }
    if (pushed.kind === 'ok') {
      return {
        kind: 'synced',
        version: pushed.version,
        selectedAliases: [...selected],
        untickedAliases: [...unticked],
        hosts,
        attempts,
      };
    }
    if (attempts > SYNC_ROUND_CONFLICT_RETRIES) {
      return { kind: 'conflict-limit', version: pushed.currentVersion, attempts };
    }
  }

  // The bounded loop always returns; retain an explicit result for type and
  // runtime safety if its retry bound is changed later.
  return { kind: 'conflict-limit', version: 0, attempts: SYNC_ROUND_CONFLICT_RETRIES + 1 };
}

function isSyncRoundSnapshot(value: unknown): value is SyncRoundSnapshot {
  if (!isObjectRecord(value)) return false;
  if (value.kind === 'absent') return true;
  return value.kind === 'ok'
    && typeof value.version === 'number'
    && Number.isSafeInteger(value.version)
    && value.version >= 0
    && typeof value.plaintext === 'string';
}

function isSyncRoundPushResult(value: unknown): value is SyncRoundPushResult {
  if (!isObjectRecord(value)) return false;
  if (value.kind === 'error') return typeof value.message === 'string';
  if (value.kind === 'ok') {
    return typeof value.version === 'number' && Number.isSafeInteger(value.version) && value.version >= 0;
  }
  return value.kind === 'conflict'
    && typeof value.currentVersion === 'number'
    && Number.isSafeInteger(value.currentVersion)
    && value.currentVersion >= 0;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
