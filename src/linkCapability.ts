/**
 * The link transport capability: `SshCapability` over one outbound WebSocket
 * to a PocketShell relay (docs/link-transport.md, in the pocketshell-cli
 * repo).
 *
 * A host without inbound SSH (laptop, home/office box behind NAT) runs
 * `pocketshell link run`, which dials OUT to the relay and stays dialled in.
 * This capability plays the client role of the same relay: one WebSocket,
 * control frames as JSON text, channel data as binary `u32BE channel |
 * payload` frames. Everything above `SshCapability` (ConnectionController,
 * HostCliCore, AplexerCore) is unchanged — link is just another transport
 * under the seam, with SFTP and port forwarding reported as typed
 * UNSUPPORTED.
 *
 * The socket is injected (`LinkSocketFactory`) so the desktop main process
 * can pass Electron's `ws`, the web client the browser's native WebSocket,
 * and tests an in-memory pair — the protocol code stays runtime-neutral.
 * Crypto is likewise dependency-free: the TOFU fingerprint uses the pure-TS
 * SHA-256 below because `crypto.subtle` is absent in insecure contexts
 * (a plain `ws://` LAN relay on Android).
 */

import { verifyHostKeyTrustPin, type HostKeyTrustPin, type PresentedHostKey } from './hostKeyTrustCore';
import {
  SshCapabilityError,
  type SshAck,
  type SshCancellationOptions,
  type SshCancellationResult,
  type SshConnectOptions,
  type SshConnectResult,
  type SshConnectionRef,
  type SshConnectionStateEvent,
  type SshCapability,
  type SshExecOptions,
  type SshExecResult,
  type SshListenerHandle,
  type SshPortForwardOptions,
  type SshPortForwardRef,
  type SshPtyOpenOptions,
  type SshPtyOperationOptions,
  type SshPtyReadOptions,
  type SshPtyReadResult,
  type SshPtyRef,
  type SshPtyResizeOptions,
  type SshPtyWriteOptions,
  type SshResourceSnapshot,
  type SshSftpEntry,
  type SshSftpOptions,
  type SshSftpWriteOptions,
} from './sshCapability';

const LINK_PROTO_VERSION = 1;

/** What this runtime's setTimeout returns (number in browsers, object in Node). */
type TimerHandle = ReturnType<typeof setTimeout>;

/** The client-side err-channel id space (mirrors the daemon's convention). */
const ERR_CHANNEL_BASE = 0x40000000;

// ---------------------------------------------------------------------------
// platform-neutral helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let idCounter = 0;

/** Opaque connection/generation ids without leaning on crypto.randomUUID. */
function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function toBase64(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i += 0x8000) {
    binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// pure-TS SHA-256 (no crypto.subtle: absent in insecure contexts)
// ---------------------------------------------------------------------------

const SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

export function sha256Hex(data: Uint8Array): string {
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const byteLength = data.length;
  const padded = new Uint8Array(((byteLength + 8) >> 6 << 6) + 64);
  padded.set(data);
  padded[byteLength] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((byteLength * 8) / 2 ** 32), false);
  view.setUint32(padded.length - 4, (byteLength * 8) >>> 0, false);
  const w = new Uint32Array(64);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(block + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const wm15 = w[i - 15] ?? 0;
      const wm2 = w[i - 2] ?? 0;
      const s0 = rotr(wm15, 7) ^ rotr(wm15, 18) ^ (wm15 >>> 3);
      const s1 = rotr(wm2, 17) ^ rotr(wm2, 19) ^ (wm2 >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }
    let a = state[0] ?? 0;
    let b = state[1] ?? 0;
    let c = state[2] ?? 0;
    let d = state[3] ?? 0;
    let e = state[4] ?? 0;
    let f = state[5] ?? 0;
    let g = state[6] ?? 0;
    let h = state[7] ?? 0;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + (SHA_K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    state[0] = ((state[0] ?? 0) + a) >>> 0;
    state[1] = ((state[1] ?? 0) + b) >>> 0;
    state[2] = ((state[2] ?? 0) + c) >>> 0;
    state[3] = ((state[3] ?? 0) + d) >>> 0;
    state[4] = ((state[4] ?? 0) + e) >>> 0;
    state[5] = ((state[5] ?? 0) + f) >>> 0;
    state[6] = ((state[6] ?? 0) + g) >>> 0;
    state[7] = ((state[7] ?? 0) + h) >>> 0;
  }
  let hex = '';
  for (let i = 0; i < 8; i += 1) hex += (state[i] ?? 0).toString(16).padStart(8, '0');
  return hex;
}

/** Strip default ports and trailing slashes so pin comparisons are stable. */
export function canonicalRelayUrl(relayUrl: string): string {
  const match = /^(wss|ws|https?):\/\/([^/?#]+)(\/[^#]*)?/.exec(relayUrl.trim());
  if (match === null || match[1] === undefined || match[2] === undefined) return relayUrl.trim();
  const scheme = match[1];
  let authority = match[2].toLowerCase();
  const defaultPort = scheme === 'wss' || scheme === 'https' ? ':443' : ':80';
  if (authority.endsWith(defaultPort)) authority = authority.slice(0, -defaultPort.length);
  const path = (match[3] ?? '/').replace(/\/+$/, '') || '';
  return `${scheme}://${authority}${path}`;
}

/**
 * The TOFU trust anchor for a link host: there is no SSH host key, so the
 * fingerprint is derived from the relay URL and the token. Verifying it with
 * the regular host-key path turns relay/token changes into the existing
 * host-key-change UX instead of a silent re-auth.
 */
export function linkHostKeyFingerprint(relayUrl: string, token: string): string {
  const tokenDigest = sha256Hex(encoder.encode(token));
  return `SHA256:${sha256Hex(encoder.encode(`pocketshell-link-v1|${canonicalRelayUrl(relayUrl)}|${tokenDigest}`))}`;
}

// ---------------------------------------------------------------------------
// socket abstraction
// ---------------------------------------------------------------------------

export interface LinkSocketHandlers {
  onOpen(): void;
  onMessage(data: string | Uint8Array): void;
  onClose(code: number, reason: string): void;
  onError(message: string): void;
}

/** Minimal WebSocket surface: browser WebSocket, Electron `ws`, test doubles. */
export interface LinkSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export type LinkSocketFactory = (url: string, handlers: LinkSocketHandlers) => LinkSocket;

/** Browser adapter; the desktop passes an `ws`-based one from its main. */
export function browserLinkSocketFactory(url: string, handlers: LinkSocketHandlers): LinkSocket {
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  socket.onopen = () => handlers.onOpen();
  socket.onmessage = (event) =>
    handlers.onMessage(typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer));
  socket.onclose = (event) => handlers.onClose(event.code, event.reason);
  socket.onerror = () => handlers.onError('socket error');
  return {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
  };
}

// ---------------------------------------------------------------------------
// wire codec
// ---------------------------------------------------------------------------

interface LinkControlFrame {
  [field: string]: unknown;
  t: string;
  v: number;
}

function control(type: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ v: LINK_PROTO_VERSION, t: type, ...fields });
}

function parseControl(raw: string): LinkControlFrame | null {
  try {
    const frame = JSON.parse(raw) as Record<string, unknown>;
    if (frame === null || typeof frame !== 'object') return null;
    if (frame.v !== LINK_PROTO_VERSION || typeof frame.t !== 'string') return null;
    return frame as LinkControlFrame;
  } catch {
    return null;
  }
}

function dataFrame(channel: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, channel, false);
  out.set(payload, 4);
  return out;
}

function parseDataFrame(raw: Uint8Array): { channel: number; payload: Uint8Array } | null {
  if (raw.length < 4) return null;
  const channel = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(0, false);
  return { channel, payload: raw.slice(4) };
}

// ---------------------------------------------------------------------------
// capability
// ---------------------------------------------------------------------------

export interface LinkCapabilityOptions {
  /** Relay origin, e.g. `wss://relay.example:8765` (no path needed). */
  relayUrl: string;
  /** Shared relay token; the link trust anchor together with the URL. */
  token: string;
  /** The host_id the daemon was started with. */
  hostId: string;
  socketFactory: LinkSocketFactory;
  /** Dial + hello/ready timeout; defaults to 15s. */
  connectTimeoutMs?: number;
}

interface PtyBuffer {
  chunks: Uint8Array[];
  eof: boolean;
  waiters: Array<{ timer: TimerHandle | null; deliver(chunk: Uint8Array, eof: boolean): void }>;
}

interface ExecPending {
  mainChannel: number;
  errChannel: number | null;
  requestId: string;
  stdout: Uint8Array[];
  stderr: Uint8Array[];
  timedOut: boolean;
  settled: boolean;
  timer: TimerHandle | null;
  resolve(result: SshExecResult): void;
  reject(error: SshCapabilityError): void;
}

interface OpenPending {
  resolve(frame: LinkControlFrame): void;
  reject(error: SshCapabilityError): void;
  timer: TimerHandle | null;
}

interface ConnectionEntry {
  ref: SshConnectionRef;
  socket: LinkSocket;
  nextChannel: number;
  ptys: Map<number, PtyBuffer>;
  execs: Map<number, ExecPending>;
  opens: Map<number, OpenPending>;
  state: 'connected' | 'lost' | 'closed';
  scheduledCloseTimer: TimerHandle | null;
}

interface DialAttempt {
  hostKey: PresentedHostKey;
  connectionId: string;
  generationId: string;
  requestId: string;
  socket: LinkSocket | null;
  timer: TimerHandle | null;
  settled: boolean;
  resolve(result: SshConnectResult): void;
  reject(error: SshCapabilityError): void;
}

export function createLinkCapability(options: LinkCapabilityOptions): SshCapability {
  const fingerprint = linkHostKeyFingerprint(options.relayUrl, options.token);
  const presentedKey: PresentedHostKey = {
    keyType: 'link-v1',
    keyB64: toBase64(encoder.encode(sha256Hex(encoder.encode(options.token)))),
    fingerprintSha256: fingerprint,
  };

  const connections = new Map<string, ConnectionEntry>();
  const connectionStateListeners = new Set<(event: SshConnectionStateEvent) => void>();
  const sftpProgressListeners = new Set<() => void>();
  let dial: DialAttempt | null = null;

  function clientUrl(): string {
    const query = new URLSearchParams({ token: options.token, host_id: options.hostId });
    const base = options.relayUrl.replace(/\/+$/, '');
    return `${base}/client?${query.toString()}`;
  }

  function emitState(event: SshConnectionStateEvent): void {
    for (const listener of connectionStateListeners) listener(event);
  }

  function settleDial(error: SshCapabilityError | null, result?: SshConnectResult): void {
    if (dial === null || dial.settled) return;
    dial.settled = true;
    if (dial.timer !== null) clearTimeout(dial.timer);
    const attempt = dial;
    dial = null;
    if (error !== null) {
      attempt.socket?.close(1000, 'dial failed');
      attempt.reject(error);
    } else if (result !== undefined) {
      attempt.resolve(result);
    }
  }

  function entryOf(ref: SshConnectionRef): ConnectionEntry {
    const entry = connections.get(ref.connectionId);
    if (entry === undefined) {
      throw new SshCapabilityError('Unknown link connection.', 'NO_SUCH_CONNECTION', {
        connectionId: ref.connectionId,
      });
    }
    return entry;
  }

  function ptyBufferOf(entry: ConnectionEntry, channelId: string): PtyBuffer {
    const buffer = entry.ptys.get(Number(channelId));
    if (buffer === undefined) {
      throw new SshCapabilityError('No such PTY channel.', 'NO_SUCH_CHANNEL', { channelId });
    }
    return buffer;
  }

  function allocChannel(entry: ConnectionEntry): number {
    const channel = entry.nextChannel;
    entry.nextChannel += 1;
    return channel;
  }

  function sendTo(entry: ConnectionEntry, data: string | Uint8Array): void {
    try {
      entry.socket.send(data);
    } catch {
      // the connection-lost path reports the failure
    }
  }

  function settleExec(entry: ConnectionEntry, pending: ExecPending): void {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.timer !== null) clearTimeout(pending.timer);
    entry.execs.delete(pending.mainChannel);
    if (pending.errChannel !== null) entry.execs.delete(pending.errChannel);
  }

  function resolveExec(entry: ConnectionEntry, pending: ExecPending, exitCode: number | null): void {
    settleExec(entry, pending);
    pending.resolve({
      connectionId: entry.ref.connectionId,
      generationId: entry.ref.generationId,
      requestId: pending.requestId,
      exitCode,
      stdout: decoder.decode(concatBytes(pending.stdout)),
      stderr: decoder.decode(concatBytes(pending.stderr)),
      timedOut: pending.timedOut,
    });
  }

  function rejectExec(entry: ConnectionEntry, pending: ExecPending, error: SshCapabilityError): void {
    settleExec(entry, pending);
    pending.reject(error);
  }

  function flushPty(buffer: PtyBuffer): void {
    for (const waiter of buffer.waiters.splice(0)) {
      if (waiter.timer !== null) clearTimeout(waiter.timer);
      const chunk = takeBuffered(buffer, 65536);
      waiter.deliver(chunk, buffer.eof && buffer.chunks.length === 0);
    }
  }

  function takeBuffered(buffer: PtyBuffer, maxBytes: number): Uint8Array {
    if (buffer.chunks.length === 0) return new Uint8Array(0);
    const taken: Uint8Array[] = [];
    let size = 0;
    while (buffer.chunks.length > 0 && size < maxBytes) {
      const chunk = buffer.chunks[0];
      if (chunk === undefined) break;
      if (size + chunk.length > maxBytes) {
        taken.push(chunk.subarray(0, maxBytes - size));
        buffer.chunks[0] = chunk.subarray(maxBytes - size);
        break;
      }
      taken.push(chunk);
      size += chunk.length;
      buffer.chunks.shift();
    }
    return concatBytes(taken);
  }

  function loseConnection(entry: ConnectionEntry, reason: string): void {
    if (entry.state !== 'connected') return;
    entry.state = 'lost';
    if (entry.scheduledCloseTimer !== null) {
      clearTimeout(entry.scheduledCloseTimer);
      entry.scheduledCloseTimer = null;
    }
    entry.socket.close(1000, reason);
    const lost: SshCapabilityError = new SshCapabilityError(
      `Link connection lost: ${reason}`,
      'CONNECTION_LOST',
      { connectionId: entry.ref.connectionId },
    );
    for (const pending of [...entry.execs.values()]) rejectExec(entry, pending, lost);
    for (const open of entry.opens.values()) {
      if (open.timer !== null) clearTimeout(open.timer);
      open.reject(lost);
    }
    entry.opens.clear();
    for (const buffer of entry.ptys.values()) {
      buffer.eof = true;
      flushPty(buffer);
    }
    emitState({ ...entry.ref, state: 'lost', reason });
  }

  function handleControl(entry: ConnectionEntry, frame: LinkControlFrame): void {
    const channel = typeof frame.ch === 'number' ? frame.ch : null;
    switch (frame.t) {
      case 'opened': {
        if (channel === null) return;
        const open = entry.opens.get(channel);
        if (open === undefined) return;
        entry.opens.delete(channel);
        if (open.timer !== null) clearTimeout(open.timer);
        if (frame.ok === true) {
          if (typeof frame.err_ch === 'number') {
            const pending = entry.execs.get(channel);
            if (pending !== undefined && pending.errChannel === null) {
              pending.errChannel = frame.err_ch;
              entry.execs.set(frame.err_ch, pending);
            }
          }
          open.resolve(frame);
        } else {
          open.reject(
            new SshCapabilityError(
              typeof frame.message === 'string' ? frame.message : 'channel open failed',
              typeof frame.code === 'string' ? frame.code : 'SSH_ERROR',
              { channel },
            ),
          );
        }
        return;
      }
      case 'exit': {
        if (channel === null) return;
        const pending = entry.execs.get(channel);
        if (pending !== undefined) {
          const exitCode = typeof frame.exit_code === 'number' ? frame.exit_code : null;
          resolveExec(entry, pending, pending.timedOut ? null : exitCode);
        }
        const buffer = entry.ptys.get(channel);
        if (buffer !== undefined) {
          buffer.eof = true;
          flushPty(buffer);
        }
        return;
      }
      case 'eof': {
        if (channel === null) return;
        const buffer = entry.ptys.get(channel);
        if (buffer !== undefined) {
          buffer.eof = true;
          flushPty(buffer);
        }
        return;
      }
      case 'ch_error': {
        if (channel === null) return;
        const error = new SshCapabilityError(
          typeof frame.message === 'string' ? frame.message : 'channel error',
          typeof frame.code === 'string' ? frame.code : 'SSH_ERROR',
          { channel },
        );
        const pending = entry.execs.get(channel);
        if (pending !== undefined) rejectExec(entry, pending, error);
        const buffer = entry.ptys.get(channel);
        if (buffer !== undefined) {
          buffer.eof = true;
          flushPty(buffer);
        }
        return;
      }
      default:
        // unknown types are ignored (protocol v1 compatibility rule)
        return;
    }
  }

  function handleData(entry: ConnectionEntry, raw: Uint8Array): void {
    const parsed = parseDataFrame(raw);
    if (parsed === null) return;
    const pending = entry.execs.get(parsed.channel);
    if (pending !== undefined) {
      if (parsed.channel === pending.mainChannel) pending.stdout.push(parsed.payload);
      else pending.stderr.push(parsed.payload);
      return;
    }
    const buffer = entry.ptys.get(parsed.channel);
    if (buffer !== undefined && !buffer.eof) {
      buffer.chunks.push(parsed.payload);
      flushPty(buffer);
    }
  }

  function connectLink(entry: ConnectionEntry): void {
    const attempt = dial;
    const handlers: LinkSocketHandlers = {
      onOpen: () => {
        entry.socket.send(
          control('hello', { role: 'client', host_id: options.hostId, proto: LINK_PROTO_VERSION }),
        );
      },
      onMessage: (data) => {
        if (typeof data === 'string') {
          const frame = parseControl(data);
          if (frame === null) return;
          if (frame.t === 'ready') {
            if (attempt !== null && !attempt.settled) {
              settleDial(null, {
                connectionId: entry.ref.connectionId,
                generationId: entry.ref.generationId,
                requestId: attempt.requestId,
                hostKey: presentedKey,
              });
            }
            return;
          }
          if (frame.t === 'error') {
            const error = new SshCapabilityError(
              typeof frame.message === 'string' ? frame.message : 'relay refused the link',
              typeof frame.code === 'string' ? frame.code : 'SSH_ERROR',
              {},
            );
            if (attempt !== null && !attempt.settled) settleDial(error);
            else loseConnection(entry, typeof frame.code === 'string' ? frame.code : 'error');
            return;
          }
          handleControl(entry, frame);
          return;
        }
        handleData(entry, data);
      },
      onClose: (code, reason) => {
        if (attempt !== null && !attempt.settled) {
          settleDial(new SshCapabilityError(`Link dial failed: ${reason || code}`, 'CONNECTION_LOST'));
          return;
        }
        loseConnection(entry, reason || `closed ${code}`);
      },
      onError: (message) => {
        if (attempt !== null && !attempt.settled) {
          settleDial(new SshCapabilityError(`Link dial failed: ${message}`, 'CONNECTION_LOST'));
        }
      },
    };
    entry.socket = options.socketFactory(clientUrl(), handlers);
  }

  function openChannel(
    entry: ConnectionEntry,
    fields: Record<string, unknown>,
    timeoutMs: number,
    channelId?: number,
  ): Promise<LinkControlFrame> {
    // exec passes its already-registered main channel; pty takes a fresh id.
    const channel = channelId ?? allocChannel(entry);
    const pending: OpenPending = {
      resolve: () => undefined,
      reject: () => undefined,
      timer: null,
    };
    const promise = new Promise<LinkControlFrame>((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    });
    entry.opens.set(channel, pending);
    pending.timer = setTimeout(() => {
      if (entry.opens.get(channel) === pending) {
        entry.opens.delete(channel);
        pending.reject(new SshCapabilityError('link channel open timed out', 'TIMED_OUT', { channel }));
      }
    }, timeoutMs);
    sendTo(entry, control('open', { ch: channel, ...fields }));
    return promise;
  }

  const capability: SshCapability = {
    async addListener(eventName, listenerFunc) {
      const set =
        eventName === 'connectionState'
          ? (listenerFunc as unknown as (event: SshConnectionStateEvent) => void) &&
            connectionStateListeners
          : sftpProgressListeners;
      const listener = listenerFunc as (event: unknown) => void;
      set.add(listener);
      return {
        async remove(): Promise<void> {
          set.delete(listener);
        },
      };
    },

    async connect(connectOptions: SshConnectOptions): Promise<SshConnectResult> {
      if (dial !== null) {
        throw new SshCapabilityError('Another link dial is already in flight.', 'DIAL_IN_PROGRESS');
      }
      if (
        connectOptions.expectedHostKey !== null &&
        verifyHostKeyTrustPin(connectOptions.expectedHostKey, presentedKey) !== 'trusted'
      ) {
        throw new SshCapabilityError(
          'Link host key changed — verify the relay URL and token.',
          'HOST_KEY_MISMATCH',
          { fingerprint },
        );
      }
      const entry: ConnectionEntry = {
        ref: { connectionId: newId('link'), generationId: connectOptions.generationId },
        socket: { send: () => undefined, close: () => undefined },
        nextChannel: 1,
        ptys: new Map(),
        execs: new Map(),
        opens: new Map(),
        state: 'connected',
        scheduledCloseTimer: null,
      };
      const attempt: DialAttempt = {
        hostKey: presentedKey,
        connectionId: entry.ref.connectionId,
        generationId: connectOptions.generationId,
        requestId: connectOptions.requestId,
        socket: null,
        timer: null,
        settled: false,
        resolve: () => undefined,
        reject: () => undefined,
      };
      const promise = new Promise<SshConnectResult>((resolve, reject) => {
        attempt.resolve = resolve;
        attempt.reject = reject;
      });
      dial = attempt;
      attempt.timer = setTimeout(() => {
        settleDial(new SshCapabilityError('link dial timed out', 'TIMED_OUT', {}));
      }, connectOptions.connectTimeoutMs ?? options.connectTimeoutMs ?? 15000);
      entry.ref = { connectionId: attempt.connectionId, generationId: connectOptions.generationId };
      connections.set(attempt.connectionId, entry);
      connectLink(entry);
      try {
        return await promise;
      } catch (error) {
        connections.delete(attempt.connectionId);
        entry.state = 'closed';
        throw error;
      }
    },

    async getConnectionState(ref: SshConnectionRef & { requestId: string }) {
      const entry = connections.get(ref.connectionId);
      return {
        requestId: ref.requestId,
        state: entry === undefined ? 'closed' : entry.state,
      };
    },

    async closeConnection(ref: SshConnectionRef & { requestId: string }): Promise<SshAck> {
      const entry = connections.get(ref.connectionId);
      if (entry === undefined) return { requestId: ref.requestId };
      entry.state = 'closed';
      if (entry.scheduledCloseTimer !== null) {
        clearTimeout(entry.scheduledCloseTimer);
        entry.scheduledCloseTimer = null;
      }
      entry.socket.close(1000, 'closed');
      const lost: SshCapabilityError = new SshCapabilityError('link closed', 'CONNECTION_LOST');
      for (const pending of [...entry.execs.values()]) rejectExec(entry, pending, lost);
      for (const open of entry.opens.values()) {
        if (open.timer !== null) clearTimeout(open.timer);
        open.reject(lost);
      }
      entry.opens.clear();
      for (const buffer of entry.ptys.values()) {
        buffer.eof = true;
        flushPty(buffer);
      }
      emitState({ ...entry.ref, state: 'closed', reason: 'closed' });
      return { requestId: ref.requestId };
    },

    async cancelOperation(cancelOptions: SshCancellationOptions): Promise<SshCancellationResult> {
      const target = cancelOptions.target;
      if (target.kind === 'connect') {
        if (dial !== null && !dial.settled && dial.requestId === target.targetRequestId) {
          settleDial(new SshCapabilityError('link dial cancelled', 'CANCELLED'));
          return { requestId: cancelOptions.requestId, cancelled: true };
        }
        return { requestId: cancelOptions.requestId, cancelled: false };
      }
      const entry = connections.get(target.connectionId);
      if (entry === undefined || entry.state !== 'connected') {
        return { requestId: cancelOptions.requestId, cancelled: false };
      }
      loseConnection(entry, 'cancelled');
      return { requestId: cancelOptions.requestId, cancelled: true };
    },

    async scheduleClose(ref: SshConnectionRef & { requestId: string; deadlineEpochMs: number }) {
      const entry = entryOf(ref);
      const delay = Math.max(0, ref.deadlineEpochMs - Date.now());
      if (entry.scheduledCloseTimer !== null) clearTimeout(entry.scheduledCloseTimer);
      entry.scheduledCloseTimer = setTimeout(() => {
        entry.scheduledCloseTimer = null;
        void capability.closeConnection({ ...entry.ref, requestId: 'scheduled-close' });
      }, delay);
      return { requestId: ref.requestId };
    },

    async cancelScheduledClose(ref: SshConnectionRef & { requestId: string }) {
      const entry = entryOf(ref);
      const cancelled = entry.scheduledCloseTimer !== null;
      if (entry.scheduledCloseTimer !== null) {
        clearTimeout(entry.scheduledCloseTimer);
        entry.scheduledCloseTimer = null;
      }
      return { requestId: ref.requestId, cancelled };
    },

    async exec(execOptions: SshExecOptions): Promise<SshExecResult> {
      const entry = entryOf(execOptions);
      if (entry.state !== 'connected') {
        throw new SshCapabilityError('link connection lost', 'CONNECTION_LOST');
      }
      const mainChannel = allocChannel(entry);
      const pending: ExecPending = {
        mainChannel,
        errChannel: null,
        requestId: execOptions.requestId,
        stdout: [],
        stderr: [],
        timedOut: false,
        settled: false,
        timer: null,
        resolve: () => undefined,
        reject: () => undefined,
      };
      const promise = new Promise<SshExecResult>((resolve, reject) => {
        pending.resolve = resolve;
        pending.reject = reject;
      });
      entry.execs.set(mainChannel, pending);
      // `0` opts out entirely (a minutes-long `repos clone` is legitimate) —
      // the SSH transports treat it the same way.
      if (execOptions.timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          pending.timedOut = true;
          sendTo(entry, control('close', { ch: mainChannel }));
          resolveExec(entry, pending, null);
        }, execOptions.timeoutMs);
      }
      // Everything rejects through `promise`; a settled pending makes the
      // late channel-open failure a silent no-op instead of an orphan.
      void openChannel(
        entry,
        {
          mode: 'exec',
          cmd: execOptions.command,
          timeout_ms: execOptions.timeoutMs > 0 ? execOptions.timeoutMs : undefined,
        },
        Math.max(execOptions.timeoutMs, 10000),
        mainChannel,
      ).then(
        () => {
          // stdin rides the main channel as data frames once the daemon has
          // confirmed the spawn (`opened`); the trailing client→host `eof`
          // is the stdin EOF — the daemon closes the pipe there.
          if (execOptions.stdinBase64 !== undefined) {
            sendTo(entry, dataFrame(mainChannel, fromBase64(execOptions.stdinBase64)));
            sendTo(entry, control('eof', { ch: mainChannel }));
          }
        },
        (error: unknown) => {
          rejectExec(
            entry,
            pending,
            error instanceof SshCapabilityError
              ? error
              : new SshCapabilityError(String(error)),
          );
        },
      );
      return promise;
    },

    async openPty(openOptions: SshPtyOpenOptions): Promise<SshPtyRef & { requestId: string }> {
      const entry = entryOf(openOptions);
      if (entry.state !== 'connected') {
        throw new SshCapabilityError('link connection lost', 'CONNECTION_LOST');
      }
      const frame = await openChannel(
        entry,
        {
          mode: 'pty',
          cmd: openOptions.command,
          cols: openOptions.cols,
          rows: openOptions.rows,
          term: openOptions.term ?? 'xterm-256color',
        },
        15000,
      );
      const channel = typeof frame.ch === 'number' ? frame.ch : allocChannel(entry);
      entry.ptys.set(channel, { chunks: [], eof: false, waiters: [] });
      return {
        connectionId: entry.ref.connectionId,
        generationId: entry.ref.generationId,
        channelId: String(channel),
        requestId: openOptions.requestId,
      };
    },

    async readPty(readOptions: SshPtyReadOptions): Promise<SshPtyReadResult> {
      const entry = entryOf(readOptions);
      const buffer = ptyBufferOf(entry, readOptions.channelId);
      const maxBytes = readOptions.maxBytes ?? 65536;
      const deliver = (chunk: Uint8Array, eof: boolean): SshPtyReadResult => ({
        connectionId: entry.ref.connectionId,
        generationId: entry.ref.generationId,
        channelId: readOptions.channelId,
        requestId: readOptions.requestId,
        sequence: readOptions.sequence,
        dataBase64: toBase64(chunk),
        eof,
      });
      if (buffer.chunks.length > 0) return deliver(takeBuffered(buffer, maxBytes), false);
      if (buffer.eof) return deliver(new Uint8Array(0), true);
      const waitMs = readOptions.waitMs ?? 0;
      if (waitMs <= 0) return deliver(new Uint8Array(0), false);
      return new Promise<SshPtyReadResult>((resolve) => {
        const waiter = {
          timer: null as TimerHandle | null,
          deliver: (chunk: Uint8Array, eof: boolean) => resolve(deliver(chunk, eof)),
        };
        buffer.waiters.push(waiter);
        waiter.timer = setTimeout(() => {
          const index = buffer.waiters.indexOf(waiter);
          if (index >= 0) buffer.waiters.splice(index, 1);
          resolve(deliver(new Uint8Array(0), false));
        }, waitMs);
      });
    },

    async writePty(writeOptions: SshPtyWriteOptions): Promise<SshPtyOperationOptions> {
      const entry = entryOf(writeOptions);
      ptyBufferOf(entry, writeOptions.channelId);
      sendTo(entry, dataFrame(Number(writeOptions.channelId), fromBase64(writeOptions.dataBase64)));
      return {
        connectionId: entry.ref.connectionId,
        generationId: entry.ref.generationId,
        channelId: writeOptions.channelId,
        requestId: writeOptions.requestId,
        sequence: writeOptions.sequence,
      };
    },

    async resizePty(resizeOptions: SshPtyResizeOptions): Promise<SshPtyOperationOptions> {
      const entry = entryOf(resizeOptions);
      ptyBufferOf(entry, resizeOptions.channelId);
      sendTo(
        entry,
        control('resize', {
          ch: Number(resizeOptions.channelId),
          cols: resizeOptions.cols,
          rows: resizeOptions.rows,
        }),
      );
      return {
        connectionId: entry.ref.connectionId,
        generationId: entry.ref.generationId,
        channelId: resizeOptions.channelId,
        requestId: resizeOptions.requestId,
        sequence: resizeOptions.sequence,
      };
    },

    async closePty(ref: SshPtyRef & { requestId: string }): Promise<SshAck> {
      const entry = entryOf(ref);
      const buffer = entry.ptys.get(Number(ref.channelId));
      if (buffer !== undefined) {
        entry.ptys.delete(Number(ref.channelId));
        buffer.eof = true;
        flushPty(buffer);
        sendTo(entry, control('close', { ch: Number(ref.channelId) }));
      }
      return { requestId: ref.requestId };
    },

    async sftpList(): Promise<{ requestId: string; entries: SshSftpEntry[] }> {
      throw new SshCapabilityError('SFTP is not available over the link transport.', 'UNSUPPORTED');
    },

    async sftpRead(sftpOptions: SshSftpOptions & { maxBytes: number }) {
      throw new SshCapabilityError('SFTP is not available over the link transport.', 'UNSUPPORTED', {
        requestId: sftpOptions.requestId,
      });
    },

    async sftpWrite(sftpOptions: SshSftpWriteOptions) {
      throw new SshCapabilityError('SFTP is not available over the link transport.', 'UNSUPPORTED', {
        requestId: sftpOptions.requestId,
      });
    },

    async sftpMkdir(sftpOptions: SshSftpOptions) {
      throw new SshCapabilityError('SFTP is not available over the link transport.', 'UNSUPPORTED', {
        requestId: sftpOptions.requestId,
      });
    },

    async sftpRename(sftpOptions: SshSftpOptions & { destination: string }) {
      throw new SshCapabilityError('SFTP is not available over the link transport.', 'UNSUPPORTED', {
        requestId: sftpOptions.requestId,
      });
    },

    async sftpDelete(sftpOptions: SshSftpOptions) {
      throw new SshCapabilityError('SFTP is not available over the link transport.', 'UNSUPPORTED', {
        requestId: sftpOptions.requestId,
      });
    },

    async openPortForward(): Promise<SshPortForwardRef & { requestId: string }> {
      throw new SshCapabilityError(
        'Port forwarding is not available over the link transport.',
        'UNSUPPORTED',
      );
    },

    async closePortForward(): Promise<SshAck> {
      throw new SshCapabilityError(
        'Port forwarding is not available over the link transport.',
        'UNSUPPORTED',
      );
    },

    async resourceSnapshot(requestId: string): Promise<SshResourceSnapshot> {
      let ptys = 0;
      for (const entry of connections.values()) {
        if (entry.state === 'connected') ptys += entry.ptys.size;
      }
      return {
        requestId,
        connections: [...connections.values()].filter((entry) => entry.state === 'connected').length,
        ptys,
        sftpClients: 0,
        forwards: 0,
      };
    },
  };

  return capability;
}
