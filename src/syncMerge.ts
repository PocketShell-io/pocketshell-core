import type { HostEntry } from './types.js';

/**
 * A host crossing the sync boundary. Only `name` and `hostname` are needed to
 * identify an addressable entry; each client supplies the optional fields it
 * actually owns and carries the remaining JSON properties through unchanged.
 */
export type SyncHostEntry = Pick<HostEntry, 'name' | 'hostname'> &
  Partial<Omit<HostEntry, 'name' | 'hostname'>>;

/**
 * The merge that decides what a sync writes, pure so both the tests and the
 * sync store's retry loop can drive it without a file or a network.
 *
 * Sync is SELECTIVE (docs/SYNC.md): the payload is the ticked aliases and
 * nothing else — a host the user has not ticked never leaves the machine,
 * encrypted or otherwise. The tick marks are the whole contract, and the
 * account is part of them rather than a rival: aliases pulled from the
 * account tick themselves on ({@link aliasesToAutoCheck}), so a plain
 * sequence of syncs only ever grows the set and an explicit UNTICK is the
 * one way a host leaves the account.
 *
 * Content per ticked alias:
 *   - when the local entry exists, its explicitly-present fields win. Fields
 *     absent from that local representation are carried over from the
 *     account. This lets a client with a smaller host model keep directives
 *     owned by another client;
 *   - else the ACCOUNT's entry — a ticked alias the config has lost (say,
 *     during a restore that went wrong) keeps its backup instead of
 *     silently vanishing from the account too.
 *
 * The payload stays the one JSON shape it has always been: `{ hosts }`, one
 * slot, whole list per sync. There are no per-host timestamps or conflict
 * resolution by time; local explicit values win and remote-only fields
 * survive.
 */

/** The ticked aliases assembled into the list the envelope encrypts. */
export function assembleSyncSet(
  local: readonly HostEntry[],
  remote: readonly HostEntry[],
  checked: readonly string[],
): HostEntry[];
export function assembleSyncSet(
  local: readonly SyncHostEntry[],
  remote: readonly SyncHostEntry[],
  checked: readonly string[],
): SyncHostEntry[];
export function assembleSyncSet(
  local: readonly SyncHostEntry[],
  remote: readonly SyncHostEntry[],
  checked: readonly string[],
): SyncHostEntry[] {
  const localByName = new Map(local.map((host) => [host.name, host]));
  const remoteByName = new Map(remote.map((host) => [host.name, host]));
  const hosts: SyncHostEntry[] = [];
  const seen = new Set<string>();
  for (const alias of checked) {
    if (seen.has(alias)) continue;
    seen.add(alias);
    const localEntry = localByName.get(alias);
    const remoteEntry = remoteByName.get(alias);
    const entry = localEntry
      ? mergeLocalOverRemote(localEntry, remoteEntry)
      : remoteEntry;
    // A tick with no entry on either side contributes nothing — there is
    // nothing left to send. It happens when a check outlived the host on
    // every machine; the tick stays so a re-added host syncs again.
    if (entry) hosts.push(entry);
  }
  return hosts;
}

/**
 * Account aliases the selection does not have yet AND the local config
 * lacks — the auto-tick. The config clause is what keeps an untick
 * meaningful: an alias this machine can see is one the user has decided
 * about, so their untick must stand; an alias the config lacks is one this
 * machine has never materialised (a fresh machine mid-restore), and it
 * ticks on so the push re-uploads the account instead of wiping it. That
 * is the whole self-healing property.
 */
export function aliasesToAutoCheck(
  remote: readonly SyncHostEntry[],
  checked: readonly string[],
  localAliases: readonly string[],
): string[] {
  const known = new Set(checked);
  const local = new Set(localAliases);
  return remote
    .map((host) => host.name)
    .filter((name) => !known.has(name) && !local.has(name));
}

/**
 * A strict read result for code that may write the account again. A valid
 * empty payload is distinguishable from malformed data, so callers can abort
 * a push instead of turning an unreadable blob into an empty-account reset.
 */
export type SyncPayloadParseResult =
  | { kind: 'ok'; hosts: SyncHostEntry[] }
  | {
      kind: 'invalid';
      reason: 'invalid-json' | 'invalid-shape' | 'invalid-host-entry' | 'unsupported-version';
      index?: number;
    };

/**
 * Parse plaintext for a mutating sync flow. This refuses the whole payload if
 * its JSON, payload shape, or any host entry is malformed; an `ok` empty
 * array is reserved for the explicit `{"hosts":[]}` payload.
 *
 * Use this before assembling or uploading a replacement payload. Keep
 * {@link parseSyncPayload} only for legacy read-only callers that depend on
 * its degraded behavior.
 */
export function parseSyncPayloadResult(plaintext: string): SyncPayloadParseResult {
  const decoded = decodeSyncPayload(plaintext);
  if (decoded.kind === 'invalid') return decoded;
  if (Object.prototype.hasOwnProperty.call(decoded.root, 'schemaVersion')) {
    return { kind: 'invalid', reason: 'unsupported-version' };
  }
  if (Object.keys(decoded.root).some((key) => key !== 'hosts')) {
    return { kind: 'invalid', reason: 'invalid-shape' };
  }

  const hosts: SyncHostEntry[] = [];
  for (let index = 0; index < decoded.entries.length; index += 1) {
    const entry = decoded.entries[index];
    if (!isPlausibleHostEntry(entry)) {
      return { kind: 'invalid', reason: 'invalid-host-entry', index };
    }
    hosts.push(entry as unknown as SyncHostEntry);
  }
  return { kind: 'ok', hosts };
}

/** Serialize the payload the envelope encrypts — the envelope's plaintext. */
export function serializeSyncPayload(hosts: readonly SyncHostEntry[]): string {
  return JSON.stringify({ hosts });
}

/**
 * Legacy degraded parser for read-only callers. Anything that is not a payload
 * with a plausible host array parses to an EMPTY list, and malformed entries
 * are skipped. A caller that may upload a replacement must use
 * {@link parseSyncPayloadResult} so malformed data cannot look like an
 * explicitly empty account.
 */
export function parseSyncPayload(plaintext: string): HostEntry[] {
  const decoded = decodeSyncPayload(plaintext);
  if (decoded.kind === 'invalid') return [];
  return decoded.entries.filter(isPlausibleHostEntry) as unknown as HostEntry[];
}

function decodeSyncPayload(
  plaintext: string,
): { kind: 'ok'; root: Record<string, unknown>; entries: unknown[] } | Exclude<SyncPayloadParseResult, { kind: 'ok' }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return { kind: 'invalid', reason: 'invalid-json' };
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as Record<string, unknown>)['hosts'])
  ) {
    return { kind: 'invalid', reason: 'invalid-shape' };
  }
  const root = parsed as Record<string, unknown>;
  return { kind: 'ok', root, entries: root['hosts'] as unknown[] };
}

function isPlausibleHostEntry(entry: unknown): entry is Record<string, unknown> {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e['name'] === 'string' &&
    e['name'].trim() !== '' &&
    typeof e['hostname'] === 'string' &&
    e['hostname'].trim() !== ''
  );
}

/** Explicit local values win; absent/undefined local properties retain remote data. */
function mergeLocalOverRemote(local: SyncHostEntry, remote: SyncHostEntry | undefined): SyncHostEntry {
  if (!remote || remote === local) return local;
  const merged: Record<string, unknown> = { ...remote };
  for (const [key, value] of Object.entries(local)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as unknown as SyncHostEntry;
}
