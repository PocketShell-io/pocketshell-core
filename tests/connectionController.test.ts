import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HostCliFailed,
  verifyHostKeyTrustPin,
  type HostKeyTrustPin,
  type SessionRow,
} from '../src';
import { ConnectionController, type HostKeyTrustStore } from '../src/connectionController';
import { runConnectionControllerContract } from './connectionControllerContract';
import {
  SshCapabilityError,
  type SshCapability,
  type SshConnectOptions,
  type SshConnectResult,
  type SshConnectionRef,
  type SshConnectionStateEvent,
  type SshExecOptions,
  type SshExecResult,
  type SshHostTarget,
  type SshPortForwardOptions,
  type SshPortForwardRef,
  type SshPtyOpenOptions,
  type SshPtyReadOptions,
  type SshPtyReadResult,
  type SshPtyRef,
  type SshPtyResizeOptions,
  type SshPtyWriteOptions,
  type SshResourceSnapshot,
} from '../src/sshCapability';

const HOST_KEY = { keyType: 'ssh-ed25519', keyB64: 'AQIDBA==', fingerprintSha256: 'SHA256:abc123' } as const;
const PIN = { kind: 'wire-key', ...HOST_KEY } as const;

function session(name: string): SessionRow {
  return {
    name,
    id: `${name}-id`,
    workspace: '/work',
    tag: null,
    engine: null,
    profile: null,
    agent: null,
    agentState: null,
    agentStateSource: null,
    attached: false,
    createdEpoch: null,
    activityEpoch: null,
  };
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for the controller condition.');
}

class FakeCapability {
  readonly connectCalls: SshConnectOptions[] = [];
  readonly execCommands: string[] = [];
  readonly openPtyCalls: SshPtyOpenOptions[] = [];
  readonly closePtyCalls: SshPtyRef[] = [];
  readonly writeCalls: SshPtyWriteOptions[] = [];
  readonly resizeCalls: SshPtyResizeOptions[] = [];
  readonly connections = new Map<string, string>();
  readonly ptys = new Map<string, SshPtyRef>();
  readonly forwards = new Map<string, SshPortForwardRef>();
  private readonly listeners = new Set<(event: SshConnectionStateEvent) => void>();
  private readonly pendingReads: Array<{
    options: SshPtyReadOptions;
    resolve: (value: SshPtyReadResult) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  private readonly queuedOutput = new Map<string, Array<{ bytes: Uint8Array; eof: boolean }>>();
  readonly sessions: SessionRow[] = [session('alpha'), session('beta')];
  listErrors: Array<{ message: string }> = [];
  createRequests = 0;
  killRequests = 0;
  createAfterApplyFailure = false;
  createAppliedName: string | null = null;
  createAppliedTag: string | null = null;
  killAfterApplyFailure = false;
  nextWriteError: unknown = null;
  nextExecError: unknown = null;
  readonly hostCommands = new Map<string, { exitCode: number | null; stdout: string; stderr?: string }>();
  private connectionOrdinal = 0;
  private ptyOrdinal = 0;
  private readonly graceScheduled = new Set<string>();

  addListener = async (
    _eventName: 'connectionState',
    listener: (event: SshConnectionStateEvent) => void,
  ) => {
    this.listeners.add(listener);
    return { remove: async () => { this.listeners.delete(listener); } };
  };

  /** While true every dial fails the way an unreachable host does (retryable). */
  refuseDials = false;
  /** While set every dial fails with this non-retryable native error. */
  refuseLogins: { code: string; message: string } | null = null;

  connect = async (options: SshConnectOptions): Promise<SshConnectResult> => {
    this.connectCalls.push(options);
    if (this.refuseDials) throw new SshCapabilityError('Connection refused', 'SSH_IO');
    if (this.refuseLogins) throw new SshCapabilityError(this.refuseLogins.message, this.refuseLogins.code);
    if (verifyHostKeyTrustPin(options.expectedHostKey, HOST_KEY) !== 'trusted') {
      throw new SshCapabilityError('Host key needs a user decision.', 'HOST_KEY_REJECTED', HOST_KEY);
    }
    const connectionId = `connection-${++this.connectionOrdinal}`;
    this.connections.set(connectionId, options.generationId);
    return { requestId: options.requestId, connectionId, generationId: options.generationId, hostKey: HOST_KEY };
  };

  getConnectionState = async (ref: SshConnectionRef & { requestId: string }) => ({
    requestId: ref.requestId,
    state: this.connections.has(ref.connectionId) ? 'connected' as const : 'closed' as const,
  });

  closeConnection = async (ref: SshConnectionRef & { requestId: string }) => {
    this.connections.delete(ref.connectionId);
    for (const [channelId, pty] of this.ptys) {
      if (pty.connectionId === ref.connectionId) this.closePtyRef(pty);
    }
    this.graceScheduled.delete(ref.connectionId);
    return { requestId: ref.requestId };
  };

  cancelOperation = async (options: { requestId: string; target: any }) => {
    if (options.target.kind === 'connection') {
      await this.closeConnection({ ...options.target, requestId: options.requestId });
    }
    return { requestId: options.requestId, cancelled: true };
  };

  scheduleClose = async (ref: SshConnectionRef & { requestId: string }) => {
    this.graceScheduled.add(ref.connectionId);
    return { requestId: ref.requestId };
  };

  cancelScheduledClose = async (ref: SshConnectionRef & { requestId: string }) => {
    const cancelled = this.graceScheduled.delete(ref.connectionId);
    return { requestId: ref.requestId, cancelled };
  };

  exec = async (options: SshExecOptions): Promise<SshExecResult> => {
    this.execCommands.push(options.command);
    if (this.nextExecError) {
      const error = this.nextExecError;
      this.nextExecError = null;
      throw error;
    }
    const scripted = this.hostCommands.get(options.command);
    if (scripted) {
      return {
        requestId: options.requestId,
        connectionId: options.connectionId,
        generationId: options.generationId,
        exitCode: scripted.exitCode,
        stdout: scripted.stdout,
        stderr: scripted.stderr ?? '',
        timedOut: false,
      };
    }
    if (options.command.includes('sessions list')) {
      return {
        requestId: options.requestId,
        connectionId: options.connectionId,
        generationId: options.generationId,
        exitCode: 0,
        stdout: JSON.stringify({
          schema: 3,
          sessions: this.sessions.map(({ name, id, workspace, tag, attached }) => ({ name, id, workspace, tag, attached })),
          errors: this.listErrors,
        }),
        stderr: '',
        timedOut: false,
      };
    }
    if (options.command.includes('sessions create')) {
      this.createRequests += 1;
      const name = options.command.split(' -- ').at(-1)?.replace(/^'|'$/g, '') ?? 'created';
      if (this.createAfterApplyFailure) {
        this.createAfterApplyFailure = false;
        const created = session(this.createAppliedName ?? name);
        created.tag = this.createAppliedTag;
        this.sessions.push(created);
        throw new HostCliFailed(options.command, null, '', false, 'SSH transport ended after the host applied create.');
      }
      this.sessions.push(session(name));
      return {
        requestId: options.requestId,
        connectionId: options.connectionId,
        generationId: options.generationId,
        exitCode: 0,
        stdout: JSON.stringify({ schema: 3, name, id: `${name}-id`, created: true }),
        stderr: '',
        timedOut: false,
      };
    }
    if (options.command.includes('sessions kill')) {
      this.killRequests += 1;
      const name = options.command.split(' -- ').at(-1)?.replace(/^'|'$/g, '') ?? '';
      if (this.killAfterApplyFailure) {
        this.killAfterApplyFailure = false;
        const index = this.sessions.findIndex((row) => row.name === name);
        if (index >= 0) this.sessions.splice(index, 1);
        throw new HostCliFailed(options.command, null, '', false, 'SSH transport ended after the host applied kill.');
      }
      return {
        requestId: options.requestId,
        connectionId: options.connectionId,
        generationId: options.generationId,
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
      };
    }
    throw new Error(`Unexpected HostCliCore command: ${options.command}`);
  };

  openPty = async (options: SshPtyOpenOptions) => {
    this.openPtyCalls.push(options);
    const pty: SshPtyRef = {
      connectionId: options.connectionId,
      generationId: options.generationId,
      channelId: `pty-${++this.ptyOrdinal}`,
    };
    this.ptys.set(pty.channelId, pty);
    return { ...pty, requestId: options.requestId };
  };

  readPty = async (options: SshPtyReadOptions): Promise<SshPtyReadResult> => {
    const queued = this.queuedOutput.get(options.channelId)?.shift();
    if (queued) return this.readResult(options, queued.bytes, queued.eof);
    return new Promise((resolve, reject) => this.pendingReads.push({ options, resolve, reject }));
  };

  writePty = async (options: SshPtyWriteOptions) => {
    this.writeCalls.push(options);
    if (this.nextWriteError) {
      const error = this.nextWriteError;
      this.nextWriteError = null;
      throw error;
    }
    return { ...options };
  };

  resizePty = async (options: SshPtyResizeOptions) => {
    this.resizeCalls.push(options);
    return { ...options };
  };

  closePty = async (options: SshPtyRef & { requestId: string }) => {
    this.closePtyCalls.push(options);
    this.closePtyRef(options);
    return { requestId: options.requestId };
  };

  sftpList = async (options: { requestId: string }) => ({ requestId: options.requestId, entries: [] });
  sftpRead = async (options: { requestId: string }) => ({ requestId: options.requestId, dataBase64: '' });
  sftpWrite = async (options: { requestId: string }) => ({ requestId: options.requestId, bytesWritten: 0 });
  sftpMkdir = async (options: { requestId: string }) => ({ requestId: options.requestId });
  sftpRename = async (options: { requestId: string }) => ({ requestId: options.requestId });
  sftpDelete = async (options: { requestId: string }) => ({ requestId: options.requestId });

  openPortForward = async (options: SshPortForwardOptions): Promise<SshPortForwardRef & { requestId: string }> => {
    const forward = {
      connectionId: options.connectionId,
      generationId: options.generationId,
      forwardId: 'forward-1',
      localPort: options.localPort ?? 4000,
    };
    this.forwards.set(forward.forwardId, forward);
    return { ...forward, requestId: options.requestId };
  };

  closePortForward = async (options: SshPortForwardRef & { requestId: string }) => {
    this.forwards.delete(options.forwardId);
    return { requestId: options.requestId };
  };

  resourceSnapshot = async (requestId: string): Promise<SshResourceSnapshot> => ({
    requestId,
    connections: this.connections.size,
    ptys: this.ptys.size,
    sftpClients: 0,
    forwards: this.forwards.size,
  });

  emitOutput(channelId: string, bytes: Uint8Array, eof = false): void {
    const index = this.pendingReads.findIndex((pending) => pending.options.channelId === channelId);
    if (index < 0) {
      const queue = this.queuedOutput.get(channelId) ?? [];
      queue.push({ bytes, eof });
      this.queuedOutput.set(channelId, queue);
      return;
    }
    const [pending] = this.pendingReads.splice(index, 1);
    pending!.resolve(this.readResult(pending!.options, bytes, eof));
  }

  failRead(channelId: string, error: unknown): void {
    const index = this.pendingReads.findIndex((pending) => pending.options.channelId === channelId);
    if (index < 0) throw new Error(`No pending PTY read for ${channelId}.`);
    const [pending] = this.pendingReads.splice(index, 1);
    pending!.reject(error);
  }

  emitGraceExpired(connection: SshConnectionRef): void {
    this.connections.delete(connection.connectionId);
    const event: SshConnectionStateEvent = {
      ...connection,
      state: 'closed',
      reason: 'grace-expired',
    };
    for (const listener of this.listeners) listener(event);
  }

  emitLost(reason = 'socket reset'): void {
    const connection = [...this.connections.entries()].at(-1);
    if (!connection) throw new Error('No connected fake SSH connection to drop.');
    const [connectionId, generationId] = connection;
    const event: SshConnectionStateEvent = { connectionId, generationId, state: 'lost', reason };
    for (const listener of this.listeners) listener(event);
  }

  pendingReadsFor(channelId: string): number {
    return this.pendingReads.filter((pending) => pending.options.channelId === channelId).length;
  }

  private readResult(options: SshPtyReadOptions, bytes: Uint8Array, eof: boolean): SshPtyReadResult {
    return {
      requestId: options.requestId,
      connectionId: options.connectionId,
      generationId: options.generationId,
      channelId: options.channelId,
      sequence: options.sequence + (bytes.length > 0 ? 1 : 0),
      dataBase64: base64(bytes),
      eof,
    };
  }

  private closePtyRef(pty: SshPtyRef): void {
    this.ptys.delete(pty.channelId);
    for (let index = this.pendingReads.length - 1; index >= 0; index -= 1) {
      const pending = this.pendingReads[index]!;
      if (pending.options.channelId === pty.channelId) {
        this.pendingReads.splice(index, 1);
        pending.resolve(this.readResult(pending.options, new Uint8Array(), true));
      }
    }
  }
}

const host: SshHostTarget = {
  hostId: 'fixture-host',
  hostname: '127.0.0.1',
  port: 2222,
  username: 'testuser',
  credential: { kind: 'private-key', privateKeyPem: 'test-private-key' },
};

function trustStore(initial: HostKeyTrustPin | null = null) {
  let pin = initial;
  const store: HostKeyTrustStore = {
    get: vi.fn(async () => pin),
    record: vi.fn(async (_hostId, next) => { pin = next; }),
  };
  return { store, current: () => pin };
}

function controllerFor(
  capability: FakeCapability,
  trusted = trustStore(),
  options: { now?: () => number; retryDelaysMs?: readonly number[] } = {},
) {
  let id = 0;
  const controller = new ConnectionController({
    capability: capability as unknown as SshCapability,
    trustStore: trusted.store,
    createId: () => `request-${++id}`,
    retryDelaysMs: [0],
    ...options,
  });
  return { controller, trusted };
}

async function connectAndList(controller: ConnectionController) {
  const connected = await controller.connect(host);
  expect(connected.ok).toBe(true);
  const listing = await controller.refreshSessions();
  expect(listing.ok).toBe(true);
  return listing;
}

describe('JS connection and session policy', () => {
  const controllers: ConnectionController[] = [];

  afterEach(async () => {
    await Promise.all(controllers.splice(0).map((controller) => controller.close()));
  });

  it('runs the portable policy contract as a shared source-level suite', async () => {
    await expect(runConnectionControllerContract(await import('../src'))).resolves.toMatch(/^assertions=\d+$/);
  });

  it('rejects unknown and changed host keys until the user accepts the presented key', async () => {
    const capability = new FakeCapability();
    const trust = trustStore();
    const { controller } = controllerFor(capability, trust);
    controllers.push(controller);

    const unknown = await controller.connect(host);
    expect(unknown).toMatchObject({ ok: false, reason: 'trust-required' });
    expect(controller.getSnapshot().trustDecision?.reason).toBe('unknown');
    expect(capability.connections.size).toBe(0);
    expect((await controller.acceptPresentedHostKey()).ok).toBe(true);
    expect(trust.current()).toEqual(PIN);

    await controller.close();
    const changedTrust = trustStore({ kind: 'wire-key', keyType: 'ssh-rsa', keyB64: 'different', fingerprintSha256: 'SHA256:different' });
    const changedCapability = new FakeCapability();
    const changed = controllerFor(changedCapability, changedTrust);
    controllers.push(changed.controller);
    expect((await changed.controller.connect(host))).toMatchObject({ ok: false, reason: 'trust-mismatch' });
    expect(changed.controller.getSnapshot().trustDecision?.reason).toBe('mismatch');
    expect((await changed.controller.acceptPresentedHostKey()).ok).toBe(true);
    expect(changedTrust.current()).toEqual(PIN);
  });

  it('carries host-reported session list errors into the snapshot and clears them when the host recovers', async () => {
    const capability = new FakeCapability();
    capability.sessions.splice(0);
    capability.listErrors = [{ message: 'aplexer snapshot failed' }];
    const { controller } = controllerFor(capability, trustStore(PIN));
    controllers.push(controller);
    await connectAndList(controller);

    expect(controller.getSnapshot().sessions).toEqual([]);
    expect(controller.getSnapshot().sessionListErrors).toEqual([{ message: 'aplexer snapshot failed' }]);

    // A mutation's follow-up listing refreshes the errors too.
    capability.listErrors = [{ message: 'one' }, { message: 'two' }];
    expect((await controller.createSession('gamma')).ok).toBe(true);
    expect(controller.getSnapshot().sessionListErrors.map((row) => row.message)).toEqual(['one', 'two']);

    capability.listErrors = [];
    expect((await controller.refreshSessions()).ok).toBe(true);
    expect(controller.getSnapshot().sessionListErrors).toEqual([]);

    capability.listErrors = [{ message: 'stale' }];
    expect((await controller.refreshSessions()).ok).toBe(true);
    await controller.close();
    expect(controller.getSnapshot().sessionListErrors).toEqual([]);
  });

  it('routes list and attach through HostCliCore and switches sessions on one SSH connection', async () => {
    const capability = new FakeCapability();
    const { controller } = controllerFor(capability, trustStore(PIN));
    controllers.push(controller);
    await connectAndList(controller);

    expect(capability.execCommands[0]).toBe('pocketshell sessions list --json');
    expect(controller.getSnapshot().sessions.map((row) => row.name)).toEqual(['alpha', 'beta']);
    const connectedCount = capability.connectCalls.length;
    expect((await controller.switchSession(session('alpha'))).ok).toBe(true);
    const firstPty = controller.getSnapshot().selectedSession;
    expect(firstPty?.name).toBe('alpha');
    expect(capability.openPtyCalls[0]?.command).toContain('pocketshell sessions attach --');
    expect(capability.openPtyCalls[0]?.command).toContain("'alpha'");

    expect((await controller.switchSession(session('beta'))).ok).toBe(true);
    expect(capability.closePtyCalls).toHaveLength(1);
    expect(controller.getSnapshot().selectedSession?.name).toBe('beta');
    expect(capability.connectCalls).toHaveLength(connectedCount);
    expect(capability.openPtyCalls[1]?.command).toContain("'beta'");
  });

  it('does not let old queued operations or resize errors poison a new PTY', async () => {
    const capability = new FakeCapability();
    const { controller } = controllerFor(capability, trustStore(PIN));
    controllers.push(controller);
    await connectAndList(controller);
    expect((await controller.switchSession(session('alpha'))).ok).toBe(true);

    const resizeGate = deferred<void>();
    const resizeStarted = deferred<void>();
    capability.resizePty = async (options) => {
      resizeStarted.resolve();
      await resizeGate.promise;
      throw new Error(`The closed PTY ${options.channelId} cannot be resized.`);
    };
    const resize = controller.resizeTerminal(37, 15);
    await resizeStarted.promise;
    const queuedWrite = controller.writeTerminalBytes(new TextEncoder().encode('old-session-input'));
    const switchResult = controller.switchSession(session('beta'));
    expect((await switchResult).ok).toBe(true);
    expect(capability.closePtyCalls).toHaveLength(1);

    resizeGate.resolve();
    expect(await resize).toMatchObject({ ok: false, reason: 'superseded' });
    expect(await queuedWrite).toMatchObject({ ok: false, reason: 'superseded' });
    expect(capability.writeCalls).toHaveLength(0);
    expect(controller.getSnapshot().selectedSession?.name).toBe('beta');
    expect(controller.getSnapshot().phase).toBe('live');
  });

  it('ignores an old native write failure after switching PTYs', async () => {
    const capability = new FakeCapability();
    const { controller } = controllerFor(capability, trustStore(PIN));
    controllers.push(controller);
    await connectAndList(controller);
    expect((await controller.switchSession(session('alpha'))).ok).toBe(true);

    const writeGate = deferred<void>();
    const writeStarted = deferred<void>();
    capability.writePty = async () => {
      writeStarted.resolve();
      await writeGate.promise;
      throw new Error('The old PTY was closed.');
    };
    const oldWrite = controller.writeTerminalBytes(new TextEncoder().encode('old input'));
    await writeStarted.promise;
    expect((await controller.switchSession(session('beta'))).ok).toBe(true);

    writeGate.resolve();
    expect(await oldWrite).toMatchObject({ ok: false, reason: 'superseded' });
    expect(controller.getSnapshot().selectedSession?.name).toBe('beta');
    expect(controller.getSnapshot().phase).toBe('live');
  });

  it('treats empty terminal input as a no-op without consuming a PTY sequence', async () => {
    const capability = new FakeCapability();
    const { controller } = controllerFor(capability, trustStore(PIN));
    controllers.push(controller);
    await connectAndList(controller);
    expect((await controller.switchSession(session('alpha'))).ok).toBe(true);

    expect(await controller.writeTerminalBytes(new Uint8Array())).toMatchObject({ ok: true, value: { sequence: 0 } });
    expect(capability.writeCalls).toHaveLength(0);
    expect((await controller.writeTerminalBytes(new TextEncoder().encode('x'))).ok).toBe(true);
    expect(capability.writeCalls[0]?.sequence).toBe(1);
    expect(controller.getSnapshot().phase).toBe('live');
  });

  it('awaits terminal output consumers and serializes PTY input and resize operations', async () => {
    const capability = new FakeCapability();
    const { controller } = controllerFor(capability, trustStore(PIN));
    controllers.push(controller);
    await connectAndList(controller);
    await controller.switchSession(session('alpha'));
    await waitFor(() => capability.openPtyCalls.length === 1 && capability.ptys.size === 1);
    const channelId = [...capability.ptys.keys()][0];
    expect(channelId).toBeTruthy();
    await waitFor(() => capability.pendingReadsFor(channelId!) === 1);

    const gate = deferred<void>();
    const consumerStarted = deferred<void>();
    const received = vi.fn(async () => {
      consumerStarted.resolve();
      await gate.promise;
    });
    controller.subscribeTerminalOutput(async (_selected, bytes) => {
      expect(new TextDecoder().decode(bytes)).toBe('hello');
      await received();
    });
    capability.emitOutput(channelId!, new TextEncoder().encode('hello'));
    await consumerStarted.promise;
    expect(capability.pendingReadsFor(channelId!)).toBe(0);
    gate.resolve();
    await waitFor(() => capability.pendingReadsFor(channelId!) === 1);

    const writes = controller.writeTerminalBytes(new TextEncoder().encode('ls\n'));
    const resize = controller.resizeTerminal(120, 36);
    expect((await writes).ok).toBe(true);
    expect((await resize).ok).toBe(true);
    expect(capability.writeCalls).toHaveLength(1);
    expect(capability.resizeCalls).toHaveLength(1);
    expect(capability.writeCalls[0]?.sequence).toBe(1);
    expect(capability.writeCalls[0]?.dataBase64).toBe(base64(new TextEncoder().encode('ls\n')));
    expect(capability.resizeCalls[0]).toMatchObject({ sequence: 2, cols: 120, rows: 36 });
    expect(received).toHaveBeenCalledOnce();
  });

  it('runs host commands on the current generation and reconnects when one loses the transport', async () => {
    const capability = new FakeCapability();
    const { controller } = controllerFor(capability, trustStore(PIN));
    controllers.push(controller);
    expect(await controller.runHostCommand('true', 1_000)).toMatchObject({ ok: false, reason: 'not-connected' });

    await connectAndList(controller);
    capability.hostCommands.set('printf %s "$HOME"', { exitCode: 0, stdout: '/home/testuser' });
    capability.hostCommands.set('false', { exitCode: 1, stdout: '' });
    expect(await controller.runHostCommand('printf %s "$HOME"', 1_000)).toEqual({
      ok: true,
      value: { exitCode: 0, stdout: '/home/testuser', stderr: '', timedOut: false },
    });
    // A non-zero exit is an answer, not a transport failure.
    expect(await controller.runHostCommand('false', 1_000)).toMatchObject({ ok: true, value: { exitCode: 1 } });
    expect(capability.connectCalls).toHaveLength(1);

    const originalConnection = controller.getSnapshot().connectionId;
    capability.nextExecError = new SshCapabilityError('socket closed', 'CONNECTION_LOST');
    expect(await controller.runHostCommand('true', 1_000)).toMatchObject({ ok: false, reason: 'failed' });
    await waitFor(() => capability.connectCalls.length === 2 && controller.getSnapshot().phase === 'connected');
    expect(controller.getSnapshot().connectionId).not.toBe(originalConnection);
  });

  it('reconnects after a real transport-state event and reattaches the selected session', async () => {
    const capability = new FakeCapability();
    const { controller } = controllerFor(capability, trustStore(PIN));
    controllers.push(controller);
    await connectAndList(controller);
    await controller.switchSession(session('alpha'));
    const originalConnection = controller.getSnapshot().connectionId;

    capability.emitLost();
    await waitFor(() => capability.connectCalls.length === 2 && controller.getSnapshot().phase === 'live');
    expect(controller.getSnapshot().connectionId).not.toBe(originalConnection);
    expect(controller.getSnapshot().selectedSession?.name).toBe('alpha');
    expect(capability.openPtyCalls).toHaveLength(2);
  });

  it('keeps a connection inside background grace and reconnects after the deadline', async () => {
    const capability = new FakeCapability();
    let now = 1000;
    const { controller } = controllerFor(capability, trustStore(PIN), { now: () => now });
    controllers.push(controller);
    await connectAndList(controller);
    await controller.switchSession(session('alpha'));
    const originalConnection = controller.getSnapshot().connectionId;

    await controller.enterBackground(10_000);
    now += 5000;
    await controller.returnToForeground();
    expect(controller.getSnapshot().connectionId).toBe(originalConnection);
    expect(capability.connectCalls).toHaveLength(1);

    await controller.enterBackground(10_000);
    now += 10_001;
    await controller.returnToForeground();
    expect(capability.connectCalls).toHaveLength(2);
    expect(controller.getSnapshot().phase).toBe('live');
    expect(controller.getSnapshot().selectedSession?.name).toBe('alpha');
  });

  it.each([
    { exit: 'EOF', order: 'PTY EOF before the native grace event' },
    { exit: 'EOF', order: 'native grace event before PTY EOF' },
    { exit: 'transport error', order: 'PTY read error before the native grace event' },
    { exit: 'transport error', order: 'native grace event before PTY read error' },
  ])('keeps background lifecycle state through $exit when $order', async ({ exit, order }) => {
    const capability = new FakeCapability();
    let now = 1_000;
    const { controller } = controllerFor(capability, trustStore(PIN), { now: () => now });
    controllers.push(controller);
    await connectAndList(controller);
    await controller.switchSession(session('alpha'));
    const originalConnection = controller.getSnapshot().connectionId;
    const originalGeneration = controller.getSnapshot().generationId;
    expect(originalConnection).toBeTruthy();
    expect(originalGeneration).toBeTruthy();
    await waitFor(() => capability.pendingReads.length === 1);
    const channelId = capability.pendingReads[0]!.options.channelId;

    await controller.enterBackground(10_000);
    const expiredRef = { connectionId: originalConnection!, generationId: originalGeneration! };
    const endPump = () => {
      if (exit === 'EOF') {
        capability.emitOutput(channelId, new Uint8Array(), true);
      } else {
        capability.failRead(channelId, new SshCapabilityError('SSH transport closed.', 'CONNECTION_LOST'));
      }
    };

    if (order.startsWith('PTY')) {
      const revisionBeforeReadExit = controller.getSnapshot().revision;
      endPump();
      await waitFor(() => controller.getSnapshot().revision > revisionBeforeReadExit);
      expect(controller.getSnapshot().phase).toBe('background');
      expect(capability.connectCalls).toHaveLength(1);
      capability.emitGraceExpired(expiredRef);
    } else {
      capability.emitGraceExpired(expiredRef);
      endPump();
      await waitFor(() => capability.pendingReads.length === 0);
    }

    expect(controller.getSnapshot()).toMatchObject({ phase: 'background', connectionId: null });
    expect(capability.connectCalls).toHaveLength(1);
    now += 10_001;
    await controller.returnToForeground();

    expect(capability.connectCalls).toHaveLength(2);
    expect(controller.getSnapshot().phase).toBe('live');
    expect(controller.getSnapshot().connectionId).not.toBe(originalConnection);
    expect(controller.getSnapshot().selectedSession?.name).toBe('alpha');
    expect(capability.openPtyCalls).toHaveLength(2);
  });

  it('does not resend uncertain create or kill operations and reconciles the host listing', async () => {
    const capability = new FakeCapability();
    const { controller } = controllerFor(capability, trustStore(PIN));
    controllers.push(controller);
    await connectAndList(controller);

    capability.createAfterApplyFailure = true;
    expect((await controller.createSession('created-once')).ok).toBe(false);
    expect(capability.createRequests).toBe(1);
    expect(controller.getSnapshot().uncertainMutation).toMatchObject({
      kind: 'create-session', target: 'created-once', state: 'observed-applied',
    });

    controller.clearUncertainMutation();
    capability.killAfterApplyFailure = true;
    expect((await controller.killSession('alpha')).ok).toBe(false);
    expect(capability.killRequests).toBe(1);
    expect(controller.getSnapshot().uncertainMutation).toMatchObject({
      kind: 'kill-session', target: 'alpha', state: 'observed-applied',
    });

    controller.clearUncertainMutation();
    const qualifiedTagOnly = session('testuser:tag-only-kill');
    qualifiedTagOnly.tag = 'tag-only-kill';
    capability.sessions.push(qualifiedTagOnly);
    capability.killAfterApplyFailure = true;
    expect((await controller.killSession('tag-only-kill')).ok).toBe(false);
    expect(controller.getSnapshot().uncertainMutation).toMatchObject({
      kind: 'kill-session', target: 'tag-only-kill', state: 'observed-applied',
    });
    expect(capability.execCommands.filter((command) => command.includes('sessions create'))).toHaveLength(1);
    expect(capability.execCommands.filter((command) => command.includes('sessions kill'))).toHaveLength(2);
  });

  it('reconciles an uncertain create by its exact tag when the host qualifies the session name', async () => {
    const capability = new FakeCapability();
    const { controller } = controllerFor(capability, trustStore(PIN));
    controllers.push(controller);
    await connectAndList(controller);

    capability.createAfterApplyFailure = true;
    capability.createAppliedName = 'testuser:created-once';
    capability.createAppliedTag = 'created-once';
    expect((await controller.createSession('created-once')).ok).toBe(false);

    expect(capability.createRequests).toBe(1);
    expect(controller.getSnapshot().uncertainMutation).toMatchObject({
      kind: 'create-session', target: 'created-once', state: 'observed-applied',
    });
  });

  it('does not retry terminal input after an uncertain native send and proves resource closure', async () => {
    const capability = new FakeCapability();
    const { controller } = controllerFor(capability, trustStore(PIN));
    controllers.push(controller);
    await connectAndList(controller);
    await controller.switchSession(session('alpha'));
    capability.nextWriteError = new SshCapabilityError('SSH transport was lost during write.', 'CONNECTION_LOST');

    expect((await controller.writeTerminalBytes(new TextEncoder().encode('command\n'))).ok).toBe(false);
    await waitFor(() => capability.connectCalls.length === 2 && controller.getSnapshot().phase === 'live');
    expect(capability.writeCalls).toHaveLength(1);
    expect((await controller.getResourceSnapshot()).ptys).toBe(1);

    await controller.close();
    const afterClose = await capability.resourceSnapshot('snapshot-after-close');
    expect(afterClose).toMatchObject({ connections: 0, ptys: 0, sftpClients: 0, forwards: 0 });
  });

  it('stays given up after its ladder, and a Retry runs exactly one more ladder that re-attaches the session (#2954)', async () => {
    const capability = new FakeCapability();
    const { controller } = controllerFor(capability, trustStore(PIN), { retryDelaysMs: [0, 0, 0] });
    controllers.push(controller);
    await connectAndList(controller);
    await controller.switchSession(session('alpha'));
    expect(controller.maxReconnectAttempts).toBe(3);

    capability.refuseDials = true;
    capability.emitLost();
    await waitFor(() => controller.getSnapshot().phase === 'lost');
    expect(capability.connectCalls).toHaveLength(1 + 3);
    expect(controller.getSnapshot().error).toMatch(/after 3 attempts/);
    // A give-up is final until someone asks: the controller never restarts itself.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(capability.connectCalls).toHaveLength(1 + 3);

    // Two presses while one recovery is on the wire: one ladder, one dial.
    capability.refuseDials = false;
    const [first, second] = await Promise.all([controller.reconnect(), controller.reconnect()]);
    expect(first).toEqual({ ok: true, value: undefined });
    expect(second).toEqual({ ok: true, value: undefined });
    expect(capability.connectCalls).toHaveLength(1 + 3 + 1);
    expect(capability.openPtyCalls).toHaveLength(2);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'live', retryAttempt: 0, error: null });
    expect(controller.getSnapshot().selectedSession?.name).toBe('alpha');

    // A Retry on a healthy transport is a no-op, not a re-dial.
    expect(await controller.reconnect()).toEqual({ ok: true, value: undefined });
    expect(capability.connectCalls).toHaveLength(1 + 3 + 1);
  });

  it('joins a running recovery ladder instead of starting a second one (#2954)', async () => {
    const capability = new FakeCapability();
    const { controller } = controllerFor(capability, trustStore(PIN), { retryDelaysMs: [0, 20, 20] });
    controllers.push(controller);
    await connectAndList(controller);
    await controller.switchSession(session('alpha'));

    capability.refuseDials = true;
    capability.emitLost();
    await waitFor(() => capability.connectCalls.length === 2);
    expect(controller.getSnapshot().phase).not.toBe('lost');
    const retry = controller.reconnect();
    capability.refuseDials = false;
    expect(await retry).toEqual({ ok: true, value: undefined });
    // Drop + refused first attempt + the ladder's own second attempt; the
    // Retry added nothing.
    expect(capability.connectCalls).toHaveLength(3);
    expect(capability.openPtyCalls).toHaveLength(2);
    expect(controller.getSnapshot().phase).toBe('live');
  });

  it.each([
    ['AUTH_FAILED', 'Exhausted available authentication methods', 'Exhausted available authentication methods.'],
    ['INVALID_ARGUMENT', 'The SSH key passphrase is incorrect.', 'The SSH key passphrase is incorrect.'],
  ])('ends the ladder at a non-retryable %s and names the dials made and its own message (#2954, #2984)', async (code, message, shown) => {
    const capability = new FakeCapability();
    const { controller } = controllerFor(capability, trustStore(PIN), { retryDelaysMs: [0, 0, 0, 0, 0] });
    controllers.push(controller);
    await connectAndList(controller);
    capability.refuseLogins = { code, message };
    capability.emitLost();
    await waitFor(() => controller.getSnapshot().phase === 'lost');
    expect(capability.connectCalls).toHaveLength(1 + 1);
    expect(controller.getSnapshot().error).toBe(`Could not reconnect to 127.0.0.1 after 1 attempt. ${shown}`);
  });

  it('does not carry an earlier refused login into a later give-up (#2984)', async () => {
    const capability = new FakeCapability();
    const { controller } = controllerFor(capability, trustStore(PIN), { retryDelaysMs: [0, 0] });
    controllers.push(controller);
    await connectAndList(controller);
    await controller.switchSession(session('alpha'));
    capability.refuseLogins = { code: 'AUTH_FAILED', message: 'Exhausted available authentication methods' };
    capability.emitLost();
    await waitFor(() => controller.getSnapshot().phase === 'lost');

    // Logins work again, but every re-attach loses its transport.
    capability.refuseLogins = null;
    capability.openPty = async () => {
      throw new SshCapabilityError('SSH transport closed during attach.', 'CONNECTION_LOST');
    };
    expect((await controller.reconnect()).ok).toBe(false);
    expect(controller.getSnapshot().error).toBe('Could not reconnect to 127.0.0.1 after 2 attempts.');
  });

  it('counts every dial of a retryable ladder that ran out (#2984)', async () => {
    const capability = new FakeCapability();
    const { controller } = controllerFor(capability, trustStore(PIN), { retryDelaysMs: [0, 0] });
    controllers.push(controller);
    await connectAndList(controller);
    capability.refuseDials = true;
    capability.emitLost();
    await waitFor(() => controller.getSnapshot().phase === 'lost');
    expect(capability.connectCalls).toHaveLength(1 + 2);
    expect(controller.getSnapshot().error).toBe('Could not reconnect to 127.0.0.1 after 2 attempts.');
  });

  it('reports why a Retry could not recover and needs a host to retry against (#2954)', async () => {
    const capability = new FakeCapability();
    const { controller } = controllerFor(capability, trustStore(PIN), { retryDelaysMs: [0] });
    controllers.push(controller);
    expect(await controller.reconnect()).toMatchObject({ ok: false, reason: 'not-connected' });
    await connectAndList(controller);
    capability.refuseDials = true;
    capability.emitLost();
    await waitFor(() => controller.getSnapshot().phase === 'lost');
    expect(await controller.reconnect()).toMatchObject({ ok: false, reason: 'failed', message: expect.stringMatching(/after 1 attempt\./) });
    expect(capability.connectCalls).toHaveLength(1 + 1 + 1);
  });
});

describe('one reconnect per lost transport (pocketshell#2943)', () => {
  const controllers: ConnectionController[] = [];

  afterEach(async () => {
    await Promise.all(controllers.splice(0).map((controller) => controller.close()));
  });

  /** Count entries into `reconnecting`, the way the packaged journey's DOM recorder sees them. */
  function recordReconnectEntries(controller: ConnectionController) {
    const phases: string[] = [controller.getSnapshot().phase];
    controller.subscribe((snapshot) => {
      if (phases.at(-1) !== snapshot.phase) phases.push(snapshot.phase);
    });
    return {
      phases,
      reconnectEntries: () => phases.filter((phase) => phase === 'reconnecting').length,
    };
  }

  async function liveOnAlpha(capability: FakeCapability) {
    const { controller } = controllerFor(capability, trustStore(PIN));
    controllers.push(controller);
    await connectAndList(controller);
    expect((await controller.switchSession(session('alpha'))).ok).toBe(true);
    await waitFor(() => capability.pendingReads.length === 1);
    return controller;
  }

  /**
   * Make the next `sessions create` apply on the host, then lose that SSH
   * transport before its response, as the Docker fixture does: every later
   * exec on the lost connection also fails, so the controller's reconciling
   * list observes the loss and starts the reconnect.
   */
  function loseNextCreateResponse(capability: FakeCapability) {
    const exec = capability.exec;
    const lost = new Set<string>();
    let armed = true;
    capability.exec = async (options) => {
      if (lost.has(options.connectionId)) {
        throw new SshCapabilityError('SSH transport is closed.', 'CONNECTION_LOST');
      }
      if (armed && options.command.includes('sessions create')) {
        armed = false;
        lost.add(options.connectionId);
        capability.createRequests += 1;
        capability.sessions.push(session('created-once'));
        throw new SshCapabilityError('SSH transport was lost before the create response.', 'CONNECTION_LOST');
      }
      return exec(options);
    };
  }

  /** Hold the reconnect's teardown of the lost transport until the test releases it. */
  function holdTransportTeardown(capability: FakeCapability) {
    const gate = deferred<void>();
    const started = deferred<void>();
    const cancelOperation = capability.cancelOperation;
    capability.cancelOperation = async (options) => {
      if (options.target.kind === 'connection') {
        started.resolve();
        await gate.promise;
      }
      return cancelOperation(options);
    };
    return { gate, started };
  }

  it('does not re-enter reconnecting when a PTY resize fails while its close is still in flight', async () => {
    const capability = new FakeCapability();
    const controller = await liveOnAlpha(capability);
    const recorder = recordReconnectEntries(controller);

    const closeGate = deferred<void>();
    const closeStarted = deferred<void>();
    const closePty = capability.closePty;
    capability.closePty = async (options) => {
      closeStarted.resolve();
      await closeGate.promise;
      return closePty(options);
    };
    capability.resizePty = async () => {
      throw new SshCapabilityError('SSH transport closed.', 'CONNECTION_LOST');
    };
    const teardown = holdTransportTeardown(capability);
    loseNextCreateResponse(capability);

    const resize = controller.resizeTerminal(100, 30);
    await closeStarted.promise;
    const create = controller.createSession('created-once');
    await teardown.started.promise;
    closeGate.resolve();
    expect(await resize).toMatchObject({ ok: false });
    teardown.gate.resolve();
    expect(await create).toMatchObject({ ok: false });

    await waitFor(() => controller.getSnapshot().phase === 'live' && capability.connectCalls.length === 2);
    expect(recorder.reconnectEntries(), recorder.phases.join(' -> ')).toBe(1);
    expect(recorder.phases.slice(recorder.phases.indexOf('reconnecting'))).not.toContain('error');
    expect(capability.connectCalls).toHaveLength(2);
    // The create may be refused as not-connected once the resize has already
    // started the reconnect; it must never be replayed.
    expect(capability.createRequests).toBeLessThanOrEqual(1);
    expect(controller.getSnapshot().selectedSession?.name).toBe('alpha');
  });

  it('does not re-enter reconnecting when a terminal write fails while its close is still in flight', async () => {
    const capability = new FakeCapability();
    const controller = await liveOnAlpha(capability);
    const recorder = recordReconnectEntries(controller);

    const closeGate = deferred<void>();
    const closeStarted = deferred<void>();
    const closePty = capability.closePty;
    capability.closePty = async (options) => {
      closeStarted.resolve();
      await closeGate.promise;
      return closePty(options);
    };
    capability.nextWriteError = new SshCapabilityError('SSH transport closed.', 'CONNECTION_LOST');
    const teardown = holdTransportTeardown(capability);
    loseNextCreateResponse(capability);

    const write = controller.writeTerminalBytes(new TextEncoder().encode('\x1b[0n'));
    await closeStarted.promise;
    const create = controller.createSession('created-once');
    await teardown.started.promise;
    closeGate.resolve();
    expect(await write).toMatchObject({ ok: false });
    teardown.gate.resolve();
    expect(await create).toMatchObject({ ok: false });

    await waitFor(() => controller.getSnapshot().phase === 'live' && capability.connectCalls.length === 2);
    expect(recorder.reconnectEntries(), recorder.phases.join(' -> ')).toBe(1);
    expect(capability.connectCalls).toHaveLength(2);
    expect(capability.writeCalls).toHaveLength(1);
  });

  it('ignores a PTY EOF whose output consumer finishes after the reconnect has started', async () => {
    const capability = new FakeCapability();
    const controller = await liveOnAlpha(capability);
    const channelId = capability.pendingReads[0]!.options.channelId;
    const recorder = recordReconnectEntries(controller);

    const consumerGate = deferred<void>();
    const consumerStarted = deferred<void>();
    controller.subscribeTerminalOutput(async () => {
      consumerStarted.resolve();
      await consumerGate.promise;
    });
    const teardown = holdTransportTeardown(capability);
    loseNextCreateResponse(capability);

    capability.emitOutput(channelId, new TextEncoder().encode('last bytes'), true);
    await consumerStarted.promise;
    const create = controller.createSession('created-once');
    await teardown.started.promise;
    consumerGate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    teardown.gate.resolve();
    expect(await create).toMatchObject({ ok: false });

    await waitFor(() => controller.getSnapshot().phase === 'live' && capability.connectCalls.length === 2);
    expect(recorder.reconnectEntries(), recorder.phases.join(' -> ')).toBe(1);
    expect(recorder.phases.slice(recorder.phases.indexOf('reconnecting'))).not.toContain('error');
    expect(capability.connectCalls).toHaveLength(2);
  });

  it('does not start a second reconnect when a lost create response arrives after the reconnect finished', async () => {
    const capability = new FakeCapability();
    const controller = await liveOnAlpha(capability);
    const recorder = recordReconnectEntries(controller);

    const createGate = deferred<void>();
    const createStarted = deferred<void>();
    const exec = capability.exec;
    capability.exec = async (options) => {
      if (options.command.includes('sessions create')) {
        capability.createRequests += 1;
        capability.sessions.push(session('created-once'));
        createStarted.resolve();
        await createGate.promise;
        throw new SshCapabilityError('SSH transport was lost before the create response.', 'CONNECTION_LOST');
      }
      return exec(options);
    };

    const create = controller.createSession('created-once');
    await createStarted.promise;
    capability.emitLost();
    await waitFor(() => controller.getSnapshot().phase === 'live' && capability.connectCalls.length === 2);
    createGate.resolve();
    expect(await create).toMatchObject({ ok: false });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(capability.connectCalls).toHaveLength(2);
    expect(recorder.reconnectEntries(), recorder.phases.join(' -> ')).toBe(1);
    expect(controller.getSnapshot().phase).toBe('live');
    expect(controller.getSnapshot().uncertainMutation).toMatchObject({ kind: 'create-session', target: 'created-once' });
  });

  it('does not start a second reconnect when a session attach fails after the reconnect replaced its transport', async () => {
    const capability = new FakeCapability();
    const controller = await liveOnAlpha(capability);
    const recorder = recordReconnectEntries(controller);

    const openGate = deferred<void>();
    const openStarted = deferred<void>();
    const openPty = capability.openPty;
    let staleOpenArmed = true;
    capability.openPty = async (options) => {
      if (staleOpenArmed) {
        staleOpenArmed = false;
        openStarted.resolve();
        await openGate.promise;
        throw new SshCapabilityError('SSH transport closed during attach.', 'CONNECTION_LOST');
      }
      return openPty(options);
    };

    const staleSwitch = controller.switchSession(session('beta'));
    await openStarted.promise;
    capability.emitLost();
    await waitFor(() => controller.getSnapshot().phase === 'live' && capability.connectCalls.length === 2);
    openGate.resolve();
    expect(await staleSwitch).toMatchObject({ ok: false });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(capability.connectCalls).toHaveLength(2);
    expect(recorder.reconnectEntries(), recorder.phases.join(' -> ')).toBe(1);
    expect(controller.getSnapshot().phase).toBe('live');
    expect(controller.getSnapshot().selectedSession?.name).toBe('beta');
  });

  it('keeps a stale session-list failure from rewriting the phase of a reconnect in progress', async () => {
    const capability = new FakeCapability();
    const controller = await liveOnAlpha(capability);
    const recorder = recordReconnectEntries(controller);

    const listGate = deferred<void>();
    const listStarted = deferred<void>();
    const exec = capability.exec;
    let staleListArmed = true;
    capability.exec = async (options) => {
      if (staleListArmed && options.command.includes('sessions list')) {
        staleListArmed = false;
        listStarted.resolve();
        await listGate.promise;
        throw new SshCapabilityError('SSH transport was lost during list.', 'CONNECTION_LOST');
      }
      return exec(options);
    };
    const connectGate = deferred<void>();
    const connect = capability.connect;
    capability.connect = async (options) => {
      await connectGate.promise;
      return connect(options);
    };

    const staleRefresh = controller.refreshSessions();
    await listStarted.promise;
    capability.emitLost();
    await waitFor(() => controller.getSnapshot().phase === 'connecting');
    listGate.resolve();
    expect(await staleRefresh).toMatchObject({ ok: false });
    expect(controller.getSnapshot().phase).toBe('connecting');
    connectGate.resolve();

    await waitFor(() => controller.getSnapshot().phase === 'live' && capability.connectCalls.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(capability.connectCalls).toHaveLength(2);
    expect(recorder.reconnectEntries(), recorder.phases.join(' -> ')).toBe(1);
  });
  it('treats a PTY EOF from a dying transport as a lost link and re-attaches the same session (#2954)', async () => {
    const capability = new FakeCapability();
    const controller = await liveOnAlpha(capability);
    const channelId = capability.pendingReads[0]!.options.channelId;
    const recorder = recordReconnectEntries(controller);
    const [connectionId] = [...capability.connections.keys()];

    // The transport dies and closes its channels; the EOF reaches the
    // controller before (here: instead of) the native lost event.
    capability.connections.delete(connectionId!);
    capability.emitOutput(channelId, new Uint8Array(), true);

    await waitFor(() => controller.getSnapshot().phase === 'live' && capability.connectCalls.length === 2);
    // Never "the session ended" (live -> connected) before the recovery.
    expect(recorder.phases.slice(0, recorder.phases.indexOf('reconnecting'))).toEqual(['live']);
    expect(recorder.reconnectEntries(), recorder.phases.join(' -> ')).toBe(1);
    expect(controller.getSnapshot().selectedSession?.name).toBe('alpha');
    expect(controller.getSnapshot().error).toBeNull();
    expect(capability.openPtyCalls).toHaveLength(2);
  });

  it('still reports a session that ended on a healthy transport as ended, without reconnecting (#2954)', async () => {
    const capability = new FakeCapability();
    const controller = await liveOnAlpha(capability);
    const channelId = capability.pendingReads[0]!.options.channelId;

    capability.emitOutput(channelId, new Uint8Array(), true);
    await waitFor(() => controller.getSnapshot().phase === 'connected');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(controller.getSnapshot().error).toBe('Session “alpha” ended.');
    expect(capability.connectCalls).toHaveLength(1);
  });
});
