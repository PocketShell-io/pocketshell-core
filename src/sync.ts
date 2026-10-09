import type { HostEntry } from './types.js';
import { normalizeGatewayTarget } from './gatewayTransport';
import { isLinkTransportTarget } from './sshCapability';

/**
 * Types and shapes shared by the sync feature across the IPC boundary
 * (main ↔ preload ↔ renderer). The pure merge logic for host lists lives in
 * syncMerge.ts; this module is only the vocabulary.
 */

export interface SyncStatus {
  loggedIn: boolean;
  email: string | null;
  /** False when there is no OS keychain: login refuses rather than storing plaintext tokens. */
  keychainAvailable: boolean;
}

/**
 * `sync:pull`'s answer. `absent` is a fresh account — normal, not an error.
 * `plaintext` is the decrypted settings JSON; the envelope never crosses IPC.
 */
export type SyncPullResult =
  | { kind: 'absent' }
  | { kind: 'ok'; version: number; plaintext: string };

/**
 * `sync:push`'s answer, as a RESULT rather than a throw because the UI
 * branches on `conflict` (re-pull, re-merge, retry) and a rejection would
 * flatten that into a string.
 */
export type SyncPushResult =
  | { kind: 'ok'; version: number }
  | { kind: 'conflict'; currentVersion: number }
  | { kind: 'error'; message: string };

export interface SyncApplyResult {
  /** Aliases appended to ~/.ssh/config by this call. */
  added: string[];
}

/**
 * Whether a host object carries a PRESENT gateway transport marker — an own
 * `gateway` property, whatever its value: a valid target, null, or a shape
 * this build does not understand.
 *
 * Presence is the whole contract for the unsupported-platform guard (issue
 * #3059): a client without gateway support refuses on presence alone and
 * never inspects, normalizes, or guesses the marker's shape, so a malformed
 * or future-shaped marker can never degrade into an ordinary SSH dial. An
 * entry carrying BOTH `link` and `gateway` refuses too — the conflict is
 * resolved by refusing, never by falling back to the link transport.
 */
export function hasGatewayMarker(host: object): boolean {
  return Object.prototype.hasOwnProperty.call(host, 'gateway');
}

/**
 * The transports a platform can actually dial, beyond ordinary SSH. Each
 * client passes its real capabilities: today the desktop has neither, the
 * web has `link` only, and Android has neither.
 */
export interface TransportCapabilities {
  gateway: boolean;
  link: boolean;
}

/**
 * Why a dial was refused at the platform boundary:
 *  - `gateway-unsupported`: a `gateway` marker is present (any value, with or
 *    without `link`) and this client cannot dial the gateway.
 *  - `gateway-invalid`: the client can dial the gateway, but the marker is not
 *    a usable target (null, malformed, future-shaped).
 *  - `link-and-gateway`: the client can dial the gateway, but the entry also
 *    carries `link` — the conflict refuses, never falls back to either.
 *  - `link-unsupported`: a `link` marker is present and this client has no
 *    link transport.
 *  - `link-invalid`: the client has a link transport, but the marker is not a
 *    usable relay target.
 */
export type TransportRefusalReason =
  | 'gateway-unsupported'
  | 'gateway-invalid'
  | 'link-and-gateway'
  | 'link-unsupported'
  | 'link-invalid';

/** The outcome of {@link unsupportedTransport}. */
export type TransportDecision =
  | { refused: false }
  | { refused: true; reason: TransportRefusalReason; message: string };

/**
 * The user-facing refusal text, shared verbatim by every client so the same
 * host is refused in the same words on the phone, the desktop and the web
 * (pocketshell#3073). `label` is the host's display name; null when the
 * caller has none.
 */
export function transportRefusalMessage(reason: TransportRefusalReason, label: string | null): string {
  const who = label !== null && label.trim() !== '' ? `“${label}”` : 'This host';
  switch (reason) {
    case 'gateway-unsupported':
      return `${who} is reached through the PocketShell gateway, which this device can't connect through yet. Nothing was dialled.`;
    case 'gateway-invalid':
      return `${who} has a PocketShell gateway setting this version can't read. Nothing was dialled.`;
    case 'link-and-gateway':
      return `${who} is set up for both the PocketShell gateway and a relay link, so it is unclear which to use. Nothing was dialled.`;
    case 'link-unsupported':
      return `${who} is reached through a PocketShell relay link, which this device can't connect through yet. Nothing was dialled.`;
    case 'link-invalid':
      return `${who} has a PocketShell relay link setting this version can't read. Nothing was dialled.`;
  }
}

/**
 * The ONE transport-support decision every client makes at its dial boundary
 * (#3059, desktop#8, web#4): whether a host entry or connect request may be
 * dialled on a platform with `capabilities`, decided before any key load,
 * prompt, save or socket.
 *
 * Markers are detected by PRESENCE (own property, any value) and are never
 * normalized here, so nothing marked can degrade into an ordinary SSH dial:
 *  - `gateway` present: refused unless the client can dial the gateway AND
 *    the marker is a valid target AND there is no `link` alongside it. On a
 *    client without gateway support every shape (valid, null, malformed,
 *    with `link`) refuses as `gateway-unsupported`.
 *  - `link` present (no `gateway`): refused unless the client has a link
 *    transport and the marker is a valid relay target.
 *  - neither: an ordinary host, not refused.
 *
 * `label` names the host in the message; it defaults to the entry's own
 * `name` when that is a non-empty string.
 */
export function unsupportedTransport(
  entry: object,
  capabilities: TransportCapabilities,
  label?: string | null,
): TransportDecision {
  const raw = entry as Record<string, unknown>;
  const name =
    label !== undefined ? label : typeof raw['name'] === 'string' && raw['name'] !== '' ? raw['name'] : null;
  const refuse = (reason: TransportRefusalReason): TransportDecision => ({
    refused: true,
    reason,
    message: transportRefusalMessage(reason, name),
  });
  const hasLink = Object.prototype.hasOwnProperty.call(entry, 'link');
  if (hasGatewayMarker(entry)) {
    if (!capabilities.gateway) return refuse('gateway-unsupported');
    if (hasLink) return refuse('link-and-gateway');
    if (normalizeGatewayTarget(raw['gateway']) === null) return refuse('gateway-invalid');
    return { refused: false };
  }
  if (hasLink) {
    if (!capabilities.link) return refuse('link-unsupported');
    if (!isLinkTransportTarget(raw['link'])) return refuse('link-invalid');
  }
  return { refused: false };
}

/** The outcome of {@link coerceHostEntries}. */
export type CoercedHostEntries =
  | { kind: 'ok'; hosts: HostEntry[] }
  | { kind: 'invalid' }
  | {
      kind: 'gateway-unsupported';
      /** Position of the refusing entry in the input array. */
      index: number;
      /** The entry's `name` when it has a usable one, for the error copy. */
      name: string | null;
    };

/**
 * Host entries arriving over IPC for the config write-back, degraded per
 * entry: an entry that is not a usable Host directive is dropped, the rest
 * are kept. The renderer is our code, but `sync:applyHosts` is the one
 * channel whose payload reaches a user file on disk, so its input is treated
 * as data, not as trusted shape (same posture as the update URL allow-list).
 *
 * A gateway entry is never coerced: any entry with a present gateway marker
 * (see {@link hasGatewayMarker}) refuses the call with `gateway-unsupported`
 * instead of being written back as an ordinary `Host` block — the marker says
 * the host dials through the gateway, and an ordinary block would turn that
 * intent into a plain SSH address (a HostName downgrade). Callers refuse the
 * whole batch: nothing is written when any entry refuses.
 */
export function coerceHostEntries(raw: unknown): CoercedHostEntries {
  if (!Array.isArray(raw)) return { kind: 'invalid' };
  const out: HostEntry[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null) continue;
    if (hasGatewayMarker(entry)) {
      const marker = entry as Record<string, unknown>;
      return {
        kind: 'gateway-unsupported',
        index,
        name: typeof marker['name'] === 'string' && marker['name'] !== '' ? marker['name'] : null,
      };
    }
    const e = entry as Record<string, unknown>;
    const name = typeof e['name'] === 'string' ? e['name'].trim() : '';
    const hostname = typeof e['hostname'] === 'string' ? e['hostname'].trim() : '';
    // A Host directive needs both, and neither may contain whitespace — the
    // config writer emits them on `Host <name>` / `HostName <hostname>` lines.
    if (name === '' || hostname === '' || /\s/.test(name) || /\s/.test(hostname)) continue;
    out.push({
      name,
      hostname,
      port: typeof e['port'] === 'number' && Number.isInteger(e['port']) && e['port'] > 0 && e['port'] <= 65535 ? e['port'] : 22,
      user: typeof e['user'] === 'string' ? e['user'] : '',
      identityFile: typeof e['identityFile'] === 'string' && e['identityFile'] !== '' ? e['identityFile'] : null,
      proxyJump: typeof e['proxyJump'] === 'string' && e['proxyJump'] !== '' ? e['proxyJump'] : null,
      forwardAgent: e['forwardAgent'] === true,
      localForwards: coerceForwards(e['localForwards'], 'local'),
      remoteForwards: coerceForwards(e['remoteForwards'], 'remote'),
      fromConfig: true,
    });
  }
  return { kind: 'ok', hosts: out };
}

function coerceForwards(raw: unknown, kind: 'local' | 'remote'): HostEntry['localForwards'] {
  if (!Array.isArray(raw)) return [];
  const out: HostEntry['localForwards'] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const f = entry as Record<string, unknown>;
    if (typeof f['listenPort'] !== 'number' || typeof f['destPort'] !== 'number') continue;
    if (typeof f['destHost'] !== 'string' || f['destHost'] === '') continue;
    out.push({
      kind,
      listenHost: typeof f['listenHost'] === 'string' ? f['listenHost'] : '',
      listenPort: f['listenPort'],
      destHost: f['destHost'],
      destPort: f['destPort'],
    });
  }
  return out;
}
