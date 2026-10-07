import type { HostKeyTrustPin, PresentedHostKey } from './hostKeyTrustCore';
import { normalizeGatewayTarget, normalizeSha256Fingerprint, type GatewayTransportTarget } from './gatewayTransport';

/** Stable opaque identifier owned by the platform's SSH key storage. */
export interface SshKeyHandleCredential {
  kind: 'key-handle';
  handleId: string;
  /** A short-lived value supplied for a single connection attempt. */
  passphrase?: string | null;
}

export type SshCredential =
  | { kind: 'private-key'; privateKeyPem: string; passphrase?: string | null }
  | { kind: 'password'; password: string }
  | SshKeyHandleCredential
  /** The shared relay token — the only secret a link host needs
   * (docs/link-transport.md in pocketshell-cli). Never meaningful to the
   * native SSH transports; a dial carrying it must route to the link
   * capability. */
  | { kind: 'link-token'; token: string };

/**
 * The link transport dial info: the relay to meet on and the host_id the
 * daemon registered under. The token rides {@link SshCredential} as
 * `link-token` — one secret per host, wherever that client keeps secrets.
 */
export interface LinkTransportTarget {
  /** Relay origin, e.g. `wss://relay.example:8765`. */
  relayUrl: string;
  /** The `--host-id` the daemon was started with. */
  hostId: string;
}

/** Validate the portable link-target shape without reaching the network. */
export function isLinkTransportTarget(value: unknown): value is LinkTransportTarget {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.relayUrl === 'string' &&
    candidate.relayUrl.trim().length > 0 &&
    typeof candidate.hostId === 'string' &&
    candidate.hostId.trim().length > 0
  );
}

/** Validate the portable shape without resolving or normalizing the handle. */
export function isValidSshKeyHandleCredential(value: unknown): value is SshKeyHandleCredential {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== 'key-handle') return false;
  if (typeof candidate.handleId !== 'string' || candidate.handleId.trim().length === 0) return false;
  if (candidate.passphrase !== undefined && candidate.passphrase !== null && typeof candidate.passphrase !== 'string') {
    return false;
  }
  return Object.keys(candidate).every((key) => ['kind', 'handleId', 'passphrase'].includes(key));
}

export interface SshHostTarget {
  hostId: string;
  hostname: string;
  port: number;
  username: string;
  credential: SshCredential;
  /**
   * Set when the host has no inbound SSH and the dial rides the link
   * transport (relay + daemon, docs/link-transport.md). `credential` must
   * then be `link-token`; `hostname`/`port` are display-only for such hosts.
   */
  link?: LinkTransportTarget;
  /**
   * Set when the dial rides the PocketShell gateway (see
   * `gatewayTransport.ts`): the platform opens the gateway's per-host
   * WebSocket, sends its own short-lived routing token in the auth frame,
   * and runs real SSH end-to-end through the tunnel. `credential` must then
   * be the host's REAL SSH key credential (`private-key` or `key-handle`) —
   * a password never rides the gateway, and a link-token is never a routing
   * token. The independently paired host-key fingerprint rides
   * `expectedHostKey` at connect time, never this marker (a value the
   * gateway delivers cannot vouch for the host); `hostname`/`port` are
   * display-only labels for such dials. Presence is intent: a marker that
   * is null, undefined, malformed, or combined with `link` must REFUSE the
   * dial (`classifySshDial`), never fall back to direct SSH.
   */
  gateway?: GatewayTransportTarget;
}

export interface SshConnectionRef {
  connectionId: string;
  generationId: string;
}

export interface SshConnectionStateEvent extends SshConnectionRef {
  state: 'lost' | 'closed';
  reason: string | null;
}

export interface SshListenerHandle {
  remove(): Promise<void>;
}

export interface SshAck {
  requestId: string;
}

export interface SshResourceSnapshot extends SshAck {
  connections: number;
  ptys: number;
  sftpClients: number;
  forwards: number;
}

/** True when this dial must ride the link transport, not SSH. */
export function isLinkDial(target: SshHostTarget): boolean {
  return isLinkTransportTarget(target.link) && target.credential.kind === 'link-token';
}

// --- the dial classification boundary ------------------------------------------
//
// One pure, effect-free answer to "how may this dial travel, if at all?",
// evaluated BEFORE any effect: before a controller creates a connection
// record, before a native plugin opens a socket, before a broker token is
// minted. Platform shells (Android's host store/app guard, desktop's
// SshService, the browser) call it at their entry points and refuse
// `refused` plans verbatim; the capability implementations call
// {@link classifySshConnect} first thing in `connect` and never open a
// transport for anything but a direct/link/gateway plan.
//
// The rules it enforces (docs/gateway-dial-contract.md has the long form):
//  - Presence is intent. An OWN `gateway` or `link` property — a valid
//    target, null, undefined, or a malformed shape — commits the dial to
//    that transport. An unusable marker is a refusal, never a guess that
//    the host is ordinary SSH.
//  - Transports are exclusive. Both markers refuse even when each is
//    individually well-formed.
//  - A gateway dial needs a NORMALIZED target (canonical `wss://` origin +
//    registry-valid device id), a real SSH key credential, and — at connect
//    time, via {@link classifySshConnect} — an independently provisioned
//    host-key fingerprint pin on `expectedHostKey`. Passwords, link tokens
//    and absent pins never ride the gateway; there is no TOFU prompt.
//  - Healthy direct and link dials classify exactly as before: direct with
//    a private-key/password/key-handle credential, link with the link
//    target + link-token credential. This boundary adds refusals for
//    misconfigurations that previously fell through (a link-token with no
//    link target, a link target with an SSH credential) — the
//    `isLinkDial`/`isLinkTransportTarget` predicates keep their shapes.
//
// Refusal messages name the fault, never echo the offending value: target
// URLs, device ids, credential material and marker shapes must not be
// reflected into user-visible errors.

/** Stable refusal codes on {@link SshDialPlan}; platforms branch on these
 * for their own copy/telemetry but must not weaken them into fallbacks. */
export type SshDialRefusalCode =
  | 'dial-target-invalid'
  | 'dial-transport-conflict'
  | 'gateway-marker-invalid'
  | 'gateway-credential-unsupported'
  | 'gateway-host-key-unpinned'
  | 'link-marker-invalid'
  | 'link-credential-mismatch'
  | 'link-token-without-link'
  | 'credential-invalid';

/**
 * How a dial may travel: plain SSH (`direct`), the link relay (`link`), the
 * PocketShell gateway with its NORMALIZED target (`gateway`), or a
 * `refused` verdict that must end the dial. The gateway arm's target is
 * always the normalized form, so consumers never re-normalize a saved
 * record and never dial a URL the contract has not seen.
 */
export type SshDialPlan =
  | { kind: 'direct' }
  | { kind: 'link' }
  | { kind: 'gateway'; gateway: GatewayTransportTarget }
  | { kind: 'refused'; code: SshDialRefusalCode; message: string };

function refusedDial(code: SshDialRefusalCode, message: string): SshDialPlan {
  return { kind: 'refused', code, message };
}

/** Marker presence is OWN-property presence (`hasGatewayMarker` semantics):
 * `gateway: undefined` set on the object is still gateway intent. */
function hasOwnMarker(target: object, key: 'link' | 'gateway'): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/** A gateway dial authenticates with the host's real SSH key — nothing else. */
function gatewayCredentialRefusal(credential: SshCredential): SshDialPlan | null {
  if (credential.kind === 'password' || credential.kind === 'link-token') {
    return refusedDial(
      'gateway-credential-unsupported',
      'A gateway dial authenticates with the host\u2019s SSH private key or key handle; a password or link token never rides the gateway.',
    );
  }
  if (credential.kind === 'private-key') {
    if (typeof credential.privateKeyPem !== 'string' || credential.privateKeyPem.trim().length === 0) {
      return refusedDial('credential-invalid', 'The private-key credential carries no key material.');
    }
    return null;
  }
  if (!isValidSshKeyHandleCredential(credential)) {
    return refusedDial('credential-invalid', 'The credential is not a usable SSH key credential.');
  }
  return null;
}

/** Structural checks shared by every transport arm; direct keeps accepting
 * the three SSH credential kinds it always has. */
function directCredentialRefusal(credential: SshCredential): SshDialPlan | null {
  if (credential.kind === 'private-key') {
    if (typeof credential.privateKeyPem !== 'string' || credential.privateKeyPem.trim().length === 0) {
      return refusedDial('credential-invalid', 'The private-key credential carries no key material.');
    }
    return null;
  }
  if (credential.kind === 'password') {
    if (typeof credential.password !== 'string' || credential.password.length === 0) {
      return refusedDial('credential-invalid', 'The password credential is empty.');
    }
    return null;
  }
  if (!isValidSshKeyHandleCredential(credential)) {
    return refusedDial('credential-invalid', 'The credential is not one this dial can use.');
  }
  return null;
}

/**
 * Classify a dial target before ANY effect (the exact order, documented for
 * every platform adopting the boundary):
 *
 * 1. the target must be an object and carry a credential at all;
 * 2. OWN `link` and `gateway` markers are read; both present is a
 *    `dial-transport-conflict` refusal even when each is well-formed;
 * 3. a present `gateway` marker must normalize (`normalizeGatewayTarget`) —
 *    null/malformed refuses as `gateway-marker-invalid` — and its
 *    credential must be a real private-key/key-handle credential;
 * 4. else a present `link` marker must be a usable link target and pair
 *    with the `link-token` credential;
 * 5. else the dial is direct with a private-key/password/key-handle
 *    credential (a link-token without a link marker refuses: that
 *    credential is only ever meaningful to the link capability).
 *
 * Pure: no I/O, no network, no crypto, no platform calls. For the
 * connect-time pin requirement see {@link classifySshConnect}.
 */
export function classifySshDial(target: SshHostTarget): SshDialPlan {
  if (typeof target !== 'object' || target === null) {
    return refusedDial('dial-target-invalid', 'The dial target is missing.');
  }
  const credential = (target as { credential?: unknown }).credential;
  if (typeof credential !== 'object' || credential === null) {
    return refusedDial('credential-invalid', 'The dial carries no SSH credential.');
  }
  const hasLink = hasOwnMarker(target, 'link');
  const hasGateway = hasOwnMarker(target, 'gateway');
  if (hasLink && hasGateway) {
    return refusedDial(
      'dial-transport-conflict',
      'This host carries both a link and a gateway transport; the dial refuses instead of picking one.',
    );
  }
  if (hasGateway) {
    const gateway = normalizeGatewayTarget((target as { gateway?: unknown }).gateway);
    if (gateway === null) {
      return refusedDial(
        'gateway-marker-invalid',
        'This host carries a gateway transport whose target is not a usable gateway address; fix the saved record before dialling.',
      );
    }
    const credentialRefusal = gatewayCredentialRefusal(credential as SshCredential);
    if (credentialRefusal !== null) return credentialRefusal;
    return { kind: 'gateway', gateway };
  }
  if (hasLink) {
    if (!isLinkTransportTarget((target as { link?: unknown }).link)) {
      return refusedDial(
        'link-marker-invalid',
        'This host carries a link transport whose target is not a usable relay address.',
      );
    }
    const linkCredential = credential as SshCredential;
    if (linkCredential.kind !== 'link-token' || typeof linkCredential.token !== 'string' || linkCredential.token.length === 0) {
      return refusedDial(
        'link-credential-mismatch',
        'This host dials the link transport only with its link-token credential.',
      );
    }
    return { kind: 'link' };
  }
  if ((credential as SshCredential).kind === 'link-token') {
    return refusedDial(
      'link-token-without-link',
      'A link-token credential dials the link transport, but this host carries no link target.',
    );
  }
  const directRefusal = directCredentialRefusal(credential as SshCredential);
  if (directRefusal !== null) return directRefusal;
  return { kind: 'direct' };
}

/**
 * The connect-time boundary every {@link SshCapability.connect}
 * implementation runs FIRST, before opening any transport or minting any
 * token: {@link classifySshDial}'s verdict, plus the gateway rule that the
 * dial arrive with an independently provisioned host-key fingerprint pin on
 * `expectedHostKey`. A gateway dial without a usable pin is a refusal —
 * there is no first-contact prompt on this transport, because a value the
 * gateway delivers can never vouch for the host. Direct and link plans
 * keep their existing trust flows unchanged.
 */
export function classifySshConnect(options: SshConnectOptions): SshDialPlan {
  const plan = classifySshDial(options);
  if (plan.kind !== 'gateway') return plan;
  const fingerprint = options.expectedHostKey === null || options.expectedHostKey === undefined
    ? null
    : options.expectedHostKey.fingerprintSha256;
  if (typeof fingerprint !== 'string' || normalizeSha256Fingerprint(fingerprint) === null) {
    return refusedDial(
      'gateway-host-key-unpinned',
      'This gateway host has no independently paired host-key fingerprint; pair the host out of band before dialling.',
    );
  }
  return plan;
}

export interface SshConnectOptions extends SshHostTarget {
  requestId: string;
  generationId: string;
  /**
   * The independently provisioned host-key pin. Direct dials may arrive
   * without one (first contact prompts); a GATEWAY dial must arrive WITH a
   * usable SHA-256 fingerprint pin — `classifySshConnect` refuses the
   * unpinned dial before any effect, because a first-contact prompt on the
   * gateway would let the gateway introduce the host it impersonates.
   */
  expectedHostKey: HostKeyTrustPin | null;
  connectTimeoutMs?: number;
}

export interface SshConnectResult extends SshConnectionRef {
  requestId: string;
  hostKey: PresentedHostKey;
}

export type SshCancellationTarget =
  | { kind: 'connect'; targetRequestId: string }
  | { kind: 'connection'; connectionId: string; generationId: string };

export interface SshCancellationOptions {
  requestId: string;
  target: SshCancellationTarget;
}

export interface SshCancellationResult extends SshAck {
  cancelled: boolean;
}

export interface SshExecOptions extends SshConnectionRef {
  requestId: string;
  command: string;
  timeoutMs: number;
  /**
   * Written to the command's stdin, then EOF — how `pocketshell env set`
   * receives its JSON payload without putting values on a `ps`-readable
   * command line. Optional; the SSH transports always support it, the link
   * transport since the exec-stdin protocol addition.
   */
  stdinBase64?: string;
}

export interface SshExecResult extends SshConnectionRef {
  requestId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SshPtyOpenOptions extends SshConnectionRef {
  requestId: string;
  command: string;
  cols: number;
  rows: number;
  term?: string;
}

export interface SshPtyRef extends SshConnectionRef {
  channelId: string;
}

export interface SshPtyReadOptions extends SshPtyRef {
  requestId: string;
  sequence: number;
  maxBytes?: number;
  waitMs?: number;
}

export interface SshPtyReadResult extends SshPtyRef {
  requestId: string;
  sequence: number;
  dataBase64: string;
  eof: boolean;
}

export interface SshPtyOperationOptions extends SshPtyRef {
  requestId: string;
  sequence: number;
}

export interface SshPtyWriteOptions extends SshPtyOperationOptions {
  dataBase64: string;
}

export interface SshPtyResizeOptions extends SshPtyOperationOptions {
  cols: number;
  rows: number;
}

export interface SshSftpEntry {
  path: string;
  name: string;
  isDirectory: boolean;
  sizeBytes: number;
  modifiedEpochMs: number;
}

export interface SshSftpOptions extends SshConnectionRef {
  requestId: string;
  path: string;
}

export interface SshSftpWriteOptions extends SshSftpOptions {
  dataBase64: string;
  /** Emit cumulative acknowledged bytes for each completed SFTP write chunk. */
  reportProgress?: boolean;
}

/** Cumulative bytes acknowledged by the native SFTP write operation. */
export interface SshSftpWriteProgressEvent extends SshSftpOptions {
  bytesWritten: number;
  totalBytes: number;
}

export interface SshPortForwardOptions extends SshConnectionRef {
  requestId: string;
  remoteHost: string;
  remotePort: number;
  localPort?: number;
}

export interface SshPortForwardRef extends SshConnectionRef {
  forwardId: string;
  localPort: number;
}

/**
 * Runtime-neutral SSH effects supplied by a client shell. A native plugin may
 * implement this interface directly; the controller owns all decisions made
 * after these physical operations report their results.
 */
export interface SshCapability {
  /**
   * How many SSH channels the platform opens on one connection before it
   * refuses with `CHANNEL_LIMIT` — PTYs, execs and forwards share it. A
   * platform with a fixed budget (Android's plugin: 8) states it so the
   * controller bounds its PTYs and keeps exec headroom; absent means the
   * controller's default PTY bound applies (#2955).
   */
  readonly maxChannelsPerConnection?: number;
  addListener(
    eventName: 'connectionState',
    listenerFunc: (event: SshConnectionStateEvent) => void,
  ): Promise<SshListenerHandle>;
  addListener(
    eventName: 'sftpWriteProgress',
    listenerFunc: (event: SshSftpWriteProgressEvent) => void,
  ): Promise<SshListenerHandle>;
  /**
   * Open a connection. Implementations run {@link classifySshConnect} on
   * the options FIRST and end every `refused` plan before any effect — no
   * socket, no broker token, no connection record; `expectedHostKey` is
   * retained for every transport, and the platform verifies the actually
   * presented host key against it before SSH userauth. Gateway dials then
   * ride the platform's own broker exchange and WebSocket (never a core
   * network path; the routing token never persists here).
   */
  connect(options: SshConnectOptions): Promise<SshConnectResult>;
  getConnectionState(ref: SshConnectionRef & { requestId: string }): Promise<SshAck & { state: 'connected' | 'lost' | 'closed' }>;
  closeConnection(ref: SshConnectionRef & { requestId: string }): Promise<SshAck>;
  /**
   * Cancel a pending dial by request id (including a cancellation that races
   * native dial registration), or cancel a generation to stop all its
   * in-flight exec/PTY/SFTP/forwarding I/O. Generation cancellation closes
   * the transport as a safe cancellation boundary: callers treat interrupted
   * mutations as uncertain and never replay them automatically.
   */
  cancelOperation(options: SshCancellationOptions): Promise<SshCancellationResult>;
  scheduleClose(ref: SshConnectionRef & { requestId: string; deadlineEpochMs: number }): Promise<SshAck>;
  cancelScheduledClose(ref: SshConnectionRef & { requestId: string }): Promise<SshAck & { cancelled: boolean }>;
  exec(options: SshExecOptions): Promise<SshExecResult>;
  openPty(options: SshPtyOpenOptions): Promise<SshPtyRef & { requestId: string }>;
  readPty(options: SshPtyReadOptions): Promise<SshPtyReadResult>;
  writePty(options: SshPtyWriteOptions): Promise<SshPtyOperationOptions>;
  resizePty(options: SshPtyResizeOptions): Promise<SshPtyOperationOptions>;
  closePty(options: SshPtyRef & { requestId: string }): Promise<SshAck>;
  sftpList(options: SshSftpOptions): Promise<{ requestId: string; entries: SshSftpEntry[] }>;
  sftpRead(options: SshSftpOptions & { maxBytes: number }): Promise<{ requestId: string; dataBase64: string }>;
  sftpWrite(options: SshSftpWriteOptions): Promise<{ requestId: string; bytesWritten: number }>;
  sftpMkdir(options: SshSftpOptions): Promise<{ requestId: string }>;
  sftpRename(options: SshSftpOptions & { destination: string }): Promise<{ requestId: string }>;
  sftpDelete(options: SshSftpOptions): Promise<{ requestId: string }>;
  openPortForward(options: SshPortForwardOptions): Promise<SshPortForwardRef & { requestId: string }>;
  closePortForward(options: SshPortForwardRef & { requestId: string }): Promise<SshAck>;
  resourceSnapshot(requestId: string): Promise<SshResourceSnapshot>;
}

/** Structured errors crossing any platform's SSH capability boundary. */
export class SshCapabilityError extends Error {
  readonly code: string;
  readonly data: Record<string, unknown>;

  constructor(message: string, code = 'SSH_ERROR', data: Record<string, unknown> = {}) {
    super(message);
    this.name = 'SshCapabilityError';
    this.code = code;
    this.data = data;
  }
}

/** Normalize structured bridge errors without importing a platform runtime. */
export function readSshCapabilityError(error: unknown): SshCapabilityError {
  if (error instanceof SshCapabilityError) return error;
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { message?: unknown; code?: unknown; data?: unknown };
    const data = typeof candidate.data === 'object' && candidate.data !== null
      ? candidate.data as Record<string, unknown>
      : {};
    return new SshCapabilityError(
      typeof candidate.message === 'string' ? candidate.message : 'SSH operation failed',
      typeof candidate.code === 'string' ? candidate.code : 'SSH_ERROR',
      data,
    );
  }
  return new SshCapabilityError(String(error));
}
