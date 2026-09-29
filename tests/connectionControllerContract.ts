/**
 * Runtime-neutral connection policy contract. Vitest, the Chromium browser
 * build, and the Node-vm/QuickJS embed verifier run the same assertions
 * against the core, so runtime-specific failures cannot hide behind mocks.
 */
export async function runConnectionControllerContract(Core: any): Promise<string> {
  let assertions = 0;
  const check = (condition: unknown, message: string): void => {
    if (!condition) throw new Error(message);
    assertions += 1;
  };
  const equal = (actual: unknown, expected: unknown, message: string): void => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${message}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    }
    assertions += 1;
  };

  const pin = { keyType: 'ssh-ed25519', keyB64: 'AQIDBA==' };
  const presented = { ...pin, fingerprintSha256: 'SHA256:abc123' };
  const acceptedPin = { kind: 'wire-key', ...presented };
  const makeSession = (name: string) => ({
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
  });

  class FakeCapability {
    listeners = new Set<(event: any) => void>();
    connections = new Map<string, string>();
    ptys = new Map<string, any>();
    forwards = new Map<string, any>();
    sessions = [makeSession('alpha'), makeSession('beta')];
    connectCalls: any[] = [];
    execCommands: string[] = [];
    openPtyCalls: any[] = [];
    closePtyCalls: any[] = [];
    writeCalls: any[] = [];
    resizeCalls: any[] = [];
    pendingReads: any[] = [];
    queuedOutput = new Map<string, any[]>();
    scheduledClose = new Set<string>();
    connectionOrdinal = 0;
    ptyOrdinal = 0;
    cancelCalls: any[] = [];
    holdNextConnect = false;
    heldConnect: { options: any; resolve: (result: any) => void } | null = null;
    nextConnectResultHostKey: any = null;
    bypassExpectedKeyForNextConnect = false;
    createRequests = 0;
    killRequests = 0;
    createAfterApplyFailure = false;
    killAfterApplyFailure = false;
    nextWriteError: unknown = null;

    addListener = async (_name: string, listener: (event: any) => void) => {
      this.listeners.add(listener);
      return { remove: async () => { this.listeners.delete(listener); } };
    };

    connect = (options: any) => {
      this.connectCalls.push(options);
      if (this.holdNextConnect) {
        this.holdNextConnect = false;
        return new Promise((resolve) => { this.heldConnect = { options, resolve }; });
      }
      return this.finishConnect(options);
    };

    finishConnect = (options: any, returnedHostKey?: any, enforceExpectedKey = true) => {
      const actualHostKey = returnedHostKey ?? this.nextConnectResultHostKey ?? presented;
      const bypassPin = !enforceExpectedKey || this.bypassExpectedKeyForNextConnect;
      this.nextConnectResultHostKey = null;
      this.bypassExpectedKeyForNextConnect = false;
      const verdict = Core.verifyHostKeyTrustPin(options.expectedHostKey, actualHostKey);
      if (!bypassPin && verdict !== 'trusted') {
        throw new Core.SshCapabilityError('Host key needs a user decision.', 'HOST_KEY_REJECTED', actualHostKey);
      }
      const connectionId = `connection-${++this.connectionOrdinal}`;
      this.connections.set(connectionId, options.generationId);
      return { requestId: options.requestId, connectionId, generationId: options.generationId, hostKey: actualHostKey };
    };

    resolveHeldConnect = (hostKey: any = presented) => {
      if (!this.heldConnect) throw new Error('No held connect operation.');
      const held = this.heldConnect;
      this.heldConnect = null;
      held.resolve(this.finishConnect(held.options, hostKey, false));
    };

    getConnectionState = async (ref: any) => ({
      requestId: ref.requestId,
      state: this.connections.has(ref.connectionId) ? 'connected' : 'closed',
    });

    closeConnection = async (ref: any) => {
      this.connections.delete(ref.connectionId);
      for (const pty of [...this.ptys.values()]) {
        if (pty.connectionId === ref.connectionId) this.closePtyRef(pty);
      }
      this.scheduledClose.delete(ref.connectionId);
      return { requestId: ref.requestId };
    };

    cancelOperation = async (options: any) => {
      this.cancelCalls.push(options);
      if (options.target.kind === 'connection') {
        this.connections.delete(options.target.connectionId);
        for (const pty of [...this.ptys.values()]) {
          if (pty.connectionId === options.target.connectionId) this.closePtyRef(pty);
        }
        this.scheduledClose.delete(options.target.connectionId);
      }
      return { requestId: options.requestId, cancelled: true };
    };

    scheduleClose = async (ref: any) => {
      this.scheduledClose.add(ref.connectionId);
      return { requestId: ref.requestId };
    };

    cancelScheduledClose = async (ref: any) => ({
      requestId: ref.requestId,
      cancelled: this.scheduledClose.delete(ref.connectionId),
    });

    exec = async (options: any) => {
      this.execCommands.push(options.command);
      const response = (stdout = '', exitCode: number | null = 0, stderr = '') => ({
        requestId: options.requestId,
        connectionId: options.connectionId,
        generationId: options.generationId,
        exitCode,
        stdout,
        stderr,
        timedOut: false,
      });
      if (options.command === 'pocketshell sessions list --json') {
        const rows = this.sessions.map(({ name, id, workspace, attached }) => ({ name, id, workspace, attached }));
        return response(JSON.stringify({ schema: 3, sessions: rows, errors: [] }));
      }
      if (options.command.includes('sessions create')) {
        this.createRequests += 1;
        const name = options.command.split(' -- ').at(-1)?.replace(/^'|'$/g, '') ?? 'created';
        if (this.createAfterApplyFailure) {
          this.createAfterApplyFailure = false;
          this.sessions.push(makeSession(name));
          throw new Core.HostCliFailed(options.command, null, '', false, 'SSH transport ended after host applied create.');
        }
        this.sessions.push(makeSession(name));
        return response(JSON.stringify({ schema: 3, name, id: `${name}-id`, created: true }));
      }
      if (options.command.includes('sessions kill')) {
        this.killRequests += 1;
        const name = options.command.split(' -- ').at(-1)?.replace(/^'|'$/g, '') ?? '';
        if (this.killAfterApplyFailure) {
          this.killAfterApplyFailure = false;
          const index = this.sessions.findIndex((row) => row.name === name);
          if (index >= 0) this.sessions.splice(index, 1);
          throw new Core.HostCliFailed(options.command, null, '', false, 'SSH transport ended after host applied kill.');
        }
        return response();
      }
      throw new Error(`Unexpected HostCliCore command: ${options.command}`);
    };

    openPty = async (options: any) => {
      this.openPtyCalls.push(options);
      const pty = {
        connectionId: options.connectionId,
        generationId: options.generationId,
        channelId: `pty-${++this.ptyOrdinal}`,
      };
      this.ptys.set(pty.channelId, pty);
      return { ...pty, requestId: options.requestId };
    };

    readPty = async (options: any) => {
      const queued = this.queuedOutput.get(options.channelId)?.shift();
      if (queued) return this.readResult(options, queued.bytes, queued.eof);
      return new Promise((resolve) => this.pendingReads.push({ options, resolve }));
    };

    writePty = async (options: any) => {
      this.writeCalls.push(options);
      if (this.nextWriteError) {
        const error = this.nextWriteError;
        this.nextWriteError = null;
        throw error;
      }
      return { ...options };
    };

    resizePty = async (options: any) => {
      this.resizeCalls.push(options);
      return { ...options };
    };

    closePty = async (options: any) => {
      this.closePtyCalls.push(options);
      this.closePtyRef(options);
      return { requestId: options.requestId };
    };

    sftpList = async (options: any) => ({ requestId: options.requestId, entries: [] });
    sftpRead = async (options: any) => ({ requestId: options.requestId, dataBase64: '' });
    sftpWrite = async (options: any) => ({ requestId: options.requestId, bytesWritten: 0 });
    sftpMkdir = async (options: any) => ({ requestId: options.requestId });
    sftpRename = async (options: any) => ({ requestId: options.requestId });
    sftpDelete = async (options: any) => ({ requestId: options.requestId });

    openPortForward = async (options: any) => {
      const forward = {
        connectionId: options.connectionId,
        generationId: options.generationId,
        forwardId: `forward-${this.forwards.size + 1}`,
        localPort: options.localPort ?? 4000,
      };
      this.forwards.set(forward.forwardId, forward);
      return { ...forward, requestId: options.requestId };
    };

    closePortForward = async (options: any) => {
      this.forwards.delete(options.forwardId);
      return { requestId: options.requestId };
    };

    resourceSnapshot = async (requestId: string) => ({
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
      pending.resolve(this.readResult(pending.options, bytes, eof));
    }

    emitLost(reason = 'socket reset'): void {
      const entries = [...this.connections.entries()];
      const [connectionId, generationId] = entries[entries.length - 1] ?? [];
      if (!connectionId || !generationId) throw new Error('No connected fake SSH connection to drop.');
      for (const listener of this.listeners) {
        listener({ connectionId, generationId, state: 'lost', reason });
      }
    }

    readResult(options: any, bytes: Uint8Array, eof: boolean): any {
      return {
        requestId: options.requestId,
        connectionId: options.connectionId,
        generationId: options.generationId,
        channelId: options.channelId,
        sequence: options.sequence + (bytes.length > 0 ? 1 : 0),
        dataBase64: Core.bytesToBase64(bytes),
        eof,
      };
    }

    closePtyRef(pty: any): void {
      this.ptys.delete(pty.channelId);
      for (let index = this.pendingReads.length - 1; index >= 0; index -= 1) {
        const pending = this.pendingReads[index];
        if (pending.options.channelId === pty.channelId) {
          this.pendingReads.splice(index, 1);
          pending.resolve(this.readResult(pending.options, new Uint8Array(), true));
        }
      }
    }
  }

  const host = {
    hostId: 'fixture-host',
    hostname: '127.0.0.1',
    port: 2222,
    username: 'testuser',
    credential: { kind: 'private-key', privateKeyPem: 'test-private-key' },
  };
  const makeTrustStore = (initial: any = null) => {
    let stored = initial;
    return {
      store: {
        get: async () => stored,
        record: async (_hostId: string, next: any) => { stored = next; },
      },
      current: () => stored,
    };
  };
  const createController = (capability: FakeCapability, trust: ReturnType<typeof makeTrustStore>, options: any = {}) => {
    let id = 0;
    return new Core.ConnectionController({
      capability,
      trustStore: trust.store,
      createId: () => `contract-${++id}`,
      retryDelaysMs: [0],
      delay: async () => undefined,
      ...options,
    });
  };
  const waitFor = async (predicate: () => boolean, reason: string): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return;
      await Promise.resolve();
    }
    throw new Error(`Contract wait timed out: ${reason}`);
  };
  const list = async (controller: any): Promise<any> => {
    check((await controller.connect(host)).ok, 'trusted connection should succeed');
    const result = await controller.refreshSessions();
    check(result.ok, 'HostCliCore should parse schema-3 sessions');
    equal(result.value.sessions.map((row: any) => row.name), ['alpha', 'beta'], 'HostCliCore session names');
    return result;
  };

  let malformedTrustReads = 0;
  const malformedCapability = new FakeCapability();
  const malformedController = createController(malformedCapability, {
    store: {
      get: async () => { malformedTrustReads += 1; return acceptedPin; },
      record: async () => undefined,
    },
    current: () => acceptedPin,
  });
  for (const credential of [
    { kind: 'key-handle', handleId: ' \t', passphrase: 'short-lived-passphrase' },
    { kind: 'key-handle', handleId: 'native-key-1', passphrase: 7 },
    { kind: 'key-handle', handleId: 'native-key-1', privateKeyPem: 'must-not-cross-this-contract' },
  ]) {
    const result = await malformedController.connect({ ...host, credential });
    check(!result.ok && result.reason === 'failed', 'malformed key handle is rejected');
  }
  equal(malformedCapability.connectCalls.length, 0, 'malformed handles never reach SshCapability');
  equal(malformedTrustReads, 0, 'malformed handles do not read or change host trust');
  equal(malformedController.getSnapshot().revision, 0, 'malformed handles leave controller state untouched');
  equal(malformedController.getSnapshot().hostId, null, 'malformed handles do not replace host identity');
  await malformedController.close();

  const trustCredential = Object.freeze({ kind: 'key-handle', handleId: 'native-key:trust-11' });
  const trustHost = { ...host, hostId: 'host-with-untrusted-native-key', credential: trustCredential };
  const trustCapability = new FakeCapability();
  const trustController = createController(trustCapability, makeTrustStore());
  const keyTrustResult = await trustController.connect(trustHost);
  equal(keyTrustResult.reason, 'trust-required', 'key handles keep the host-key trust prompt');
  equal(trustController.getSnapshot().trustDecision.hostId, trustHost.hostId, 'key handle trust is scoped to the original host identity');
  const trustRetryPassphrase = 'fresh-trust-retry-passphrase';
  check((await trustController.acceptPresentedHostKey({ passphrase: trustRetryPassphrase })).ok, 'accepted key-handle host key reconnects');
  equal(trustCapability.connectCalls[1].hostId, trustHost.hostId, 'trust acceptance preserves key-handle host identity');
  equal(trustCapability.connectCalls[1].credential.handleId, trustCredential.handleId, 'trust acceptance forwards the same opaque key handle');
  equal(trustCapability.connectCalls[1].credential.passphrase, trustRetryPassphrase, 'trust acceptance forwards the fresh transient passphrase');
  trustCapability.emitLost();
  await waitFor(() => trustCapability.connectCalls.length === 3, 'trust-accepted key handle reconnect reaches capability');
  equal(trustCapability.connectCalls[2].hostId, trustHost.hostId, 'post-trust reconnect preserves host identity');
  check(!('passphrase' in trustCapability.connectCalls[2].credential), 'trust-retry passphrase is not retained for reconnect');
  await trustController.close();

  const transientCredential = Object.freeze({
    kind: 'key-handle',
    handleId: 'native-key:fixture-17',
    passphrase: 'one-attempt-passphrase',
  });
  const transientHost = { ...host, hostId: 'host-with-native-key', credential: transientCredential };
  const transientCapability = new FakeCapability();
  const transientController = createController(transientCapability, makeTrustStore(acceptedPin));
  check((await transientController.connect(transientHost)).ok, 'valid key handle connects');
  const transientConnect = transientCapability.connectCalls[0];
  equal(transientConnect.hostId, transientHost.hostId, 'key handle keeps the caller host identity');
  check(transientConnect.credential === transientCredential, 'key handle and transient passphrase are forwarded unchanged');
  equal(transientConnect.credential.passphrase, 'one-attempt-passphrase', 'transient passphrase is forwarded');
  check(!('privateKeyPem' in transientConnect.credential), 'core does not resolve handle into private-key bytes');
  transientCapability.emitLost();
  await waitFor(() => transientCapability.connectCalls.length === 2, 'transient key handle reconnect reaches capability');
  equal(transientCapability.connectCalls[1].hostId, transientHost.hostId, 'transient key reconnect keeps host identity');
  equal(transientCapability.connectCalls[1].credential.handleId, transientCredential.handleId, 'transient key reconnect retains its opaque handle');
  check(!('passphrase' in transientCapability.connectCalls[1].credential), 'transient passphrase is cleared after its connection attempt');
  await transientController.close();

  const reconnectCredential = Object.freeze({ kind: 'key-handle', handleId: 'native-key:reconnect-4' });
  const reconnectHost = { ...host, hostId: 'stable-native-key-host', credential: reconnectCredential };
  const reconnectCapability = new FakeCapability();
  const reconnectController = createController(reconnectCapability, makeTrustStore(acceptedPin));
  check((await reconnectController.connect(reconnectHost)).ok, 'key handle initial connection');
  reconnectCapability.emitLost();
  await waitFor(() => reconnectCapability.connectCalls.length === 2, 'key-handle reconnect reaches capability');
  equal(reconnectCapability.connectCalls[1].hostId, reconnectHost.hostId, 'reconnect keeps host identity');
  check(reconnectCapability.connectCalls[1].credential === reconnectCredential, 'reconnect forwards the unchanged opaque handle');
  await reconnectController.close();

  for (const [label, credential] of [
    ['PEM', { kind: 'private-key', privateKeyPem: 'existing-private-key' }],
    ['password', { kind: 'password', password: 'existing-password' }],
  ] as const) {
    const legacyCapability = new FakeCapability();
    const legacyController = createController(legacyCapability, makeTrustStore(acceptedPin));
    const legacyHost = { ...host, credential };
    check((await legacyController.connect(legacyHost)).ok, `${label} credential still connects`);
    check(legacyCapability.connectCalls[0].credential === credential, `${label} credential is forwarded unchanged`);
    await legacyController.close();
  }

  const unknownCapability = new FakeCapability();
  const unknownTrust = makeTrustStore();
  const unknownController = createController(unknownCapability, unknownTrust);
  const unknown = await unknownController.connect(host);
  equal(unknown.reason, 'trust-required', 'unknown host key verdict');
  equal(unknownController.getSnapshot().trustDecision.reason, 'unknown', 'unknown trust prompt');
  equal(unknownCapability.connections.size, 0, 'unknown key must not connect');
  check((await unknownController.acceptPresentedHostKey()).ok, 'accepted unknown key reconnect');
  equal(unknownTrust.current(), acceptedPin, 'accepted key pin');
  await unknownController.close();

  const oldFingerprint = Core.fromAndroidTrustedHostKeySha256(presented.fingerprintSha256);
  equal(Core.toAndroidTrustedHostKeySha256(oldFingerprint), presented.fingerprintSha256, 'Android SHA-256 trust value round-trip');
  const legacyController = createController(new FakeCapability(), makeTrustStore(oldFingerprint));
  check((await legacyController.connect(host)).ok, 'existing Android SHA-256 pin connects');
  equal(legacyController.getSnapshot().phase, 'connected', 'legacy SHA-256 pin remains trusted');
  await legacyController.close();
  const changedLegacyTrust = makeTrustStore(Core.fromAndroidTrustedHostKeySha256('SHA256:old-pin'));
  const changedLegacy = createController(new FakeCapability(), changedLegacyTrust);
  equal((await changedLegacy.connect(host)).reason, 'trust-mismatch', 'changed legacy Android fingerprint is rejected');
  equal(changedLegacy.getSnapshot().trustDecision.previouslyTrusted.fingerprintSha256, 'SHA256:old-pin', 'legacy mismatch retains previous fingerprint');
  check((await changedLegacy.acceptPresentedHostKey()).ok, 'accepting changed legacy pin reconnects');
  equal(changedLegacyTrust.current(), Core.fromAndroidTrustedHostKeySha256(presented.fingerprintSha256), 'rotated Android fingerprint remains in legacy storage format');
  await changedLegacy.close();

  const mismatchCapability = new FakeCapability();
  const mismatchController = createController(mismatchCapability, makeTrustStore({
    kind: 'wire-key', keyType: 'ssh-rsa', keyB64: 'different', fingerprintSha256: 'SHA256:different',
  }));
  const mismatch = await mismatchController.connect(host);
  equal(mismatch.reason, 'trust-mismatch', 'changed host key verdict');
  equal(mismatchController.getSnapshot().trustDecision.reason, 'mismatch', 'mismatch trust prompt');
  check((await mismatchController.acceptPresentedHostKey()).ok, 'accepted changed key reconnect');
  equal(mismatchController.getSnapshot().trustDecision, null, 'accepted replacement clears trust prompt');
  await mismatchController.close();

  const wrongSuccessCapability = new FakeCapability();
  wrongSuccessCapability.nextConnectResultHostKey = { ...presented, keyB64: 'BQ==', fingerprintSha256: 'SHA256:wrong' };
  wrongSuccessCapability.bypassExpectedKeyForNextConnect = true;
  const wrongSuccessController = createController(wrongSuccessCapability, makeTrustStore(acceptedPin));
  equal((await wrongSuccessController.connect(host)).reason, 'trust-mismatch', 'successful handshake with wrong returned key fails closed');
  equal(wrongSuccessController.getSnapshot().phase, 'awaiting-trust', 'wrong returned key publishes a mismatch prompt');
  equal(wrongSuccessController.getSnapshot().connectionId, null, 'wrong returned key is never adopted');
  equal(wrongSuccessCapability.connections.size, 0, 'wrong returned key connection is explicitly closed');
  check(wrongSuccessCapability.cancelCalls.some((call) => call.target.kind === 'connection'), 'wrong returned key generation is cancelled');
  await wrongSuccessController.close();

  const lateCapability = new FakeCapability();
  lateCapability.holdNextConnect = true;
  const lateController = createController(lateCapability, makeTrustStore(acceptedPin));
  const observedPhases: string[] = [];
  lateController.subscribe((snapshot: any) => observedPhases.push(snapshot.phase));
  const lateConnect = lateController.connect(host);
  await waitFor(() => lateCapability.heldConnect !== null, 'pending connect reaches capability');
  const lateRequestId = lateCapability.connectCalls[0].requestId;
  await lateController.close();
  check(lateCapability.cancelCalls.some((call) => call.target.kind === 'connect' && call.target.targetRequestId === lateRequestId), 'close cancels pending dial by request id');
  lateCapability.resolveHeldConnect();
  equal((await lateConnect).ok, false, 'late connect resolves as cancelled');
  equal(lateController.getSnapshot().phase, 'idle', 'late connect cannot replace closed snapshot');
  check(!observedPhases.includes('connected'), 'late connect is never published as connected');
  equal(lateCapability.connections.size, 0, 'late successful connection is explicitly closed');

  const capability = new FakeCapability();
  const clock = { now: 1000 };
  const controller = createController(capability, makeTrustStore(pin), { now: () => clock.now });
  await list(controller);
  equal(capability.execCommands[0], 'pocketshell sessions list --json', 'versioned HostCliCore command');
  check((await controller.switchSession(makeSession('alpha'))).ok, 'attach alpha');
  check((await controller.switchSession(makeSession('beta'))).ok, 'switch to beta');
  equal(capability.connectCalls.length, 1, 'session switching reuses SSH connection');
  equal(capability.closePtyCalls.length, 1, 'session switch closes previous PTY');
  check(capability.openPtyCalls[1].command.includes("'beta'"), 'HostCliCore safely builds attach command');

  const activePtys = [...capability.ptys.values()];
  const activePty = activePtys[activePtys.length - 1];
  await waitFor(() => capability.pendingReads.some((pending) => pending.options.channelId === activePty.channelId), 'first PTY read');
  let releaseOutput!: () => void;
  let outputStarted!: () => void;
  const outputGate = new Promise<void>((resolve) => { releaseOutput = resolve; });
  const outputStartedPromise = new Promise<void>((resolve) => { outputStarted = resolve; });
  controller.subscribeTerminalOutput(async (_session: any, bytes: Uint8Array) => {
    equal(Core.bytesToBase64(bytes), 'aGVsbG8=', 'PTY bytes are forwarded without loss');
    outputStarted();
    await outputGate;
  });
  capability.emitOutput(activePty.channelId, new Uint8Array([104, 101, 108, 108, 111]));
  await outputStartedPromise;
  equal(capability.pendingReads.length, 0, 'output pump waits for consumer backpressure');
  releaseOutput();
  await waitFor(() => capability.pendingReads.some((pending) => pending.options.channelId === activePty.channelId), 'next PTY read after consumer');

  const write = controller.writeTerminalBytes(new Uint8Array([108, 115, 10]));
  const resize = controller.resizeTerminal(120, 36);
  check((await write).ok, 'terminal input result');
  check((await resize).ok, 'terminal resize result');
  equal(capability.writeCalls[0].sequence, 1, 'first PTY operation sequence');
  equal(capability.resizeCalls[0].sequence, 2, 'resize follows terminal write');
  equal(capability.resizeCalls[0].cols, 120, 'resize columns');

  const originalConnection = controller.getSnapshot().connectionId;
  const originalGeneration = controller.getSnapshot().generationId;
  capability.emitLost();
  await waitFor(() => capability.connectCalls.length === 2 && controller.getSnapshot().phase === 'live', 'transport reconnect and reattach');
  check(controller.getSnapshot().connectionId !== originalConnection, 'reconnect replaces spent connection');
  equal(controller.getSnapshot().selectedSession.name, 'beta', 'reconnect restores selected session identity');
  equal(capability.openPtyCalls.length, 3, 'reconnect attaches selected session exactly once');
  const afterReconnectCalls = capability.connectCalls.length;
  for (const listener of capability.listeners) {
    listener({ connectionId: originalConnection, generationId: originalGeneration, state: 'lost', reason: 'stale event' });
  }
  await Promise.resolve();
  equal(capability.connectCalls.length, afterReconnectCalls, 'stale generation event cannot trigger a reconnect');

  await controller.enterBackground(10_000);
  clock.now += 5_000;
  await controller.returnToForeground();
  equal(capability.connectCalls.length, afterReconnectCalls, 'within grace keeps the connection');
  await controller.enterBackground(10_000);
  clock.now += 10_001;
  await controller.returnToForeground();
  equal(capability.connectCalls.length, afterReconnectCalls + 1, 'expired grace reconnects');
  equal(controller.getSnapshot().phase, 'live', 'expired grace reattaches selected session');

  capability.createAfterApplyFailure = true;
  check(!(await controller.createSession('created-once')).ok, 'ambiguous create reports uncertain outcome');
  equal(capability.createRequests, 1, 'ambiguous create is not retried');
  equal(controller.getSnapshot().uncertainMutation.state, 'observed-applied', 'create reconciles through session listing');
  controller.clearUncertainMutation();
  capability.killAfterApplyFailure = true;
  check(!(await controller.killSession('alpha')).ok, 'ambiguous kill reports uncertain outcome');
  equal(capability.killRequests, 1, 'ambiguous kill is not retried');
  equal(controller.getSnapshot().uncertainMutation.state, 'observed-applied', 'kill reconciles through session listing');

  capability.nextWriteError = new Core.SshCapabilityError('Transport ended during PTY write.', 'CONNECTION_LOST');
  check(!(await controller.writeTerminalBytes(new Uint8Array([101, 99, 104, 111, 10]))).ok, 'uncertain input reports failure');
  await waitFor(() => controller.getSnapshot().phase === 'live' && capability.connectCalls.length === afterReconnectCalls + 2, 'reconnect after uncertain PTY write');
  equal(capability.writeCalls.length, 2, 'uncertain terminal input is never resent');
  const stillLive = await controller.getResourceSnapshot();
  equal(stillLive.ptys, 1, 'reattached PTY exists before close');
  await controller.close();
  check(capability.cancelCalls.some((call) => call.target.kind === 'connection'), 'close cancels active generation');
  const closed = await capability.resourceSnapshot('contract-after-close');
  equal(
    [closed.connections, closed.ptys, closed.sftpClients, closed.forwards],
    [0, 0, 0, 0],
    'connection and channel resources close explicitly',
  );
  return `assertions=${assertions}`;
}
