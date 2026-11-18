/**
 * Last-known trusted server list, kept in local storage so the home screen can
 * paint rows immediately while the vault refresh runs in the background
 * (#3137). DISPLAY AND LOOKUP ONLY: it holds no keys, host pins or usernames,
 * and it is never a trust input. Tapping a row still re-reads the
 * authenticated record from the vault (`getTrustedHost`) before anything is
 * installed or dialled.
 */
import type { TrustedHostRecord } from '@pocketshell/core';

export type CachedServer = Pick<TrustedHostRecord,
  'accountId' | 'vaultId' | 'epoch' | 'revision' | 'serverUrl' | 'deviceId' | 'hostAlias' | 'status'>;

export interface CachedServers {
  /** The remembered sign-in email the list was cached for (unverified until refresh). */
  email: string;
  accountId: string;
  servers: CachedServer[];
}

const KEY = 'pocketshell.trustedServers.v1';

function storage(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

const isServer = (v: unknown): v is CachedServer => {
  const s = v as Record<string, unknown> | null;
  return !!s && typeof s === 'object' && typeof s.accountId === 'string' && typeof s.vaultId === 'string'
    && typeof s.epoch === 'number' && typeof s.revision === 'number' && typeof s.serverUrl === 'string'
    && typeof s.deviceId === 'string' && typeof s.hostAlias === 'string' && s.status === 'active';
};

export function readCachedServers(email: string | undefined | null): CachedServers | null {
  if (!email) return null;
  try {
    const parsed = JSON.parse(storage()?.getItem(KEY) ?? 'null') as Partial<CachedServers> | null;
    if (!parsed || parsed.email !== email || typeof parsed.accountId !== 'string' || !Array.isArray(parsed.servers)) return null;
    const servers = parsed.servers.filter(isServer).filter((s) => s.accountId === parsed.accountId);
    return servers.length ? { email, accountId: parsed.accountId, servers } : null;
  } catch { return null; }
}

/**
 * The last-known list whatever email it was cached for: shown signed out only
 * when the sign-in was lost (revoked, deleted, expired), never after an
 * explicit sign-out, which clears it (pocketshell#3189).
 */
export function readCachedServersAnyAccount(): CachedServers | null {
  try {
    const parsed = JSON.parse(storage()?.getItem(KEY) ?? 'null') as Partial<CachedServers> | null;
    return parsed && typeof parsed.email === 'string' && parsed.email !== '' ? readCachedServers(parsed.email) : null;
  } catch { return null; }
}

/**
 * Stable row order (pocketshell#3189): rows the user has already seen keep
 * their place, so a background refresh never moves a row under the thumb;
 * new rows join the end in name order. The vault reads descriptors in
 * parallel, so its own order changes from one refresh to the next.
 */
export function orderServers<T extends { deviceId: string; hostAlias: string }>(
  previous: readonly string[], next: readonly T[],
): T[] {
  const rank = new Map(previous.map((deviceId, index) => [deviceId, index] as const));
  return [...next].sort((a, b) => {
    const left = rank.get(a.deviceId);
    const right = rank.get(b.deviceId);
    if (left !== undefined && right !== undefined) return left - right;
    if (left !== undefined) return -1;
    if (right !== undefined) return 1;
    return a.hostAlias.localeCompare(b.hostAlias) || a.deviceId.localeCompare(b.deviceId);
  });
}

export function writeCachedServers(email: string | undefined | null, accountId: string, hosts: readonly TrustedHostRecord[]): void {
  if (!email) return;
  const servers: CachedServer[] = hosts.filter((h) => h.status === 'active').map((h) => ({
    accountId: h.accountId, vaultId: h.vaultId, epoch: h.epoch, revision: h.revision,
    serverUrl: h.serverUrl, deviceId: h.deviceId, hostAlias: h.hostAlias, status: 'active' as const,
  }));
  try { storage()?.setItem(KEY, JSON.stringify({ email, accountId, servers })); } catch { /* best-effort */ }
}

export function clearCachedServers(): void {
  try { storage()?.removeItem(KEY); } catch { /* best-effort */ }
}
