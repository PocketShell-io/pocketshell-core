/**
 * The gateway's device registry as every client reads it (pocketshell#3086
 * slice 4): the account's enrolled devices with their last authoritative
 * presence, the host-key pin a user pastes when adding one, and the
 * classification of a device-list or pairing refusal.
 *
 * Wire contract (pocketshell-gateway 8f2f360 internal/identity/service.go
 * handleList, deviceJSON): `GET <gateway https origin>/identity/v1/devices`
 * with the broker routing token as Bearer answers
 *
 *     {"devices":[{"id", "account_id", "public_key", "ssh_host_key",
 *                  "revoked", "presence"?: {"online", "observed_at",
 *                  "connected_since"?, "session_generation"?}}]}
 *
 *  - `public_key` is the device's Ed25519 IDENTITY key, not an SSH key, and
 *    `account_id` names the account: neither is shown or needed here;
 *  - `ssh_host_key` is ADVISORY — whatever the device reported at enrolment.
 *    It is shown as a hint to compare against, never stored as trust: the
 *    pin is what the user pastes from the host (`pocketshell gateway show
 *    --host-key`), see {@link parseGatewayHostPin};
 *  - `presence` absent means UNKNOWN, not offline. A revoked device is never
 *    online. Presence is the gateway's last observation; nothing here ever
 *    probes the device;
 *  - there are no name, OS or last-seen fields.
 *
 * The routing token never reaches this module: a platform fetches the list
 * where its token lives (Android: natively) and hands over the JSON body.
 */
import { isValidGatewayDeviceId, normalizeGatewayServerUrl, normalizeSha256Fingerprint } from './gatewayTransport';

/** The device-list path on the gateway's HTTPS origin. */
export const GATEWAY_DEVICES_PATH = '/identity/v1/devices';

/** The most devices one list may carry; a longer answer is refused, not truncated. */
export const GATEWAY_MAX_DEVICES = 256;

/** The gateway's last authoritative word on whether a device's agent is connected. */
export type GatewayDevicePresence =
  | { state: 'online'; observedAt: string; connectedSince: string | null }
  | { state: 'offline'; observedAt: string }
  /** The gateway said nothing (`presence` absent): not the same as offline. */
  | { state: 'unknown' };

export interface GatewayDevice {
  /** The enrolled device id — the only name a device has. */
  id: string;
  revoked: boolean;
  presence: GatewayDevicePresence;
  /**
   * The host key the device reported at enrolment (`keytype base64`). A HINT
   * to compare the pasted pin with; never a pin, never trust.
   */
  advisoryHostKey: string | null;
}

/** A device list the client cannot read. Never an empty list a caller could act on. */
export class GatewayDeviceListError extends Error {
  constructor(message = 'The gateway answered with a device list this version cannot read.') {
    super(message);
    this.name = 'GatewayDeviceListError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** RFC 3339 timestamp, as the gateway writes it (UTC, optional fraction). */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !RFC3339.test(value) || Number.isNaN(Date.parse(value))) {
    throw new GatewayDeviceListError();
  }
  return value;
}

function presenceOf(raw: unknown, revoked: boolean): GatewayDevicePresence {
  if (raw === undefined) return { state: 'unknown' };
  if (!isRecord(raw) || typeof raw['online'] !== 'boolean') throw new GatewayDeviceListError();
  const observedAt = timestamp(raw['observed_at']);
  // The gateway never reports a revoked device online; if one ever did, it
  // is still not something to connect to.
  if (raw['online'] && !revoked) {
    const since = raw['connected_since'];
    return { state: 'online', observedAt, connectedSince: since === undefined ? null : timestamp(since) };
  }
  return { state: 'offline', observedAt };
}

/**
 * Parse the device-list body strictly. Throws {@link GatewayDeviceListError}
 * on anything that is not the documented shape — a missing `devices` array,
 * a malformed id, a non-boolean `revoked`, an unreadable presence — rather
 * than returning a partial or empty list.
 */
export function parseGatewayDeviceList(body: unknown): GatewayDevice[] {
  if (!isRecord(body) || !Array.isArray(body['devices'])) throw new GatewayDeviceListError();
  const rows = body['devices'] as unknown[];
  if (rows.length > GATEWAY_MAX_DEVICES) throw new GatewayDeviceListError('The gateway listed more devices than PocketShell shows.');
  const seen = new Set<string>();
  return rows.map((row) => {
    if (!isRecord(row) || typeof row['id'] !== 'string' || !isValidGatewayDeviceId(row['id'])
      || typeof row['revoked'] !== 'boolean') {
      throw new GatewayDeviceListError();
    }
    if (seen.has(row['id'])) throw new GatewayDeviceListError();
    seen.add(row['id']);
    const advisory = row['ssh_host_key'];
    if (advisory !== undefined && typeof advisory !== 'string') throw new GatewayDeviceListError();
    const hint = typeof advisory === 'string' ? advisory.trim() : '';
    return {
      id: row['id'],
      revoked: row['revoked'],
      presence: presenceOf(row['presence'], row['revoked']),
      advisoryHostKey: hint !== '' && hint.length <= 16_384 && /^[\x20-\x7e]+$/.test(hint) ? hint : null,
    };
  });
}

/** The HTTPS URL of the device list on a canonical gateway origin, or null. */
export function gatewayDevicesUrl(serverUrl: string): string | null {
  const canonical = normalizeGatewayServerUrl(serverUrl);
  if (canonical === null) return null;
  return `${canonical.startsWith('wss://') ? 'https' : 'http'}://${canonical.slice(canonical.indexOf('://') + 3)}${GATEWAY_DEVICES_PATH}`;
}

/** The three ways the picker words a device's presence, plus revoked. */
export type GatewayDeviceStatus = 'online' | 'offline' | 'unknown' | 'revoked';

export function gatewayDeviceStatus(device: GatewayDevice): GatewayDeviceStatus {
  if (device.revoked) return 'revoked';
  return device.presence.state;
}

/**
 * One line for a device's status, from the gateway's own observation only.
 * `now` is the reader's clock; the age is approximate and never negative.
 */
export function describeGatewayDeviceStatus(device: GatewayDevice, now: number = Date.now()): string {
  const status = gatewayDeviceStatus(device);
  if (status === 'revoked') return 'Revoked — removed from your account';
  if (status === 'unknown') return 'Status unknown';
  const observed = Date.parse((device.presence as { observedAt: string }).observedAt);
  const age = Number.isNaN(observed) ? null : Math.max(0, Math.round((now - observed) / 60_000));
  const when = age === null ? '' : age < 1 ? ' (just now)' : age < 120 ? ` (${age} min ago)` : ` (${Math.round(age / 60)} h ago)`;
  return status === 'online' ? `Online${when}` : `Offline${when}`;
}

// --- the pasted host-key pin ------------------------------------------------------

/** Host-key types a pin may name (pocketshell-cli gateway/pins.py KEY_TYPES). */
export const GATEWAY_HOST_KEY_TYPES = Object.freeze([
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'ssh-rsa',
] as const);
export type GatewayHostKeyType = (typeof GATEWAY_HOST_KEY_TYPES)[number];

/** Largest accepted public-key blob (pocketshell-cli MAX_KEY_BLOB_BYTES). */
const MAX_HOST_KEY_BLOB_BYTES = 8192;

/** The label `pocketshell-link show` prints before the pinned key. */
export const PINNED_HOST_KEY_LABEL = 'pinned ssh host key:';

export type GatewayHostPin =
  /** The exact key line — what the platform pins byte for byte. */
  | { kind: 'host-key'; keyType: GatewayHostKeyType; keyB64: string; line: string }
  /** A SHA-256 fingerprint only (`SHA256:<43 base64>`). */
  | { kind: 'fingerprint'; fingerprint: string };

function decodeBase64(text: string): Uint8Array | null {
  try {
    const raw = atob(text);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw);
}

/** A bounds-checked SSH wire reader: every read answers null on truncation. */
class WireReader {
  private at = 0;
  constructor(private readonly data: Uint8Array) {}

  string(): Uint8Array | null {
    if (this.at + 4 > this.data.length) return null;
    const length = ((this.data[this.at]! << 24) >>> 0) + (this.data[this.at + 1]! << 16) + (this.data[this.at + 2]! << 8) + this.data[this.at + 3]!;
    this.at += 4;
    if (length > this.data.length - this.at) return null;
    const out = this.data.subarray(this.at, this.at + length);
    this.at += length;
    return out;
  }

  /** A positive, minimally encoded mpint, as its bit length and low bit. */
  positiveMpint(): { bits: number; odd: boolean; small: number } | null {
    const bytes = this.string();
    if (bytes === null || bytes.length === 0 || (bytes[0]! & 0x80) !== 0) return null;
    if (bytes.length > 1 && bytes[0] === 0 && (bytes[1]! & 0x80) === 0) return null;
    let start = 0;
    while (start < bytes.length && bytes[start] === 0) start += 1;
    if (start === bytes.length) return null;
    const lead = bytes[start]!;
    const bits = (bytes.length - start - 1) * 8 + (32 - Math.clz32(lead));
    let small = 0;
    for (let i = Math.max(start, bytes.length - 4); i < bytes.length; i += 1) small = small * 256 + bytes[i]!;
    return { bits, odd: (bytes[bytes.length - 1]! & 1) === 1, small: bits <= 32 ? small : Number.MAX_SAFE_INTEGER };
  }

  atEnd(): boolean {
    return this.at === this.data.length;
  }
}

const ascii = (bytes: Uint8Array | null): string | null => (bytes === null ? null : String.fromCharCode(...bytes));

/** The structure check the CLI's `_check_blob` (and Android's native twin) enforce. */
function wellFormedKeyBlob(keyType: GatewayHostKeyType, blob: Uint8Array): boolean {
  const reader = new WireReader(blob);
  if (ascii(reader.string()) !== keyType) return false;
  if (keyType === 'ssh-ed25519') {
    const key = reader.string();
    if (key === null || key.length !== 32) return false;
  } else if (keyType.startsWith('ecdsa-sha2-')) {
    const curve = keyType.slice('ecdsa-sha2-'.length);
    const pointLength = curve === 'nistp256' ? 65 : curve === 'nistp384' ? 97 : 133;
    if (ascii(reader.string()) !== curve) return false;
    const point = reader.string();
    if (point === null || point.length !== pointLength || point[0] !== 0x04) return false;
  } else {
    const e = reader.positiveMpint();
    const n = reader.positiveMpint();
    if (e === null || n === null) return false;
    if (!e.odd || e.small < 3) return false;
    if (n.bits < 2048) return false;
  }
  return reader.atEnd();
}

function parseKeyLine(line: string): GatewayHostPin | null {
  if (!/^[\x20-\x7e]+$/.test(line)) return null;
  const fields = line.split(' ');
  if (fields.length !== 2 || fields[0] === '' || fields[1] === '') return null;
  const [keyType, keyB64] = fields as [string, string];
  if (!(GATEWAY_HOST_KEY_TYPES as readonly string[]).includes(keyType)) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(keyB64) || keyB64.length % 4 !== 0) return null;
  const blob = decodeBase64(keyB64);
  if (blob === null || encodeBase64(blob) !== keyB64) return null;
  if (blob.length > MAX_HOST_KEY_BLOB_BYTES || !wellFormedKeyBlob(keyType as GatewayHostKeyType, blob)) return null;
  return { kind: 'host-key', keyType: keyType as GatewayHostKeyType, keyB64, line: `${keyType} ${keyB64}` };
}

/**
 * Parse what a user pasted as a gateway device's host-key pin. Accepted:
 *
 *  - `<keytype> <base64>` — exactly what `pocketshell gateway show --host-key`
 *    prints on the host (preferred: the exact key);
 *  - `pinned ssh host key: <keytype> <base64>` — the line `pocketshell-link
 *    show` prints;
 *  - a SHA-256 fingerprint, `SHA256:<base64>` alone or inside a line such as
 *    `ssh-keygen -lf` output or the CLI's `host key SHA256:… (ED25519)` note.
 *
 * Key types: ssh-ed25519, ecdsa-sha2-nistp256/384/521, ssh-rsa (≥ 2048-bit
 * modulus), each structurally checked; one line only, surrounding whitespace
 * trimmed, nothing repaired. Null for anything else — including a comment
 * after the key, a second line, an `@cert-authority` marker, or a private key.
 * The platform re-validates; this is the same grammar, not a looser one.
 */
export function parseGatewayHostPin(input: string): GatewayHostPin | null {
  const text = input.trim();
  if (text === '' || text.length > 16_384 || /[\r\n]/.test(text)) return null;
  const labelled = text.toLowerCase().startsWith(PINNED_HOST_KEY_LABEL)
    ? text.slice(PINNED_HOST_KEY_LABEL.length).trim()
    : text;
  const keyLine = parseKeyLine(labelled);
  if (keyLine !== null) return keyLine;
  // A fingerprint never rides inside something that looks like a key line or
  // a private key: those must parse as keys or be refused.
  if (/PRIVATE KEY/i.test(text) || /^(ssh-|ecdsa-)/.test(labelled)) return null;
  const fingerprint = normalizeSha256Fingerprint(text);
  return fingerprint === null ? null : { kind: 'fingerprint', fingerprint };
}

/** The canonical text a platform's pairing store receives for a parsed pin. */
export function gatewayHostPinText(pin: GatewayHostPin): string {
  return pin.kind === 'host-key' ? pin.line : pin.fingerprint;
}

/**
 * Whether a pasted pin and the gateway's advisory key name the same key.
 * Null when it cannot be compared (no advisory, or a fingerprint-only pin).
 * Informational only — a match does not make the pin more trusted, and a
 * mismatch is shown as a warning, never auto-corrected.
 */
export function pinMatchesAdvisory(pin: GatewayHostPin, advisoryHostKey: string | null): boolean | null {
  if (advisoryHostKey === null || pin.kind !== 'host-key') return null;
  const advisory = parseKeyLine(advisoryHostKey.trim().split(/\s+/).slice(0, 2).join(' '));
  if (advisory === null || advisory.kind !== 'host-key') return null;
  return advisory.line === pin.line;
}

// --- refusals the device list and the pairing store report ----------------------

/**
 * What a device-list, pairing or add-device refusal means for the user. The
 * gateway-dial kinds (`sign_in_required`, `pairing_required`,
 * `account_changed`, `host_offline`) come from core's dial matrix
 * (classifyGatewayDialFailure); these are the same words for the non-dial
 * paths, so a UI prompts once per kind.
 */
export type GatewayDirectoryFailureKind =
  | 'sign_in_required'
  | 'account_changed'
  | 'invalid_pairing'
  | 'unavailable';

export interface GatewayDirectoryFailure {
  kind: GatewayDirectoryFailureKind;
  message: string;
}

const DIRECTORY_CODES: Readonly<Record<string, GatewayDirectoryFailure>> = Object.freeze({
  NOT_SIGNED_IN: { kind: 'sign_in_required', message: 'Sign in to your PocketShell account to see its gateway devices.' },
  GATEWAY_BROKER_SIGN_IN_REJECTED: {
    kind: 'sign_in_required',
    message: 'Your sign-in was not accepted for the gateway — sign out, sign in again, then reload.',
  },
  GATEWAY_DEVICES_UNAUTHORIZED: {
    kind: 'sign_in_required',
    message: 'The gateway did not accept your sign-in — sign in again, then reload.',
  },
  GATEWAY_ACCOUNT_CHANGED: {
    kind: 'account_changed',
    message: 'The signed-in account changed while the list was loading — reload to see the current account’s devices.',
  },
  GATEWAY_PAIRING_ACCOUNT_CHANGED: {
    kind: 'account_changed',
    message: 'The signed-in account changed — check the account, then add the device again.',
  },
});

/**
 * Classify a rejected device-list / pairing / add call by its error `code`.
 * `GATEWAY_PAIRING_INVALID` and `GATEWAY_PAIRING_KEY_MISSING` keep the
 * platform's own message (it names the field); anything unknown is
 * `unavailable` with the error's message.
 */
export function classifyGatewayDirectoryFailure(error: unknown): GatewayDirectoryFailure {
  const code = isRecord(error) || error instanceof Error ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error && error.message ? error.message
    : isRecord(error) && typeof error['message'] === 'string' ? error['message'] : '';
  if (typeof code === 'string') {
    const known = DIRECTORY_CODES[code];
    if (known) return known;
    if (code === 'GATEWAY_PAIRING_INVALID' || code === 'GATEWAY_PAIRING_KEY_MISSING') {
      return { kind: 'invalid_pairing', message: message || 'Check the device id, the host key and the SSH key.' };
    }
  }
  return { kind: 'unavailable', message: message || 'The gateway device list could not be loaded.' };
}
