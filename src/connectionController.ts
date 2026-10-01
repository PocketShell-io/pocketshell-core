import { HostCliCore } from './hostCliCore';
import { HostCliFailed, type HostCliExecOutcome, type HostCliTransport } from './hostCliCommon';
import { bytesToBase64 as encodeBase64 } from './knownHostsCore';
import {
  acceptedHostKeyPin,
  verifyHostKeyTrustPin,
  type HostKeyTrustPin,
  type PresentedHostKey,
} from './hostKeyTrustCore';
import type { SessionListError, SessionRow, SessionsListing } from './hostCliSessions';
import {
  isValidSshKeyHandleCredential,
  readSshCapabilityError,
  type SshCapability,
  type SshConnectionRef,
  type SshCancellationTarget,
  type SshConnectionStateEvent,
  type SshHostTarget,
  type SshListenerHandle,
  type SshPtyRef,
  type SshResourceSnapshot,
} from './sshCapability';

export type ConnectionPhase =
  | 'idle'
  | 'connecting'
  | 'awaiting-trust'
  | 'connected'
  | 'listing'
  | 'attaching'
  | 'live'
  | 'background'
  | 'reconnecting'
  | 'lost'
  | 'error';

export interface HostKeyTrustStore {
  get(hostId: string): Promise<HostKeyTrustPin | null>;
  record(hostId: string, pin: HostKeyTrustPin): Promise<void>;
}

export interface PendingHostKeyDecision {
  hostId: string;
  hostLabel: string;
  reason: 'unknown' | 'mismatch';
  presented: PresentedHostKey;
  previouslyTrusted: HostKeyTrustPin | null;
}

export interface UncertainMutation {
  kind: 'create-session' | 'kill-session';
  target: string;
  state: 'unknown' | 'observed-applied';
  recordedAt: number;
}

export interface ConnectionSnapshot {
  revision: number;
  phase: ConnectionPhase;
  hostId: string | null;
  hostLabel: string | null;
  connectionId: string | null;
  generationId: string | null;
  sessions: SessionRow[];
  /**
   * The host's `errors[]` from the last successful session listing. Non-empty
   * means the host could not read part of its session state, so `sessions`
   * may be incomplete — an empty list next to errors is NOT "no sessions".
   */
  sessionListErrors: SessionListError[];
  /**
   * The session the consumer last attached or re-selected (its focused
   * terminal). Other attached sessions keep their PTYs: see `terminals`.
   */
  selectedSession: SessionRow | null;
  /**
   * Every session that holds a PTY on this connection, in attach order —
   * including one being re-attached by a reconnect. A session leaves this
   * list only when it is detached, ends, or no longer exists after a
   * reconnect (#2955).
   */
  terminals: SessionRow[];
  retryAttempt: number;
  error: string | null;
  trustDecision: PendingHostKeyDecision | null;
  uncertainMutation: UncertainMutation | null;
}

export type TerminalOutputHandler = (
  session: SessionRow,
  bytes: Uint8Array,
  generationId: string,
) => void | Promise<void>;

export interface ConnectionControllerOptions {
  capability: SshCapability;
  trustStore: HostKeyTrustStore;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
  createId?: () => string;
  retryDelaysMs?: readonly number[];
  /**
   * Longest background grace a caller may request. Defaults to
   * {@link DEFAULT_MAX_BACKGROUND_GRACE_MS}, the longest window the 0.5.x
   * Android client offered; a longer request is clamped to it.
   */
  maxBackgroundGraceMs?: number;
  /**
   * Most PTYs open at once on the connection. Defaults to the capability's
   * `maxChannelsPerConnection` minus {@link PTY_CHANNEL_RESERVE} (exec,
   * listing and forward headroom), or {@link DEFAULT_MAX_OPEN_PTYS} when the
   * platform states no budget. Past it the least recently focused terminal
   * is evicted (#2955).
   */
  maxOpenPtys?: number;
}

/** How `returnToForeground` treats a connection the grace window spent. */
export interface ReturnToForegroundOptions {
  /**
   * Reconnect and reattach every open terminal automatically (the default).
   * `false` is the user's "Reconnect when I return: off" choice: the spent
   * connection is released and the controller waits in `lost` for an explicit
   * {@link ConnectionController.reconnect}. A connection still live inside
   * grace is reused either way — nothing was lost.
   */
  reconnect?: boolean;
}

export type ConnectionActionResult<T = undefined> =
  | { ok: true; value: T }
  | { ok: false; reason: 'trust-required' | 'trust-mismatch' | 'not-connected' | 'not-found' | 'superseded' | 'failed'; message: string };

const DEFAULT_RETRY_DELAYS_MS = [0, 250, 500, 1_000, 2_000] as const;
/** PTYs open at once when neither the caller nor the platform states a channel budget. */
export const DEFAULT_MAX_OPEN_PTYS = 5;
/** Channels kept free of PTYs for host-CLI execs (listing, usage, bootstrap) and forwards. */
export const PTY_CHANNEL_RESERVE = 3;
/** Ten minutes: the longest background grace any PocketShell client offers. */
export const DEFAULT_MAX_BACKGROUND_GRACE_MS = 10 * 60_000;
/** Phases in which a connection still serves the user; `reconnect()` leaves them alone. */
const USABLE_PHASES: ReadonlySet<ConnectionPhase> = new Set(['connected', 'listing', 'attaching', 'live']);
/** How many times a PTY EOF asks the transport whether it is still up before calling the answer unknown. */
const EOF_PROBE_ATTEMPTS = 3;
const EOF_PROBE_RETRY_MS = 250;

/** The status line a user sees after declining automatic reconnect on return. */
export const RECONNECT_DECLINED_MESSAGE = 'The connection closed while PocketShell was in the background. Reconnect to resume.';
const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
const PTY_READ_WAIT_MS = 250;
const PTY_READ_MAX_BYTES = 32_768;
const DEFAULT_TERMINAL_GEOMETRY = { cols: 80, rows: 24 } as const;

/** The terminal size a PTY is opened at. */
export interface TerminalGeometry {
  cols: number;
  rows: number;
}

function validGeometry(geometry: TerminalGeometry | undefined): TerminalGeometry | null {
  if (!geometry) return null;
  const { cols, rows } = geometry;
  return Number.isInteger(cols) && Number.isInteger(rows) && cols >= 1 && rows >= 1 && cols <= 1000 && rows <= 1000
    ? { cols, rows }
    : null;
}

function defaultId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sameSession(left: SessionRow, right: SessionRow): boolean {
  if (left.id && right.id) return left.id === right.id;
  return left.name === right.name && left.workspace === right.workspace;
}

/**
 * One attached session's PTY. Each terminal owns its read sequence, its
 * write/resize sequence and queue, and its output pump, so attaching,
 * detaching, failing or ending one never touches another (#2955).
 */
interface TerminalRecord {
  session: SessionRow;
  pty: SshPtyRef | null;
  /** The size this terminal's consumer last asked for; its (re)attach opens at it. */
  geometry: TerminalGeometry;
  readSequence: number;
  operationSequence: number;
  operationQueue: Promise<void>;
  /** Bumped to stop this terminal's pump; a pump only acts while its token is current. */
  pumpToken: number;
  /** Bumped by every (re)attach and by detach; a stale attach closes what it opened. */
  attachToken: number;
  /** When the consumer last attached or focused it; the smallest is evicted first. */
  focusedAt: number;
  /** A consumer attach in flight: a second attach of the same session joins it. */
  attaching: Promise<ConnectionActionResult<SessionRow>> | null;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  return encodeBase64(bytes);
}

function isUncertainMutation(error: unknown): boolean {
  if (error instanceof HostCliFailed) return error.exitCode === null || error.timedOut;
  return ['CONNECTION_LOST', 'CONNECTION_CLOSED', 'CHANNEL_CLOSED', 'SSH_IO', 'EXEC_TIMEOUT']
    .includes(readSshCapabilityError(error).code);
}

function isRetryableDialError(error: unknown): boolean {
  const nativeError = readSshCapabilityError(error);
  return !['AUTH_FAILED', 'HOST_KEY_REJECTED', 'INVALID_ARGUMENT'].includes(nativeError.code);
}

/**
 * Owns one active host connection and the selected remote session.
 *
 * The Android plugin reports transport state and moves bytes only. Host CLI
 * operations, host-key verdicts, session selection, reconnect, and grace
 * decisions stay here so Android cannot grow a second policy path.
 */
export class ConnectionController {
  private readonly capability: SshCapability;
  private readonly trustStore: HostKeyTrustStore;
  private readonly now: () => number;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly createId: () => string;
  private readonly retryDelaysMs: readonly number[];
  private readonly maxBackgroundGraceMs: number;
  private readonly maxOpenPtys: number;
  private focusClock = 0;
  private readonly listeners = new Set<(snapshot: ConnectionSnapshot) => void>();
  private readonly outputListeners = new Set<TerminalOutputHandler>();
  private readonly listenerReady: Promise<SshListenerHandle>;

  private snapshot: ConnectionSnapshot = {
    revision: 0,
    phase: 'idle',
    hostId: null,
    hostLabel: null,
    connectionId: null,
    generationId: null,
    sessions: [],
    sessionListErrors: [],
    selectedSession: null,
    terminals: [],
    retryAttempt: 0,
    error: null,
    trustDecision: null,
    uncertainMutation: null,
  };
  private host: SshHostTarget | null = null;
  private connection: SshConnectionRef | null = null;
  private hostCli: HostCliCore | null = null;
  /** One PTY per attached session, in attach order (#2955). */
  private readonly terminals: TerminalRecord[] = [];
  /** The size a consumer last asked for; a new terminal with no size of its own opens at it. */
  private terminalGeometry: TerminalGeometry = { ...DEFAULT_TERMINAL_GEOMETRY };
  private graceDeadlineEpochMs: number | null = null;
  private reconnectTask: Promise<void> | null = null;
  private disposed = false;
  private lastDialRetryable = true;
  private connectIntent = 0;
  private pendingConnectRequestId: string | null = null;
  /**
   * A first-contact key the user trusted for this controller's lifetime only
   * ("accept once"). It answers this controller's own re-dials (reconnect,
   * grace resume) without ever reaching the persistent trust store, so the
   * next controller — the next app launch or a fresh connection — asks again.
   */
  private onceTrusted: { hostId: string; pin: HostKeyTrustPin } | null = null;

  constructor(options: ConnectionControllerOptions) {
    this.capability = options.capability;
    this.trustStore = options.trustStore;
    this.now = options.now ?? Date.now;
    this.delay = options.delay ?? sleep;
    this.createId = options.createId ?? defaultId;
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const cap = options.maxBackgroundGraceMs ?? DEFAULT_MAX_BACKGROUND_GRACE_MS;
    this.maxBackgroundGraceMs = Number.isFinite(cap) && cap >= 0 ? cap : DEFAULT_MAX_BACKGROUND_GRACE_MS;
    this.maxOpenPtys = resolveMaxOpenPtys(options.maxOpenPtys, this.capability.maxChannelsPerConnection);
    this.listenerReady = this.capability.addListener('connectionState', (event) => {
      this.onConnectionState(event);
    });
  }

  getSnapshot(): ConnectionSnapshot {
    return {
      ...this.snapshot,
      sessions: [...this.snapshot.sessions],
      sessionListErrors: [...this.snapshot.sessionListErrors],
      terminals: [...this.snapshot.terminals],
    };
  }

  subscribe(listener: (snapshot: ConnectionSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  subscribeTerminalOutput(listener: TerminalOutputHandler): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  async connect(host: SshHostTarget): Promise<ConnectionActionResult<SshConnectionRef>> {
    this.assertLive();
    const credential: unknown = host.credential;
    if (isKeyHandleCredential(credential) && !isValidSshKeyHandleCredential(credential)) {
      return {
        ok: false,
        reason: 'failed',
        message: 'SSH key handle must have a non-empty handle ID and an optional string passphrase.',
      };
    }
    const intent = ++this.connectIntent;
    const requestId = this.createId();
    this.pendingConnectRequestId = requestId;
    try {
      await this.listenerReady;
      if (!this.isCurrentConnect(intent)) return this.cancelledConnectResult();
      if (this.connection && this.host?.hostId === host.hostId) {
        try {
          const stateRequestId = this.createId();
          const status = await this.capability.getConnectionState({ ...this.connection, requestId: stateRequestId });
          if (!this.isCurrentConnect(intent)) return this.cancelledConnectResult();
          if (status.requestId !== stateRequestId) throw new Error('SSH state returned a stale request.');
          if (status.state === 'connected') return { ok: true, value: this.connection };
        } catch {
          // A missing native handle is the same as a spent transport here.
        }
      }

      // A fresh dial is a new host context: no terminal survives it.
      await this.closeAllTerminals();
      await this.closeCurrentTransport();
      if (!this.isCurrentConnect(intent)) return this.cancelledConnectResult();
      this.host = hostWithoutTransientPassphrase(host);
      this.setSnapshot({
        phase: 'connecting',
        hostId: host.hostId,
        hostLabel: host.hostname,
        connectionId: null,
        generationId: null,
        sessions: [],
        sessionListErrors: [],
        selectedSession: null,
        retryAttempt: 0,
        error: null,
        trustDecision: null,
        uncertainMutation: null,
      });
      const result = await this.dial(host, intent, requestId);
      if (!this.isCurrentConnect(intent)) return this.cancelledConnectResult();
      if (result.ok) {
        this.setSnapshot({ phase: 'connected', connectionId: result.value.connectionId, generationId: result.value.generationId });
      }
      return result;
    } finally {
      if (this.pendingConnectRequestId === requestId) this.pendingConnectRequestId = null;
    }
  }

  /**
   * Trust the key the host presented and dial again.
   *
   * `persist: false` is "accept once": the key is trusted for this
   * controller's lifetime (its own re-dials included) and never written to the
   * trust store. It only applies to a first contact — a CHANGED key is never
   * trusted transiently, because the stored pin would refuse it again on the
   * very next dial.
   */
  async acceptPresentedHostKey(
    options: { passphrase?: string | null; persist?: boolean } = {},
  ): Promise<ConnectionActionResult<SshConnectionRef>> {
    const pending = this.snapshot.trustDecision;
    const host = this.host;
    if (!pending || !host) return { ok: false, reason: 'failed', message: 'There is no pending host-key decision.' };
    const persist = options.persist ?? true;
    if (!persist && pending.reason !== 'unknown') {
      return {
        ok: false,
        reason: 'trust-mismatch',
        message: 'A changed host key cannot be trusted for one connection only.',
      };
    }
    const retryHost = hostWithTransientPassphrase(host, options.passphrase);
    if (isKeyHandleCredential(retryHost.credential) && !isValidSshKeyHandleCredential(retryHost.credential)) {
      return {
        ok: false,
        reason: 'failed',
        message: 'SSH key handle must have a non-empty handle ID and an optional string passphrase.',
      };
    }
    const accepted = acceptedHostKeyPin(pending.previouslyTrusted, pending.presented);
    if (persist) await this.trustStore.record(host.hostId, accepted);
    else this.onceTrusted = { hostId: host.hostId, pin: accepted };
    this.setSnapshot({ trustDecision: null, phase: 'connecting', error: null });
    return this.connect(retryHost);
  }

  async refreshSessions(): Promise<ConnectionActionResult<SessionsListing>> {
    const cli = this.hostCli;
    const connection = this.connection;
    if (!cli || !connection) {
      return { ok: false, reason: 'not-connected', message: 'Connect to a host before listing sessions.' };
    }
    this.setSnapshot({ phase: this.snapshot.phase === 'live' ? 'live' : 'listing', error: null });
    try {
      const listing = await cli.listSessions();
      this.setSnapshot({ sessions: listing.sessions, sessionListErrors: listing.errors });
      this.reconcilePendingMutation(listing);
      return { ok: true, value: listing };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A list that fails on a transport the controller has already replaced
      // (a reconnect or grace expiry is in progress) is stale: it must not
      // rewrite the phase that transition owns or start another reconnect.
      if (!this.isCurrentGeneration(connection)) return { ok: false, reason: 'failed', message };
      if (isUncertainMutation(error) || this.isCurrentTransportFailure(error)) {
        this.startReconnect('session list lost its transport');
      }
      const phase = this.snapshot.phase === 'reconnecting'
        ? 'reconnecting'
        : this.hasLiveTerminal() ? 'live' : 'error';
      this.setSnapshot({ error: message, phase });
      return { ok: false, reason: 'failed', message };
    }
  }

  async createSession(
    name: string,
    options: { cwd?: string | null; engine?: string | null; profile?: string | null } = {},
  ): Promise<ConnectionActionResult<{ name: string; id: string | null; created: boolean }>> {
    const cli = this.hostCli;
    if (!cli) return { ok: false, reason: 'not-connected', message: 'Connect to a host before creating a session.' };
    try {
      const created = await cli.createSession(name, options);
      const listing = await cli.listSessions();
      this.setSnapshot({ sessions: listing.sessions, sessionListErrors: listing.errors });
      return { ok: true, value: created };
    } catch (error) {
      if (isUncertainMutation(error)) {
        this.recordUncertainMutation({ kind: 'create-session', target: name });
        if (this.isCurrentTransportFailure(error)) this.startReconnect('create result was lost');
        else await this.reconcileUncertainMutation();
        return {
          ok: false,
          reason: 'failed',
          message: `The host may have created session “${name}”, but the result was lost. Refresh sessions before deciding what to do next.`,
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: 'failed', message };
    }
  }

  async killSession(name: string): Promise<ConnectionActionResult> {
    const cli = this.hostCli;
    if (!cli) return { ok: false, reason: 'not-connected', message: 'Connect to a host before stopping a session.' };
    try {
      await cli.killSession(name);
      const listing = await cli.listSessions();
      this.setSnapshot({ sessions: listing.sessions, sessionListErrors: listing.errors });
      return { ok: true, value: undefined };
    } catch (error) {
      if (isUncertainMutation(error)) {
        this.recordUncertainMutation({ kind: 'kill-session', target: name });
        if (this.isCurrentTransportFailure(error)) this.startReconnect('kill result was lost');
        else await this.reconcileUncertainMutation();
        return {
          ok: false,
          reason: 'failed',
          message: `The host may have stopped session “${name}”, but the result was lost. Refresh sessions before deciding what to do next.`,
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: 'failed', message };
    }
  }

  /**
   * Attach `session` on a PTY of its own and make it the selected (focused)
   * terminal. Other attached sessions keep their PTYs, output and scrollback:
   * attaching one tab never closes another (#2955). Attaching a session that
   * is already live only re-selects it — no second attach, no repaint.
   *
   * `geometry` is the consumer's terminal size: the PTY is OPENED at it, so
   * aplexer renders its attach snapshot (the repaint of the session's live
   * screen) at the size the user sees, instead of at 80x24 followed by a
   * resize the workload may never answer (#2936). A reconnect re-attaches
   * each terminal at its own last known size.
   */
  async attachSession(
    session: SessionRow,
    geometry?: TerminalGeometry,
  ): Promise<ConnectionActionResult<SessionRow>> {
    const requested = validGeometry(geometry);
    if (requested) this.terminalGeometry = requested;
    const hostCli = this.hostCli;
    const connection = this.connection;
    if (!hostCli || !connection || !this.host) {
      return { ok: false, reason: 'not-connected', message: 'Connect to a host before attaching a session.' };
    }
    const listed = this.snapshot.sessions.find((row) => sameSession(row, session));
    if (!listed) return { ok: false, reason: 'not-found', message: `Session “${session.name}” is no longer in the host list.` };

    let record = this.findTerminal(listed);
    if (record) record.focusedAt = ++this.focusClock;
    if (record?.attaching) return record.attaching;
    if (record?.pty && record.pty.generationId === connection.generationId) {
      if (requested) record.geometry = requested;
      this.setSnapshot({ selectedSession: record.session });
      return { ok: true, value: record.session };
    }
    if (!record) {
      // The channel budget: a new terminal past the bound evicts the least
      // recently focused one. Its host session stays; its consumer sees the
      // terminal leave and re-attaches when it is next looked at.
      while (this.terminals.length >= this.maxOpenPtys) {
        const evicted = this.leastRecentlyFocused();
        if (!evicted) break;
        const pty = this.removeTerminal(evicted);
        if (pty) void this.closePtyRef(pty);
      }
      record = {
        session: listed,
        pty: null,
        geometry: requested ?? { ...this.terminalGeometry },
        readSequence: 0,
        operationSequence: 0,
        operationQueue: Promise.resolve(),
        pumpToken: 0,
        attachToken: 0,
        focusedAt: ++this.focusClock,
        attaching: null,
      };
      this.terminals.push(record);
    } else {
      record.session = listed;
      if (requested) record.geometry = requested;
    }
    const terminal = record;
    const attaching = this.openTerminal(terminal, connection, hostCli, 'consumer').finally(() => {
      if (terminal.attaching === attaching) terminal.attaching = null;
    });
    terminal.attaching = attaching;
    return attaching;
  }

  /**
   * Close `session`'s PTY and keep the connection and every other terminal.
   * The consumer is gone (a closed tab, a left workspace); the next
   * `attachSession` of it opens a fresh attach, whose aplexer snapshot
   * repaints the screen. A reconnect — including one already running —
   * re-attaches only the terminals still open (#2936, #2955).
   */
  async detachSession(session: SessionRow): Promise<void> {
    const record = this.findTerminal(session);
    if (!record) return;
    const pty = this.removeTerminal(record);
    if (!this.disposed && this.connection && this.snapshot.phase !== 'reconnecting' && this.snapshot.phase !== 'background') {
      // A failure another attach reported stays visible until a live terminal replaces it.
      if (this.snapshot.phase === 'error' && !this.hasLiveTerminal()) this.setSnapshot({});
      else this.setSnapshot({ phase: this.idlePhase(), error: null });
    } else {
      this.setSnapshot({});
    }
    if (pty) await this.closePtyRef(pty);
  }

  /**
   * Run one host command over the current transport generation.
   *
   * A platform adapter that exposes a generic exec (the shared app's
   * `ssh.exec`, bootstrap and usage probes) goes through here rather than
   * the raw capability, so the controller stays the one owner of the
   * connection generation and a transport failure observed by the command
   * starts the same reconnect path as every other operation (#2936, D28).
   * A non-zero exit is a result, not a failure.
   */
  async runHostCommand(
    command: string,
    timeoutMs: number,
  ): Promise<ConnectionActionResult<HostCliExecOutcome>> {
    const connection = this.connection;
    if (!connection) {
      return { ok: false, reason: 'not-connected', message: 'Connect to a host before running a command.' };
    }
    try {
      const outcome = await this.createHostCliTransport(connection).exec(command, timeoutMs);
      return { ok: true, value: outcome };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (connection === this.connection && this.isCurrentTransportFailure(error)) {
        this.startReconnect('host command observed a transport failure');
      }
      return { ok: false, reason: 'failed', message };
    }
  }

  /** How many dials one recovery ladder makes before the controller gives up (`lost`). */
  get maxReconnectAttempts(): number {
    return this.retryDelaysMs.length;
  }

  /**
   * Explicitly resume a host connection: the user's Retry after the ladder
   * gave up, or after a declined automatic reconnect on return from the
   * background (`returnToForeground({ reconnect: false })`). The one
   * reconnect entry point (#2954, D28 — one reconnect owner):
   *
   * - A ladder already running is joined, never doubled: a Retry pressed
   *   while the controller is re-dialling waits for that recovery.
   * - A still-usable connection (connected, listing, attaching, live) is
   *   left alone.
   * - Otherwise it runs ONE fresh ladder with the full budget, re-attaching
   *   every terminal still open.
   *
   * Background grace is not a Retry target: foreground reconciliation owns
   * that transport (`returnToForeground`).
   */
  async reconnect(): Promise<ConnectionActionResult> {
    this.assertLive();
    if (!this.host) {
      return { ok: false, reason: 'not-connected', message: 'There is no host to reconnect to.' };
    }
    const running = this.reconnectTask;
    const usable = this.connection !== null && USABLE_PHASES.has(this.snapshot.phase);
    if (running) {
      await running;
    } else if (this.snapshot.phase === 'background') {
      return { ok: false, reason: 'failed', message: 'The connection is in background grace; it reconnects on return.' };
    } else if (!usable) {
      await this.reconnectAndAttach('reconnect requested');
    }
    const phase = this.snapshot.phase;
    if (this.connection && phase !== 'lost' && phase !== 'reconnecting') return { ok: true, value: undefined };
    return { ok: false, reason: 'failed', message: this.snapshot.error ?? 'Reconnect failed.' };
  }

  async enterBackground(graceMs: number): Promise<void> {
    this.assertLive();
    if (!this.connection) return;
    const requested = Number.isFinite(graceMs) ? graceMs : 0;
    const grace = Math.max(0, Math.min(requested, this.maxBackgroundGraceMs));
    const deadlineEpochMs = this.now() + grace;
    this.graceDeadlineEpochMs = deadlineEpochMs;
    const requestId = this.createId();
    const result = await this.capability.scheduleClose({
      ...this.connection,
      requestId,
      deadlineEpochMs,
    });
    if (result.requestId !== requestId) throw new Error('SSH grace schedule returned a stale request.');
    this.setSnapshot({ phase: 'background', error: null });
  }

  async returnToForeground(options: ReturnToForegroundOptions = {}): Promise<void> {
    this.assertLive();
    const reconnect = options.reconnect ?? true;
    const connection = this.connection;
    const host = this.host;
    const deadline = this.graceDeadlineEpochMs;
    this.graceDeadlineEpochMs = null;
    if (!host || deadline === null) return;
    if (!connection || this.now() >= deadline) {
      if (reconnect) await this.reconnectAndAttach('background grace expired');
      else await this.releaseSpentConnection();
      return;
    }

    try {
      const cancelRequestId = this.createId();
      const cancelled = await this.capability.cancelScheduledClose({ ...connection, requestId: cancelRequestId });
      if (cancelled.requestId !== cancelRequestId) throw new Error('SSH grace cancel returned a stale request.');
      const stateRequestId = this.createId();
      const status = await this.capability.getConnectionState({ ...connection, requestId: stateRequestId });
      if (status.requestId !== stateRequestId) throw new Error('SSH state returned a stale request.');
      if (cancelled.cancelled && status.state === 'connected') {
        // The transport survived; a terminal whose PTY closed meanwhile
        // ended on the host and is gone, not something to re-attach.
        for (const record of [...this.terminals]) {
          if (!record.pty && !record.attaching) this.removeTerminal(record);
        }
        this.setSnapshot({ phase: this.idlePhase(), error: null, retryAttempt: 0 });
        return;
      }
    } catch {
      // A deadline racing resume or a dead connection is handled by the same
      // TypeScript reconnect path below.
    }
    if (reconnect) await this.reconnectAndAttach('connection was spent during background grace');
    else await this.releaseSpentConnection();
  }

  /**
   * Release a grace-spent transport without dialing, and wait for
   * {@link reconnect}. The terminals stay open: the explicit reconnect
   * re-attaches every one of them (#2955).
   */
  private async releaseSpentConnection(): Promise<void> {
    const oldPtys = this.detachTerminalsFromTransport();
    const oldConnection = this.connection;
    this.connection = null;
    this.hostCli = null;
    this.connectIntent += 1;
    for (const oldPty of oldPtys) await this.capability.closePty({ ...oldPty, requestId: this.createId() }).catch(() => undefined);
    if (oldConnection) {
      await this.cancelCapability({ kind: 'connection', ...oldConnection });
      await this.capability.closeConnection({ ...oldConnection, requestId: this.createId() }).catch(() => undefined);
    }
    this.setSnapshot({ phase: 'lost', connectionId: null, generationId: null, retryAttempt: 0, error: RECONNECT_DECLINED_MESSAGE });
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.connectIntent += 1;
    const pendingConnectRequestId = this.pendingConnectRequestId;
    this.pendingConnectRequestId = null;
    if (pendingConnectRequestId) {
      await this.cancelCapability({ kind: 'connect', targetRequestId: pendingConnectRequestId });
    }
    await this.closeAllTerminals();
    await this.closeCurrentTransport();
    this.host = null;
    this.graceDeadlineEpochMs = null;
    this.setSnapshot({
      phase: 'idle',
      hostId: null,
      hostLabel: null,
      connectionId: null,
      generationId: null,
      sessions: [],
      sessionListErrors: [],
      selectedSession: null,
      retryAttempt: 0,
      error: null,
      trustDecision: null,
      uncertainMutation: null,
    });
    await this.removeStateListener().catch(() => undefined);
  }

  /**
   * Send keystrokes to `session`'s own PTY. Writes to one terminal are
   * sequenced and queued per terminal, so they never interleave with — or
   * wait behind — another terminal's (#2955).
   */
  async writeTerminalBytes(
    session: SessionRow,
    bytes: Uint8Array,
  ): Promise<ConnectionActionResult<{ sequence: number }>> {
    const record = this.findTerminal(session);
    if (!record) {
      return { ok: false, reason: 'not-connected', message: 'Attach a session before sending terminal input.' };
    }
    const selectedPty = record.pty;
    return this.withTerminalOperation(record, async () => {
      const pty = record.pty;
      if (pty?.channelId !== selectedPty?.channelId) {
        return { ok: false, reason: 'superseded', message: 'The session PTY changed before terminal input was sent.' };
      }
      if (!pty || !this.terminals.includes(record) || this.snapshot.phase !== 'live') {
        return { ok: false, reason: 'not-connected', message: 'Attach a session before sending terminal input.' };
      }
      if (bytes.length === 0) return { ok: true, value: { sequence: record.operationSequence } };
      const sequence = ++record.operationSequence;
      const requestId = this.createId();
      try {
        const result = await this.capability.writePty({
          ...pty,
          requestId,
          sequence,
          dataBase64: bytesToBase64(bytes),
        });
        if (result.requestId !== requestId || result.sequence !== sequence || result.channelId !== pty.channelId) {
          throw new Error('PTY write returned a stale operation.');
        }
        return { ok: true, value: { sequence } };
      } catch (error) {
        if (record.pty?.channelId !== pty.channelId) {
          return { ok: false, reason: 'superseded', message: 'The session PTY changed while terminal input was sent.' };
        }
        const message = error instanceof Error ? error.message : String(error);
        // Detach the PTY and start any reconnect before awaiting its native
        // close: a reconnect that starts while the close is in flight must not
        // be overwritten by this stale failure afterwards (#2943).
        const closed = this.abandonPty(record, pty);
        this.setSnapshot({ phase: this.hasLiveTerminal() ? 'live' : 'error', error: message });
        if (this.isCurrentTransportFailure(error) || readSshCapabilityError(error).code === 'OPERATION_UNCERTAIN') {
          this.startReconnect('terminal input result was uncertain');
        }
        await closed;
        return { ok: false, reason: 'failed', message };
      }
    });
  }

  /** Resize `session`'s own PTY; queued behind that terminal's writes only. */
  async resizeTerminal(
    session: SessionRow,
    cols: number,
    rows: number,
  ): Promise<ConnectionActionResult<{ sequence: number }>> {
    const record = this.findTerminal(session);
    if (!record) {
      return { ok: false, reason: 'not-connected', message: 'Attach a session before resizing the terminal.' };
    }
    const selectedPty = record.pty;
    return this.withTerminalOperation(record, async () => {
      const pty = record.pty;
      if (pty?.channelId !== selectedPty?.channelId) {
        return { ok: false, reason: 'superseded', message: 'The session PTY changed before terminal resize.' };
      }
      if (!pty || !this.terminals.includes(record) || this.snapshot.phase !== 'live') {
        return { ok: false, reason: 'not-connected', message: 'Attach a session before resizing the terminal.' };
      }
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 1000 || rows > 1000) {
        return { ok: false, reason: 'failed', message: 'Terminal dimensions must be between 1 and 1000.' };
      }
      const sequence = ++record.operationSequence;
      const requestId = this.createId();
      try {
        const result = await this.capability.resizePty({ ...pty, requestId, sequence, cols, rows });
        if (result.requestId !== requestId || result.sequence !== sequence || result.channelId !== pty.channelId) {
          throw new Error('PTY resize returned a stale operation.');
        }
        record.geometry = { cols, rows };
        this.terminalGeometry = { cols, rows };
        return { ok: true, value: { sequence } };
      } catch (error) {
        if (record.pty?.channelId !== pty.channelId) {
          return { ok: false, reason: 'superseded', message: 'The session PTY changed while terminal resize ran.' };
        }
        const message = error instanceof Error ? error.message : String(error);
        // See writeTerminalBytes: never report this failure after awaiting the close.
        const closed = this.abandonPty(record, pty);
        this.setSnapshot({ phase: this.hasLiveTerminal() ? 'live' : 'error', error: message });
        if (this.isCurrentTransportFailure(error)) this.startReconnect('terminal resize observed a transport failure');
        await closed;
        return { ok: false, reason: 'failed', message };
      }
    });
  }

  async removeStateListener(): Promise<void> {
    const handle = await this.listenerReady;
    await handle.remove();
  }

  async getResourceSnapshot(): Promise<SshResourceSnapshot> {
    const requestId = this.createId();
    const result = await this.capability.resourceSnapshot(requestId);
    if (result.requestId !== requestId) throw new Error('SSH resource snapshot returned a stale request.');
    return result;
  }

  clearUncertainMutation(): void {
    this.setSnapshot({ uncertainMutation: null });
  }

  private async dial(
    host: SshHostTarget,
    intent: number,
    requestId: string,
  ): Promise<ConnectionActionResult<SshConnectionRef>> {
    const generationId = this.createId();
    let expectedHostKey: HostKeyTrustPin | null = null;
    // Each dial judges itself: a refusal from an earlier ladder must not
    // colour this one's give-up message.
    this.lastDialRetryable = true;
    this.setSnapshot({ phase: 'connecting', generationId, error: null });
    try {
      expectedHostKey = (await this.trustStore.get(host.hostId))
        ?? (this.onceTrusted?.hostId === host.hostId ? this.onceTrusted.pin : null);
      if (!this.isCurrentConnect(intent)) return this.cancelledConnectResult();
      const connected = await this.capability.connect({
        ...host,
        requestId,
        generationId,
        expectedHostKey,
        connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
      });
      if (!this.isCurrentConnect(intent)) {
        await this.closeReturnedConnection(connected);
        return this.cancelledConnectResult();
      }
      if (connected.requestId !== requestId || connected.generationId !== generationId) {
        await this.closeReturnedConnection(connected);
        return { ok: false, reason: 'failed', message: 'SSH connect returned a stale generation.' };
      }
      const presented = this.readPresentedKey(connected.hostKey as unknown as Record<string, unknown>);
      if (!presented) {
        await this.closeReturnedConnection(connected);
        throw new Error('SSH connect returned an invalid host key.');
      }
      const verdict = verifyHostKeyTrustPin(expectedHostKey, presented);
      if (verdict !== 'trusted') {
        await this.closeReturnedConnection(connected);
        if (!this.isCurrentConnect(intent)) return this.cancelledConnectResult();
        return this.presentHostKeyDecision(host, generationId, expectedHostKey, presented, verdict);
      }
      this.connection = { connectionId: connected.connectionId, generationId };
      this.hostCli = new HostCliCore(this.createHostCliTransport(this.connection));
      this.setSnapshot({
        phase: 'connected',
        connectionId: connected.connectionId,
        generationId,
        trustDecision: null,
        error: null,
      });
      return { ok: true, value: this.connection };
    } catch (error) {
      if (!this.isCurrentConnect(intent)) return this.cancelledConnectResult();
      const sshError = readSshCapabilityError(error);
      this.lastDialRetryable = isRetryableDialError(error);
      const presented = this.readPresentedKey(sshError.data);
      if (sshError.code === 'HOST_KEY_REJECTED' && presented) {
        const verdict = verifyHostKeyTrustPin(expectedHostKey, presented);
        if (verdict !== 'trusted') {
          return this.presentHostKeyDecision(host, generationId, expectedHostKey, presented, verdict);
        }
      }
      const message = sshError.message;
      this.setSnapshot({ phase: 'error', error: message, generationId, trustDecision: null });
      return { ok: false, reason: 'failed', message };
    }
  }

  private presentHostKeyDecision(
    host: SshHostTarget,
    generationId: string,
    previouslyTrusted: HostKeyTrustPin | null,
    presented: PresentedHostKey,
    verdict: 'unknown' | 'mismatch',
  ): ConnectionActionResult<SshConnectionRef> {
    const reason = verdict === 'mismatch' ? 'mismatch' : 'unknown';
    const message = reason === 'unknown'
      ? `First connection to ${host.hostname}; verify ${presented.fingerprintSha256} before trusting it.`
      : `The host key for ${host.hostname} changed. The new fingerprint is ${presented.fingerprintSha256}.`;
    this.setSnapshot({
      phase: 'awaiting-trust',
      generationId,
      trustDecision: {
        hostId: host.hostId,
        hostLabel: host.hostname,
        reason,
        presented,
        previouslyTrusted,
      },
      error: message,
    });
    return {
      ok: false,
      reason: reason === 'mismatch' ? 'trust-mismatch' : 'trust-required',
      message,
    };
  }

  private async closeReturnedConnection(connection: SshConnectionRef): Promise<void> {
    await this.cancelCapability({
      kind: 'connection',
      connectionId: connection.connectionId,
      generationId: connection.generationId,
    });
    await this.capability.closeConnection({ ...connection, requestId: this.createId() }).catch(() => undefined);
  }

  private createHostCliTransport(connection: SshConnectionRef): HostCliTransport {
    return {
      exec: async (command, timeoutMs) => {
        const requestId = this.createId();
        const result = await this.capability.exec({
          ...connection,
          requestId,
          command,
          timeoutMs,
        });
        if (result.requestId !== requestId || result.generationId !== connection.generationId) {
          throw new Error('SSH exec returned a stale request or connection generation.');
        }
        return {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
        };
      },
    };
  }

  /**
   * Open `record`'s PTY on `connection`. `consumer` attaches publish their
   * own progress and failure (and may start a reconnect); `recovery`
   * attaches belong to the reconnect ladder, which judges the outcome.
   */
  private async openTerminal(
    record: TerminalRecord,
    connection: SshConnectionRef,
    hostCli: HostCliCore,
    mode: 'consumer' | 'recovery',
  ): Promise<ConnectionActionResult<SessionRow>> {
    const token = ++record.attachToken;
    record.pumpToken += 1;
    const previous = record.pty;
    record.pty = null;
    const session = record.session;
    if (mode === 'consumer') {
      this.setSnapshot({
        phase: this.hasLiveTerminal() ? 'live' : 'attaching',
        error: null,
        selectedSession: session,
      });
    }
    if (previous) await this.closePtyRef(previous);
    const superseded = (): boolean =>
      token !== record.attachToken || !this.terminals.includes(record) || !this.isCurrentGeneration(connection);
    if (superseded()) return { ok: false, reason: 'superseded', message: 'Session attach was superseded.' };

    try {
      const openRequestId = this.createId();
      const opened = await this.capability.openPty({
        ...connection,
        requestId: openRequestId,
        command: hostCli.buildAttachCommand(session.name),
        cols: record.geometry.cols,
        rows: record.geometry.rows,
        term: 'xterm-256color',
      });
      if (opened.requestId !== openRequestId || opened.generationId !== connection.generationId || superseded()) {
        await this.capability.closePty({ ...opened, requestId: this.createId() }).catch(() => undefined);
        return { ok: false, reason: 'superseded', message: 'A stale session attach completed after a newer one.' };
      }
      record.pty = { connectionId: opened.connectionId, generationId: opened.generationId, channelId: opened.channelId };
      record.readSequence = 0;
      record.operationSequence = 0;
      record.operationQueue = Promise.resolve();
      if (mode === 'consumer') {
        this.setSnapshot({ phase: 'live', selectedSession: session, error: null, retryAttempt: 0 });
      }
      this.startPtyPump(record);
      return { ok: true, value: session };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // An attach that fails after a reconnect replaced its transport (or
      // after a detach or newer attach of the same session) is stale.
      if (superseded()) return { ok: false, reason: 'superseded', message: 'Session attach was superseded.' };
      if (mode === 'consumer') {
        this.setSnapshot({ phase: this.hasLiveTerminal() ? 'live' : 'error', error: message });
        if (this.isCurrentTransportFailure(error)) this.startReconnect('PTY attach failed after transport loss');
      }
      return { ok: false, reason: 'failed', message };
    }
  }

  /**
   * Pump one terminal's output. Each terminal has its own pump, read
   * sequence and token, so a late read, EOF or error of one terminal — or of
   * an older transport generation of the same terminal — can never act on
   * another (#2955, #2982).
   */
  private async startPtyPump(record: TerminalRecord): Promise<void> {
    const pty = record.pty;
    if (!pty) return;
    const pumpToken = ++record.pumpToken;
    const current = (): boolean => !this.disposed && pumpToken === record.pumpToken;
    try {
      while (current() && record.pty?.channelId === pty.channelId) {
        const requestId = this.createId();
        const result = await this.capability.readPty({
          ...pty,
          requestId,
          sequence: record.readSequence,
          maxBytes: PTY_READ_MAX_BYTES,
          waitMs: PTY_READ_WAIT_MS,
        });
        if (!current()) return;
        if (result.requestId !== requestId || result.generationId !== pty.generationId || result.channelId !== pty.channelId) {
          throw new Error('PTY read returned a stale request or generation.');
        }
        if (result.sequence < record.readSequence || result.sequence > record.readSequence + 1) {
          throw new Error(`PTY output sequence gap: expected ${record.readSequence} or ${record.readSequence + 1}, received ${result.sequence}.`);
        }
        if (result.sequence === record.readSequence && result.dataBase64.length > 0) {
          throw new Error('PTY output changed bytes without advancing its sequence.');
        }
        if (result.sequence === record.readSequence + 1 && result.dataBase64.length === 0) {
          throw new Error('PTY output advanced its sequence without returning bytes.');
        }
        if (result.sequence === record.readSequence + 1) {
          const bytes = base64ToBytes(result.dataBase64);
          for (const listener of this.outputListeners) await listener(record.session, bytes, pty.generationId);
          // A reconnect, detach or re-attach can supersede this PTY while its
          // output consumers run; its EOF must not then rewrite the phase.
          if (!current()) return;
          record.readSequence = result.sequence;
        }
        if (result.eof) {
          record.pty = null;
          // A channel can report EOF just before the native grace-expired
          // event arrives. Keep the lifecycle state in the background so
          // the app still runs the foreground reconciliation path (which
          // re-attaches this terminal).
          const backgrounded = this.snapshot.phase === 'background';
          // A dying transport closes its channels first, so the EOF can
          // beat the native `lost` event. That is the link failing, not
          // the session ending: ask the transport before saying "ended",
          // and recover every terminal (#2954, D28).
          if (!backgrounded && (await this.transportLost(pty))) {
            if (current()) this.startReconnect('PTY closed because its transport was lost');
            return;
          }
          if (!current()) return;
          if (backgrounded) {
            this.setSnapshot({ phase: 'background', error: `Session “${record.session.name}” ended.` });
          } else {
            // The session ended on a healthy transport: only this terminal goes.
            this.removeTerminal(record, { keepSelection: true });
            this.setSnapshot({ phase: this.idlePhase(), error: `Session “${record.session.name}” ended.` });
          }
          await this.capability.closePty({ ...pty, requestId: this.createId() }).catch(() => undefined);
          return;
        }
      }
    } catch (error) {
      if (!current()) return;
      const message = error instanceof Error ? error.message : String(error);
      // Transport closure can reject the pending PTY read before the native
      // grace-expired event reaches this controller. Preserve background
      // until foreground decides whether to reuse or reconnect the transport.
      const backgrounded = this.snapshot.phase === 'background';
      const transportFailure = this.isCurrentTransportFailure(error);
      if (backgrounded || transportFailure) {
        // The terminal stays open: foreground or the reconnect re-attaches it.
        record.pty = null;
        record.pumpToken += 1;
        void this.closePtyRef(pty);
        this.setSnapshot({ phase: backgrounded ? 'background' : this.hasLiveTerminal() ? 'live' : 'error', error: message });
        if (transportFailure) this.startReconnect('PTY output reader observed a transport failure');
        return;
      }
      // This PTY failed on a healthy transport: it is done. The terminal
      // leaves the open set, so its consumer sees it exit and the next
      // attach of the session opens a fresh PTY; the other terminals stay.
      const failed = this.removeTerminal(record, { keepSelection: true });
      this.setSnapshot({ phase: this.hasLiveTerminal() ? 'live' : 'error', error: message });
      if (failed) await this.closePtyRef(failed);
    }
  }

  private async reconnectAndAttach(reason: string): Promise<void> {
    const task = this.reconnectTask;
    if (task) return task;
    const host = this.host;
    if (!host) return;
    const intent = ++this.connectIntent;
    this.reconnectTask = this.runReconnect(host, reason, intent).finally(() => {
      this.reconnectTask = null;
    });
    return this.reconnectTask;
  }

  private startReconnect(reason: string): void {
    if (this.snapshot.phase === 'background' || this.disposed) return;
    void this.reconnectAndAttach(reason);
  }

  /**
   * The one recovery ladder: replace the transport, then re-attach EVERY
   * open terminal exactly once on the new generation (#2955). Terminals
   * detached while it runs are not re-attached; terminals whose session no
   * longer exists are dropped.
   */
  private async runReconnect(host: SshHostTarget, reason: string, intent: number): Promise<void> {
    const oldPtys = this.detachTerminalsFromTransport();
    const oldConnection = this.connection;
    this.connection = null;
    this.hostCli = null;
    this.setSnapshot({ phase: 'reconnecting', retryAttempt: 0, error: reason, connectionId: null });
    for (const oldPty of oldPtys) await this.capability.closePty({ ...oldPty, requestId: this.createId() }).catch(() => undefined);
    if (oldConnection) {
      await this.cancelCapability({ kind: 'connection', ...oldConnection });
      await this.capability.closeConnection({ ...oldConnection, requestId: this.createId() }).catch(() => undefined);
    }
    if (!this.isCurrentConnect(intent)) return;

    for (let attempt = 0; attempt < this.retryDelaysMs.length; attempt += 1) {
      if (attempt > 0) await this.delay(this.retryDelaysMs[attempt] ?? 0);
      if (!this.isCurrentConnect(intent)) return;
      this.setSnapshot({ phase: 'reconnecting', retryAttempt: attempt + 1, error: reason });
      const requestId = this.createId();
      this.pendingConnectRequestId = requestId;
      let connected: ConnectionActionResult<SshConnectionRef>;
      try {
        connected = await this.dial(host, intent, requestId);
      } finally {
        if (this.pendingConnectRequestId === requestId) this.pendingConnectRequestId = null;
      }
      if (!this.isCurrentConnect(intent)) return;
      if (!connected.ok) {
        if (connected.reason === 'trust-required' || connected.reason === 'trust-mismatch') return;
        if (!this.lastDialRetryable) break;
        continue;
      }
      const listing = await this.refreshSessions();
      if (!this.isCurrentConnect(intent)) return;
      if (!listing.ok) {
        if (this.snapshot.phase === 'reconnecting') continue;
        return;
      }
      const outcome = await this.reattachTerminals(host, listing.value, intent);
      if (outcome === 'retry') continue;
      return;
    }
    if (this.isCurrentConnect(intent)) {
      // Name the dials actually made: a refused login (not retryable) ends
      // the ladder early, and says why.
      const attempts = this.snapshot.retryAttempt;
      const refusal = !this.lastDialRetryable ? this.snapshot.error?.trim() : '';
      const cause = refusal ? ` ${/[.!?]$/.test(refusal) ? refusal : `${refusal}.`}` : '';
      this.setSnapshot({
        phase: 'lost',
        error: `Could not reconnect to ${host.hostname} after ${attempts} attempt${attempts === 1 ? '' : 's'}.${cause}`,
      });
    }
  }

  /**
   * Re-attach every open terminal on the freshly dialled generation, each
   * exactly once. `retry` means the new transport failed under an attach:
   * its PTYs are released and the ladder dials again.
   */
  private async reattachTerminals(
    host: SshHostTarget,
    listing: SessionsListing,
    intent: number,
  ): Promise<'done' | 'retry' | 'superseded'> {
    const connection = this.connection;
    const hostCli = this.hostCli;
    if (!connection || !hostCli) return 'retry';
    const selected = this.snapshot.selectedSession;
    if (this.terminals.length === 0) {
      this.setSnapshot({ phase: 'connected', selectedSession: null, error: null, retryAttempt: 0 });
      return 'done';
    }
    const vanished: SessionRow[] = [];
    for (const record of [...this.terminals]) {
      if (!this.terminals.includes(record)) continue;
      const current = listing.sessions.find((row) => sameSession(row, record.session));
      if (!current) {
        this.removeTerminal(record);
        vanished.push(record.session);
      }
    }
    if (this.terminals.length === 0) {
      if (vanished.length === 0) {
        // Every terminal was detached while the ladder ran.
        this.setSnapshot({ phase: 'connected', selectedSession: null, error: null, retryAttempt: 0 });
        return 'done';
      }
      const gone = (selected && vanished.find((row) => sameSession(row, selected))) ?? vanished[0]!;
      this.setSnapshot({ phase: 'lost', error: `Session “${gone.name}” no longer exists on ${host.hostname}.` });
      return 'done';
    }
    this.setSnapshot({ phase: 'attaching', error: null });
    let failure: string | null = null;
    for (const record of [...this.terminals]) {
      if (!this.terminals.includes(record)) continue;
      record.session = listing.sessions.find((row) => sameSession(row, record.session)) ?? record.session;
      const attached = await this.openTerminal(record, connection, hostCli, 'recovery');
      if (!this.isCurrentConnect(intent)) return 'superseded';
      if (attached.ok || attached.reason === 'superseded') continue;
      if (this.isCurrentTransportFailure(attached.message)) {
        // The new transport died under the attach: release what this
        // generation opened and dial again.
        const opened = this.detachTerminalsFromTransport();
        for (const pty of opened) await this.closePtyRef(pty);
        await this.closeCurrentTransport();
        return 'retry';
      }
      failure = attached.message;
    }
    const focus = (selected && this.findTerminal(selected)) ?? this.terminals.at(-1) ?? null;
    if (!this.hasLiveTerminal()) {
      this.setSnapshot({ phase: this.terminals.length ? 'error' : 'connected', selectedSession: focus?.session ?? null, error: failure });
      return 'done';
    }
    this.setSnapshot({ phase: 'live', selectedSession: focus?.session ?? null, error: failure, retryAttempt: 0 });
    return 'done';
  }

  private leastRecentlyFocused(): TerminalRecord | null {
    let oldest: TerminalRecord | null = null;
    for (const record of this.terminals) {
      if (!oldest || record.focusedAt < oldest.focusedAt) oldest = record;
    }
    return oldest;
  }

  private findTerminal(session: SessionRow): TerminalRecord | null {
    return this.terminals.find((record) => sameSession(record.session, session)) ?? null;
  }

  private hasLiveTerminal(): boolean {
    return this.terminals.some((record) => record.pty !== null);
  }

  /** The phase of a usable connection with nothing failing: by its terminals. */
  private idlePhase(): ConnectionPhase {
    if (this.hasLiveTerminal()) return 'live';
    return this.terminals.some((record) => record.attaching) ? 'attaching' : 'connected';
  }

  /**
   * Drop `record` from the open terminals and stop its pump and any attach in
   * flight. Returns its PTY for the caller to close. The selection moves to
   * the newest remaining terminal (or clears), unless `keepSelection` keeps
   * an ended session named as the selection.
   */
  private removeTerminal(record: TerminalRecord, options: { keepSelection?: boolean } = {}): SshPtyRef | null {
    const index = this.terminals.indexOf(record);
    if (index >= 0) this.terminals.splice(index, 1);
    record.attachToken += 1;
    record.pumpToken += 1;
    const pty = record.pty;
    record.pty = null;
    const selected = this.snapshot.selectedSession;
    if (selected && sameSession(selected, record.session)) {
      const next = this.terminals.at(-1)?.session ?? null;
      if (next || !options.keepSelection) this.snapshot = { ...this.snapshot, selectedSession: next };
    }
    return pty;
  }

  /** Stop every terminal's pump and attach, keeping the terminals; returns their PTYs. */
  private detachTerminalsFromTransport(): SshPtyRef[] {
    const ptys: SshPtyRef[] = [];
    for (const record of this.terminals) {
      record.attachToken += 1;
      record.pumpToken += 1;
      if (record.pty) ptys.push(record.pty);
      record.pty = null;
    }
    return ptys;
  }

  private async closeAllTerminals(): Promise<void> {
    const ptys = this.detachTerminalsFromTransport();
    this.terminals.splice(0);
    for (const pty of ptys) await this.closePtyRef(pty);
  }

  private async closePtyRef(pty: SshPtyRef): Promise<void> {
    const requestId = this.createId();
    await this.capability.closePty({ ...pty, requestId }).then((result) => {
      if (result.requestId !== requestId) throw new Error('PTY close returned a stale request.');
    }).catch(() => undefined);
  }

  private async abandonPty(record: TerminalRecord, pty: SshPtyRef): Promise<void> {
    if (record.pty?.channelId !== pty.channelId) return;
    record.pty = null;
    record.pumpToken += 1;
    await this.closePtyRef(pty);
  }

  private async closeCurrentTransport(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    this.hostCli = null;
    if (!connection) return;
    await this.cancelCapability({ kind: 'connection', ...connection });
    const requestId = this.createId();
    await this.capability.closeConnection({ ...connection, requestId }).then((result) => {
      if (result.requestId !== requestId) throw new Error('SSH close returned a stale request.');
    }).catch(() => undefined);
  }

  private async cancelCapability(target: SshCancellationTarget): Promise<void> {
    const requestId = this.createId();
    await this.capability.cancelOperation({ requestId, target }).then((result) => {
      if (result.requestId !== requestId) throw new Error('SSH cancel returned a stale request.');
    }).catch(() => undefined);
  }

  /**
   * Whether an operation's connection is still the controller's current
   * generation. Anything observed on a superseded generation (a reconnect or
   * grace expiry replaced it) is stale and must not touch the phase or start
   * another reconnect (#2982).
   */
  private isCurrentGeneration(connection: SshConnectionRef | null): boolean {
    const current = this.connection;
    return !!connection && !!current
      && current.connectionId === connection.connectionId
      && current.generationId === connection.generationId;
  }

  /**
   * True only when the transport DEFINITIVELY says the PTY's generation is
   * gone: it is no longer the current generation, or the native state is
   * `lost`/`closed`. A probe that errors or answers for another request is
   * retried briefly; if it never answers, the state is unknown and the EOF
   * reads as what it most likely is — the session ended. Guessing "lost" on
   * a slow bridge would turn a real session end into a reconnect, and the
   * native `lost` event still starts recovery if the link really died.
   */
  private async transportLost(pty: SshPtyRef): Promise<boolean> {
    for (let attempt = 0; attempt < EOF_PROBE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await this.delay(EOF_PROBE_RETRY_MS);
      const connection = this.connection;
      if (!connection || connection.generationId !== pty.generationId) return true;
      try {
        const requestId = this.createId();
        const status = await this.capability.getConnectionState({ ...connection, requestId });
        if (status.requestId !== requestId) continue;
        return status.state === 'lost' || status.state === 'closed';
      } catch {
        // Unknown: ask again.
      }
    }
    return false;
  }

  private isCurrentConnect(intent: number): boolean {
    return !this.disposed && this.connectIntent === intent;
  }

  private cancelledConnectResult(): ConnectionActionResult<SshConnectionRef> {
    return { ok: false, reason: 'failed', message: 'SSH connect was cancelled.' };
  }

  private onConnectionState(event: SshConnectionStateEvent): void {
    const current = this.connection;
    if (!current || current.connectionId !== event.connectionId || current.generationId !== event.generationId) return;
    if (event.state === 'closed' && event.reason === 'grace-expired' && this.snapshot.phase === 'background') {
      // The terminals stay open: foreground re-attaches every one of them.
      this.detachTerminalsFromTransport();
      this.connection = null;
      this.hostCli = null;
      this.setSnapshot({ phase: 'background', connectionId: null, error: null });
      return;
    }
    if (event.state === 'lost') this.startReconnect(event.reason ?? 'SSH transport lost');
  }

  private async reconcileUncertainMutation(): Promise<void> {
    const refreshed = await this.refreshSessions();
    if (!refreshed.ok) return;
    this.reconcilePendingMutation(refreshed.value);
  }

  private reconcilePendingMutation(listing: SessionsListing): void {
    const mutation = this.snapshot.uncertainMutation;
    if (!mutation || listing.errors.length > 0) return;
    const nameExists = listing.sessions.some((session) => session.name === mutation.target);
    const applied = mutation.kind === 'create-session'
      ? nameExists || listing.sessions.some((session) => session.tag === mutation.target)
      : !nameExists;
    if (applied) {
      this.setSnapshot({ uncertainMutation: { ...mutation, state: 'observed-applied' } });
    }
  }

  private recordUncertainMutation(mutation: Pick<UncertainMutation, 'kind' | 'target'>): void {
    this.setSnapshot({
      uncertainMutation: {
        ...mutation,
        state: 'unknown',
        recordedAt: this.now(),
      },
    });
  }

  private readPresentedKey(data: Record<string, unknown>): PendingHostKeyDecision['presented'] | null {
    const keyType = data.keyType;
    const keyB64 = data.keyB64;
    const fingerprintSha256 = data.fingerprintSha256;
    if (typeof keyType !== 'string' || typeof keyB64 !== 'string' || typeof fingerprintSha256 !== 'string') return null;
    return { keyType, keyB64, fingerprintSha256 };
  }

  private isCurrentTransportFailure(error: unknown): boolean {
    if (typeof error === 'string') return /connection|transport|closed|eof|socket|ssh/i.test(error);
    const nativeError = readSshCapabilityError(error);
    return ['CONNECTION_LOST', 'CONNECTION_CLOSED', 'CHANNEL_CLOSED', 'SSH_IO'].includes(nativeError.code);
  }

  private setSnapshot(patch: Partial<Omit<ConnectionSnapshot, 'revision' | 'terminals'>>): void {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      terminals: this.terminals.map((record) => record.session),
      revision: this.snapshot.revision + 1,
    };
    const value = this.getSnapshot();
    for (const listener of this.listeners) listener(value);
  }

  /** Run `operation` after every earlier write/resize of the same terminal. */
  private withTerminalOperation<T>(record: TerminalRecord, operation: () => Promise<T>): Promise<T> {
    const run = record.operationQueue.then(operation, operation);
    record.operationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('ConnectionController is closed.');
  }
}

/** The PTY bound: the caller's, else the platform's channel budget minus the reserve, else the default. */
function resolveMaxOpenPtys(requested: number | undefined, channels: number | undefined): number {
  if (requested !== undefined && Number.isInteger(requested) && requested >= 1) return requested;
  if (channels !== undefined && Number.isInteger(channels) && channels >= 1) {
    return Math.max(1, channels - PTY_CHANNEL_RESERVE);
  }
  return DEFAULT_MAX_OPEN_PTYS;
}

function isKeyHandleCredential(value: unknown): value is { kind: 'key-handle' } {
  return typeof value === 'object' && value !== null
    && (value as { kind?: unknown }).kind === 'key-handle';
}

function hostWithoutTransientPassphrase(host: SshHostTarget): SshHostTarget {
  const credential = host.credential;
  if (credential.kind !== 'key-handle' || credential.passphrase == null) return host;
  return {
    ...host,
    credential: { kind: 'key-handle', handleId: credential.handleId },
  };
}

function hostWithTransientPassphrase(host: SshHostTarget, passphrase?: string | null): SshHostTarget {
  if (passphrase === undefined || host.credential.kind !== 'key-handle') return host;
  return {
    ...host,
    credential: { kind: 'key-handle', handleId: host.credential.handleId, passphrase },
  };
}
