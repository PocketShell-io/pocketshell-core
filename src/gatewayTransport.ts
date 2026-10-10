/**
 * The gateway transport contract: the client side of the PocketShell v1
 * tunnel (pocketshell-gateway-tunnel, internal/tunnel). A host behind NAT
 * runs the gateway agent, which dials OUT to the gateway and stays dialled
 * in; a client dials the gateway's per-host WebSocket and speaks real SSH
 * end-to-end through it — the gateway relays opaque bytes and never sees
 * keys or cleartext.
 *
 * Pure contract only (the platform surface is exactly the globals in
 * `types/globals.d.ts`): target validation, the JSON handshake frames, the
 * close-code vocabulary, fingerprint normalization, and the host-key trust
 * policy. The transport itself is platform glue (web: `WebSocket` + a node
 * Duplex; desktop/Android: their own sockets) and stays in the clients.
 *
 * Trust rules this module encodes:
 *  - The Google ID token only ADMITS the route; the SSH private key
 *    authenticates against the host's sshd. The token travels in the auth
 *    frame only — never in a URL.
 *  - `ready.ssh_host_key` is the gateway's enrollment record. The gateway
 *    controls it, so it is ADVISORY: it can reassure, never establish or
 *    replace trust.
 *  - Trust comes from an independently provisioned SHA-256 fingerprint pin
 *    (from the owner's trusted local enrollment or the host's own
 *    `ssh-keygen -lf` output). A gateway dial without a pin fails closed,
 *    and a mismatch refuses before SSH authentication ever runs.
 */

/** The production gateway. Overridable per target for self-hosted/dev. */
export const GATEWAY_DEFAULT_SERVER_URL = 'wss://gateway.pocketshell.io';

/** The per-host client WebSocket route (server: PathClientSSH). */
export const GATEWAY_SSH_PATH_PREFIX = '/api/v1/hosts/';

/** Multiplexer/protocol version (server: ProtocolVersion). */
export const GATEWAY_PROTOCOL_VERSION = 1;

/** Server handshake budget is 10s (hard 30s) plus the host-dial wait; the
 * client gives the whole auth→ready exchange 30s before giving up. */
export const GATEWAY_HANDSHAKE_TIMEOUT_MS = 30_000;

/** One inbound WebSocket message after the handshake. The server caps its
 * own frames at 1 MiB + overhead; this bounds what a misbehaving gateway
 * can push at the browser before the stream is torn down. */
export const GATEWAY_MAX_WS_MESSAGE_BYTES = (1 << 20) + (64 << 10);

/**
 * A host reached through the gateway. Stored on the synced host entry
 * (`HostEntry.gateway`); neither field is a secret — the route is admitted
 * by the account's own token, the fingerprint pin stays client-local.
 */
export interface GatewayTransportTarget {
  /** Canonical gateway base URL, `wss://…` (or `ws://…` in explicit dev). */
  serverUrl: string;
  /** The enrolled device (host agent) id to reach through the gateway. */
  deviceId: string;
}

/** Same shape the Go registry enforces (identity: deviceIDPattern). */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/;

export function isValidGatewayDeviceId(deviceId: string): boolean {
  return DEVICE_ID_PATTERN.test(deviceId);
}

/**
 * Normalize a user-provided gateway base URL to its canonical form, or null
 * when it is not a usable gateway origin. Accepts `wss://`, `ws://`, and the
 * `https://`/`http://` spellings users paste from a browser address bar
 * (mapped to wss/ws). The origin only — path, query and fragment are
 * rejected, so nothing can smuggle a token into a URL.
 */
export function normalizeGatewayServerUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  // Reviewed cd917b7 origin grammar: inspect text before WHATWG can erase placements.
  const origin = /^(wss|ws|https|http):\/\/([^/?#]*)(\/)?$/i.exec(trimmed);
  if (!origin || !/^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(:[0-9]{1,5})?$/.test(origin[2]!)) return null;
  let candidate = trimmed;
  const httpLike = /^(https?):\/\//i.exec(trimmed);
  if (httpLike !== null) {
    candidate = `${httpLike[1]!.toLowerCase() === 'https' ? 'wss' : 'ws'}://${trimmed.slice(httpLike[0].length)}`;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
  if (url.search !== '' || url.hash !== '') return null;
  // The gateway serves fixed paths; a base path would silently 404.
  if (url.pathname !== '/' && url.pathname !== '') return null;
  // url.host is already lowercase and carries an explicit non-default port.
  return `${url.protocol}//${url.host}`;
}

/**
 * Normalize a raw (JSON-round-tripped) gateway target. Null when either
 * field is unusable — callers treat null as "not a gateway host" and the
 * entry must then refuse to dial rather than guess.
 */
export function normalizeGatewayTarget(raw: unknown): GatewayTransportTarget | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['serverUrl'] !== 'string' || typeof r['deviceId'] !== 'string') return null;
  const serverUrl = normalizeGatewayServerUrl(r['serverUrl']);
  const deviceId = r['deviceId'].trim();
  if (serverUrl === null || !isValidGatewayDeviceId(deviceId)) return null;
  return { serverUrl, deviceId };
}

/**
 * The exact URL a client dials. Throws (config error, not a network error)
 * when the device id is malformed or the server URL is insecure without the
 * explicit development flag — `ws://` must never happen silently against a
 * production-sounding host.
 */
export function gatewaySshUrl(
  target: GatewayTransportTarget,
  opts: { allowInsecureWs?: boolean } = {},
): string {
  if (!isValidGatewayDeviceId(target.deviceId)) {
    throw new Error(`not a valid device id: ${JSON.stringify(target.deviceId)}`);
  }
  let url: URL;
  try {
    url = new URL(target.serverUrl);
  } catch {
    throw new Error(`not a valid gateway URL: ${JSON.stringify(target.serverUrl)}`);
  }
  if (url.protocol === 'ws:' && opts.allowInsecureWs !== true) {
    throw new Error(
      `refusing unencrypted ws:// to ${url.host} — development gateways need the explicit allow-insecure setting`,
    );
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`not a gateway URL scheme: ${url.protocol}`);
  }
  return `${url.protocol}//${url.host}${GATEWAY_SSH_PATH_PREFIX}${encodeURIComponent(target.deviceId)}/ssh`;
}

// --- JSON handshake frames ---------------------------------------------------
//
// All handshake messages are WebSocket TEXT frames; everything after the
// handshake is BINARY. Mirrors the Go structs (protocol.go): ClientAuth,
// ReadyMsg, ErrMsg.

/** The client's first message — the only place the ID token ever travels. */
export interface GatewayClientAuth {
  type: 'auth';
  v: number;
  token: string;
  device_id: string;
}

/** Build the exact auth frame: fields in the protocol's order, JSON text. */
export function buildGatewayAuthFrame(token: string, deviceId: string): string {
  const frame: GatewayClientAuth = { type: 'auth', v: GATEWAY_PROTOCOL_VERSION, token, device_id: deviceId };
  return JSON.stringify(frame);
}

export interface GatewayReadyFrame {
  type: 'ready';
  v: number;
  device_id: string;
  /** The gateway's enrollment record — advisory only (see module header). */
  ssh_host_key: string;
}

export interface GatewayErrorFrame {
  type: 'error';
  v: number;
  code: string;
  message: string;
}

export type GatewayHandshakeFrame =
  | { kind: 'ready'; frame: GatewayReadyFrame }
  | { kind: 'error'; frame: GatewayErrorFrame }
  | { kind: 'malformed'; reason: string };

/** Strict parse of one handshake TEXT frame. Anything that is not exactly a
 * v1 `ready` or `error` object is malformed — a handshake must never be
 * guessed into shape. */
export function parseGatewayHandshakeFrame(text: string): GatewayHandshakeFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'malformed', reason: 'handshake frame is not JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'malformed', reason: 'handshake frame is not an object' };
  }
  const f = parsed as Record<string, unknown>;
  if (f['v'] !== GATEWAY_PROTOCOL_VERSION) {
    return { kind: 'malformed', reason: `handshake version ${JSON.stringify(f['v'])}` };
  }
  if (f['type'] === 'ready') {
    if (typeof f['device_id'] !== 'string' || typeof f['ssh_host_key'] !== 'string') {
      return { kind: 'malformed', reason: 'ready frame missing device_id or ssh_host_key' };
    }
    return {
      kind: 'ready',
      frame: { type: 'ready', v: GATEWAY_PROTOCOL_VERSION, device_id: f['device_id'], ssh_host_key: f['ssh_host_key'] },
    };
  }
  if (f['type'] === 'error') {
    if (typeof f['code'] !== 'string' || typeof f['message'] !== 'string') {
      return { kind: 'malformed', reason: 'error frame missing code or message' };
    }
    return {
      kind: 'error',
      frame: { type: 'error', v: GATEWAY_PROTOCOL_VERSION, code: f['code'], message: f['message'] },
    };
  }
  return { kind: 'malformed', reason: `unexpected handshake type ${JSON.stringify(f['type'])}` };
}

// --- close codes ---------------------------------------------------------------

export type GatewayCloseKind =
  | 'protocol'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'timeout'
  | 'quota'
  | 'host_offline'
  | 'abnormal';

/** Classify a WS close during the handshake — the application codes the Go
 * service documents (service.go), plus the anonymous drops. */
export function classifyGatewayClose(code: number): { kind: GatewayCloseKind; userMessage: string } {
  switch (code) {
    case 4400:
      return { kind: 'protocol', userMessage: 'The gateway rejected the request — update PocketShell.' };
    case 4401:
      return { kind: 'unauthorized', userMessage: 'Your sign-in expired — sign in again and retry.' };
    case 4403:
      return { kind: 'forbidden', userMessage: 'This PocketShell account cannot reach that host.' };
    case 4404:
      return { kind: 'not_found', userMessage: 'That host is not registered on the gateway.' };
    case 4408:
      return { kind: 'timeout', userMessage: 'The gateway took too long to answer.' };
    case 4429:
      return { kind: 'quota', userMessage: 'Too many open sessions — close one and retry.' };
    case 4503:
      return {
        kind: 'host_offline',
        userMessage: 'The host is not connected to the gateway right now — check that its agent is running.',
      };
    default:
      return { kind: 'abnormal', userMessage: 'The connection to the gateway closed before it was ready.' };
  }
}

// --- gateway dial failures (the native ↔ ConnectionController contract) -------
//
// A platform SshCapability that dials through the gateway reports a gateway
// refusal — a WS close during the handshake, or an `error` frame the platform
// maps to its documented close code — by rejecting `connect()` with an
// SshCapabilityError whose `code` is GATEWAY_CLOSED_ERROR_CODE and whose
// `data.gatewayCloseCode` is the integer close code. Before any gateway
// verdict the platform may also refuse the dial itself with one of the native
// codes in GATEWAY_NATIVE_REFUSALS (signed out, sign-in rejected by the token
// broker, no pairing, account switched mid-dial — core#47).
// ConnectionController (the one dial/reconnect owner) reads both through
// classifyGatewayDialFailure and decides retry and advice from the single
// matrix below; no platform decides either on its own.

/** The SshCapabilityError `code` a gateway refusal is reported with. */
export const GATEWAY_CLOSED_ERROR_CODE = 'GATEWAY_CLOSED';

/** Only application close codes in this range are gateway verdicts; a remote
 * 1000/1001/1011 close (or anything else) is not, and keeps the default. */
export const GATEWAY_VERDICT_CLOSE_CODE_MIN = 4000;
export const GATEWAY_VERDICT_CLOSE_CODE_MAX = 4999;

/** Whether a WS close code can carry a gateway verdict (4000–4999). */
export function isGatewayVerdictCloseCode(closeCode: number): boolean {
  return Number.isInteger(closeCode)
    && closeCode >= GATEWAY_VERDICT_CLOSE_CODE_MIN
    && closeCode <= GATEWAY_VERDICT_CLOSE_CODE_MAX;
}

/**
 * What a classified gateway dial failure means for the user. The close-code
 * kinds come from the gateway; `sign_in_required`, `pairing_required` and
 * `account_changed` come from the platform's own refusal before the gateway
 * was asked, so a UI can prompt for sign-in or pairing instead of retrying.
 */
export type GatewayDialFailureKind =
  | 'protocol'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'timeout'
  | 'quota'
  | 'host_offline'
  | 'sign_in_required'
  | 'pairing_required'
  | 'account_changed';

/**
 * A classified gateway dial failure. `retryable: false` ends the reconnect
 * ladder after that attempt; `retryable: true` backs off within the
 * controller's ordinary retry bounds. `kind` is what a UI reads to say
 * "offline" rather than "sign-in failed". `code` is the native error code;
 * `closeCode` is the gateway close code, null for a native refusal.
 */
export interface GatewayDialFailure {
  code: string;
  closeCode: number | null;
  kind: GatewayDialFailureKind;
  retryable: boolean;
  userMessage: string;
}

interface GatewayDialMatrixEntry {
  kind: GatewayDialFailureKind;
  retryable: boolean;
  /** Core-owned advice; close-code entries take theirs from classifyGatewayClose. */
  userMessage?: string;
}

/** The one gateway dial retry matrix: gateway close codes and native refusals. */
const GATEWAY_DIAL_MATRIX: {
  readonly closeCodes: Readonly<Record<number, GatewayDialMatrixEntry>>;
  readonly nativeCodes: Readonly<Record<string, Required<GatewayDialMatrixEntry>>>;
} = {
  closeCodes: {
    4400: { kind: 'protocol', retryable: false },
    4401: { kind: 'unauthorized', retryable: false },
    4403: { kind: 'forbidden', retryable: false },
    4404: { kind: 'not_found', retryable: false },
    4408: { kind: 'timeout', retryable: true },
    4429: { kind: 'quota', retryable: true },
    4503: { kind: 'host_offline', retryable: true },
  },
  // Android SshCapabilityPlugin (pocketshell#3086 slice 2): SyncAuthException
  // NOT_SIGNED_IN, GatewayTokenBroker SIGN_IN_REJECTED / ACCOUNT_CHANGED, and
  // the plan-time GATEWAY_UNPAIRED. None heals by redialling.
  nativeCodes: {
    NOT_SIGNED_IN: {
      kind: 'sign_in_required',
      retryable: false,
      userMessage: 'Sign in to your PocketShell account to connect through the gateway.',
    },
    GATEWAY_BROKER_SIGN_IN_REJECTED: {
      kind: 'sign_in_required',
      retryable: false,
      userMessage: 'Your sign-in was not accepted for the gateway — sign out, sign in again, then reconnect.',
    },
    GATEWAY_UNPAIRED: {
      kind: 'pairing_required',
      retryable: false,
      userMessage: 'This device is not paired with that host for this SSH key — pair it again, then reconnect.',
    },
    GATEWAY_ACCOUNT_CHANGED: {
      kind: 'account_changed',
      retryable: false,
      userMessage: 'The signed-in account changed while connecting — reconnect as the account signed in now.',
    },
  },
};

/** The native codes a platform refuses a gateway dial with before any gateway verdict. */
export const GATEWAY_NATIVE_REFUSAL_CODES: readonly string[] = Object.freeze(Object.keys(GATEWAY_DIAL_MATRIX.nativeCodes));

/**
 * Classify a rejected gateway dial. Null when the error is neither a gateway
 * verdict nor a known native refusal, or carries a close code outside the
 * matrix (outside 4000–4999, or a future code): the caller then applies its
 * ordinary default for that error.
 */
export function classifyGatewayDialFailure(code: string, data: Record<string, unknown>): GatewayDialFailure | null {
  if (Object.prototype.hasOwnProperty.call(GATEWAY_DIAL_MATRIX.nativeCodes, code)) {
    const native = GATEWAY_DIAL_MATRIX.nativeCodes[code]!;
    return { code, closeCode: null, kind: native.kind, retryable: native.retryable, userMessage: native.userMessage };
  }
  if (code !== GATEWAY_CLOSED_ERROR_CODE) return null;
  const closeCode = data['gatewayCloseCode'];
  if (typeof closeCode !== 'number' || !isGatewayVerdictCloseCode(closeCode)) return null;
  const entry = GATEWAY_DIAL_MATRIX.closeCodes[closeCode];
  if (entry === undefined) return null;
  return {
    code,
    closeCode,
    kind: entry.kind,
    retryable: entry.retryable,
    userMessage: entry.userMessage ?? classifyGatewayClose(closeCode).userMessage,
  };
}

// --- fingerprint + host-key trust policy ---------------------------------------
//
// The pairing fingerprint and the presented key's fingerprint meet HERE, in
// one pure verdict, so every client refuses the same way.

/**
 * Normalize a user-provided SHA-256 fingerprint to the OpenSSH display form
 * `SHA256:<base64-unpadded>`. Accepts the output of `ssh-keygen -lf`
 * (which is `256 SHA256:… comment (ED25519)`) by extracting the fingerprint,
 * a bare `SHA256:…`, padding, and any letter case on the prefix. Null for
 * anything that is not a SHA-256 fingerprint (md5 lines, hex, prose).
 */
export function normalizeSha256Fingerprint(input: string): string | null {
  const match = /SHA256:\s*([A-Za-z0-9+/=]+)/i.exec(input);
  if (match === null) return null;
  const b64 = match[1]!.replace(/=+$/, '');
  if (b64.length !== 43) return null;
  if (!sha256BodyDecodesTo32Bytes(b64)) return null;
  return `SHA256:${b64}`;
}

function sha256BodyDecodesTo32Bytes(b64: string): boolean {
  try {
    const padded = `${b64}${'='.repeat((4 - (b64.length % 4)) % 4)}`;
    return atob(padded).length === 32;
  } catch {
    return false;
  }
}

/** The three ways a gateway dial can relate to a pin. There is no "unknown →
 * ask" arm on purpose: gateway mode fails closed — an absent pin is a
 * refusal, not a TOFU prompt (the gateway cannot be trusted to introduce
 * the host key, and the legacy bridge's accept-always default must not leak
 * into this transport). */
export type GatewayHostKeyVerdict = 'trusted' | 'mismatch' | 'unpinned';

/**
 * The gateway host-key verdict: the independently provisioned pin (paired
 * out of band, never via the gateway) against the fingerprint of the key the
 * host actually presented during the SSH handshake.
 */
export function verifyGatewayHostKeyPin(
  pinnedFingerprint: string | null | undefined,
  presentedFingerprint: string,
): GatewayHostKeyVerdict {
  if (typeof pinnedFingerprint !== 'string') return 'unpinned';
  const pinned = normalizeSha256Fingerprint(pinnedFingerprint);
  if (pinned === null) return 'unpinned';
  const presented = normalizeSha256Fingerprint(presentedFingerprint);
  if (presented === null) return 'mismatch';
  return pinned === presented ? 'trusted' : 'mismatch';
}

/**
 * The base64 key blob of an OpenSSH-format public host key line — the
 * `ssh_host_key` the enrollment flow pins (`[host] key-type b64` or
 * `key-type b64`). Null when the line is not one of those shapes.
 */
export function hostKeyLineBlobB64(line: string): string | null {
  const fields = line.trim().split(/\s+/);
  if (fields.length < 2 || fields.length > 3) return null;
  const keyType = fields[fields.length - 2]!;
  const blob = fields[fields.length - 1]!;
  if (!/^[A-Za-z0-9._-]+$/.test(keyType) || !/^[A-Za-z0-9+/]+=*$/.test(blob)) return null;
  try {
    atob(`${blob}${'='.repeat((4 - (blob.length % 4)) % 4)}`);
  } catch {
    return null;
  }
  return blob;
}

/**
 * Whether two host-key blob base64 strings are the same key, ignoring base64
 * padding (known_hosts lines are unpadded; some tools print padding).
 */
export function sameHostKeyBlobB64(a: string, b: string): boolean {
  return a.replace(/=+$/, '') === b.replace(/=+$/, '');
}
