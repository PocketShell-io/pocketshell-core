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
 *  - A short-lived scoped broker JWT — the ROUTING token — only ADMITS the
 *    route. Each platform mints it per dial from its own account-service
 *    origin (`POST /gateway/token` at the FIXED trusted issuer the platform
 *    configures for the signed-in account), exchanging the account
 *    credential natively. The issuer is never derived from a saved gateway
 *    target, sync data, or a redirect; when the exchange fails the dial
 *    fails — the raw Google ID/bearer token is never sent to the gateway as
 *    a fallback. The routing token travels in the auth frame only — never
 *    in a URL, never persisted, never logged.
 *  - The SSH private key authenticates against the host's sshd: the routing
 *    token admits a tunnel, it never authorizes SSH on the user's machine.
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
 * by the account's platform-minted routing token, the fingerprint pin stays
 * client-local. This is ONLY the tunnel endpoint: the broker/account-service
 * origin a dial exchanges its routing token at is configured by the platform
 * independently and must NEVER be read from this saved target.
 */
export interface GatewayTransportTarget {
  /**
   * Canonical gateway base URL, `wss://…` (or `ws://…` ONLY for a loopback
   * development gateway the platform's own trusted dial policy admits —
   * that allowance is caller configuration, `SshDialPolicy` in
   * `sshCapability.ts`, never a property of this saved marker).
   */
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
 * rejected, so nothing can smuggle a token into a URL. Misplaced user
 * credentials (`wss://me:pass@host`) are rejected too, never stripped:
 * silently dropping them would accept a sanitized target while the secret
 * sat in paste history, logs and the saved record as "the URL".
 *
 * The placement rules run on the ORIGINAL text, before WHATWG
 * canonicalization: the URL parser would silently erase exactly the
 * placements this contract refuses (`/secret/..` collapses to `/`,
 * embedded tab/newline/control characters vanish, percent- and IDN-encoded
 * hosts are rewritten), so a hostile-looking input could normalize into a
 * clean-looking origin. Only host case, an explicit default port
 * (`wss://host:443`, `ws://host:80`), and one trailing root slash may
 * differ from the canonical output; the host itself is plain ASCII
 * (`reg-name`/IPv4 characters, or a bracketed IPv6 literal) with an
 * optional port. This is shape normalization only — a `ws://` URL still
 * normalizes here; the secure-transport decision belongs to the dial
 * boundary (`classifySshDial`).
 */
export function normalizeGatewayServerUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  if (!isOriginOnlyGatewayUrlText(trimmed)) return null;
  let candidate = trimmed;
  const httpLike = /^(https?):\/\//i.exec(trimmed);
  if (httpLike !== null) {
    candidate = `${httpLike[1]!.toLowerCase() === 'https' ? 'wss' : 'ws'}://${trimmed.slice(httpLike[0].length)}`;
  }
  // A userinfo `@` cannot appear in a legitimate pure origin (neither the
  // host nor the fixed path carries one), so its presence is exactly the
  // misplaced-credential shape.
  if (candidate.includes('@')) return null;
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

/** The strict grammar the raw text must already satisfy before the URL
 * parser is allowed to touch it: scheme, bare authority, optional single
 * trailing slash. Every character class here excludes the separators
 * (`/`, `?`, `#`, `@`) and the characters WHATWG strips or rewrites
 * (control characters, whitespace, `%`, non-ASCII), so anything the
 * parser would change about the placement is refused instead. */
function isOriginOnlyGatewayUrlText(input: string): boolean {
  const match = /^(wss|ws|https|http):\/\/([^/?#]*)(\/)?$/i.exec(input);
  if (match === null) return false;
  return /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(:[0-9]{1,5})?$/.test(match[2]!);
}

/**
 * Normalize a raw (JSON-round-tripped) gateway target. Null when either
 * field is unusable — callers treat null as "not a gateway host" and the
 * entry must then refuse to dial rather than guess. This validates SHAPE
 * only (a `ws://` URL still normalizes); enforcing the secure-transport
 * policy is the dial boundary's job (`classifySshDial`).
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

/**
 * A short-lived gateway ROUTING token: the scoped broker JWT each platform
 * mints per dial at its OWN account-service origin (`POST /gateway/token`
 * at the FIXED trusted issuer the platform configures for the signed-in
 * account — never a saved gateway target's URL, never a redirect, no
 * fallback to the raw Google ID/bearer credential when the exchange
 * fails). It admits the tunnel route — it never authorizes SSH on the host
 * (public-key userauth stays mandatory) — and is never persisted or
 * logged: only token+expiry cross into transport code.
 */
export interface GatewayRoutingToken {
  token: string;
  /**
   * Epoch ms after which the broker stops honoring the token. The scoped
   * broker exchange ALWAYS states one — a response with a missing,
   * non-finite, or already-passed expiry fails closed (the platform
   * validates before the token is used; `null`/absent expiry is never
   * legal on this path, so the type does not admit one).
   */
  expiresEpochMs: number;
}

// --- JSON handshake frames ---------------------------------------------------
//
// All handshake messages are WebSocket TEXT frames; everything after the
// handshake is BINARY. Mirrors the Go structs (protocol.go): ClientAuth,
// ReadyMsg, ErrMsg.

/** The client's first message — the only place the routing token ever
 * travels (see the module header: a platform-minted scoped broker JWT, never
 * the account credential itself). */
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
 * guessed into shape. Malformed `reason`s name the structural fault only:
 * they never quote the peer's field values (type, version, or payload), so a
 * hostile frame cannot push its content into a user-facing error. */
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
    return { kind: 'malformed', reason: 'handshake frame carries an unsupported protocol version' };
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
  return { kind: 'malformed', reason: 'handshake frame type is not part of the v1 handshake' };
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
      return { kind: 'protocol', userMessage: 'The gateway rejected this connection as malformed.' };
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

/**
 * The stable namespace every gateway trust record must live under — the
 * independently paired host-key fingerprint pin, and any per-host gateway
 * key association a client keeps. The pairing identity is the triple
 * (account, canonical gateway origin, device id): two accounts, two
 * gateways, or two devices behind one hostname must never borrow each
 * other's pin, and a direct-SSH known_hosts entry must never be confused
 * with one, so gateway records live in their OWN store keyed by this value,
 * never in the direct known_hosts namespace. The fields are JSON-encoded as
 * a triple so a value containing the separator character cannot alias
 * another triple. `target` must be the NORMALIZED gateway target (the
 * shape `classifySshDial`'s gateway arm returns); `accountId` is the
 * platform's stable account identifier — throws on an empty one.
 */
export function gatewayHostKeyTrustNamespace(accountId: string, target: GatewayTransportTarget): string {
  if (typeof accountId !== 'string' || accountId.trim().length === 0) {
    throw new Error('gateway trust namespace needs a non-empty account id');
  }
  return `gateway:${JSON.stringify([accountId, target.serverUrl, target.deviceId])}`;
}
