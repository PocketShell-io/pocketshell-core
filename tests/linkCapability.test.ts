import { describe, expect, it, vi } from 'vitest';
import {
  SshCapabilityError,
  canonicalRelayUrl,
  createLinkCapability,
  linkHostKeyFingerprint,
  sha256Hex,
  type LinkSocket,
  type LinkSocketFactory,
  type LinkSocketHandlers,
  type SshConnectionStateEvent,
  type SshExecResult,
} from '../src';

const RELAY = 'wss://relay.example:8765';
const TOKEN = 'test-token';
const HOST_ID = 'laptop';

/**
 * In-memory link endpoint standing in for relay + host together: it speaks
 * the client side of protocol v1 and scripts the host's answers. Channel ids
 * here are already in the client's namespace, exactly as the relay leaves
 * them after rewriting.
 */
class FakeLinkHost {
  readonly url: string | null = null;
  readonly sent: Array<string | Uint8Array> = [];
  private handlers: LinkSocketHandlers | null = null;
  private opened = false;
  paired = true;
  failWith: { code: string; message: string } | null = null;
  /** When true, exec channels get their output and exit immediately. */
  autoExec = true;
  /** When true, pty channels echo every write back and exit on close. */
  autoPty = true;
  exited = new Set<number>();

  get socketFactory(): LinkSocketFactory {
    return (url: string, handlers: LinkSocketHandlers): LinkSocket => {
      (this as { url: string | null }).url = url;
      this.handlers = handlers;
      return {
        send: (data) => {
          this.sent.push(data);
          this.onClientSend(data);
        },
        close: () => undefined,
      };
    };
  }

  /** Simulate the WebSocket finishing its HTTP upgrade. */
  openSocket(): void {
    this.opened = true;
    this.handlers?.onOpen();
  }

  /** Simulate the remote side dropping the socket. */
  dropSocket(code = 1006, reason = 'abnormal closure'): void {
    this.handlers?.onClose(code, reason);
  }

  hostSendText(text: string): void {
    this.handlers?.onMessage(text);
  }

  hostSendBinary(channel: number, payload: Uint8Array): void {
    const frame = new Uint8Array(4 + payload.length);
    new DataView(frame.buffer).setUint32(0, channel, false);
    frame.set(payload, 4);
    this.handlers?.onMessage(frame);
  }

  controlFrames(): Array<Record<string, unknown>> {
    return this.sent
      .filter((data): data is string => typeof data === 'string')
      .map((text) => JSON.parse(text) as Record<string, unknown>);
  }

  private onClientSend(data: string | Uint8Array): void {
    if (typeof data !== 'string' || !this.opened) return;
    const frame = JSON.parse(data) as Record<string, unknown>;
    const channel = frame.ch as number;
    if (frame.t === 'hello') {
      if (this.failWith !== null) {
        this.hostSendText(JSON.stringify({ v: 1, t: 'error', ...this.failWith }));
        return;
      }
      if (!this.paired) {
        this.hostSendText(JSON.stringify({ v: 1, t: 'error', code: 'HOST_OFFLINE', message: 'no host' }));
        return;
      }
      this.hostSendText(JSON.stringify({ v: 1, t: 'ready', host_name: HOST_ID }));
      return;
    }
    if (frame.t === 'open' && frame.mode === 'exec' && this.autoExec) {
      this.hostSendText(
        JSON.stringify({ v: 1, t: 'opened', ch: channel, ok: true, err_ch: 0x40000000 + channel }),
      );
      this.hostSendBinary(channel, new TextEncoder().encode('hello-out'));
      this.hostSendBinary(0x40000000 + channel, new TextEncoder().encode('err-text'));
      this.hostSendText(JSON.stringify({ v: 1, t: 'exit', ch: channel, exit_code: 7, timed_out: false }));
      return;
    }
    if (frame.t === 'open' && frame.mode === 'pty' && this.autoPty) {
      this.hostSendText(JSON.stringify({ v: 1, t: 'opened', ch: channel, ok: true }));
      return;
    }
    if (frame.t === 'resize') {
      this.hostSendText(JSON.stringify({ v: 1, t: 'ch_note', ch: channel, resized: true }));
      return;
    }
    if (frame.t === 'close' && this.autoPty) {
      // the daemon answers a client close with eof then exit
      if (!this.exited.has(channel)) {
        this.exited.add(channel);
        this.hostSendText(JSON.stringify({ v: 1, t: 'eof', ch: channel }));
        this.hostSendText(JSON.stringify({ v: 1, t: 'exit', ch: channel, exit_code: -9, timed_out: false }));
      }
    }
  }

  /** Echo a pty write back (the `cat` behaviour the loopback tests use). */
  echoPtyWrite(data: string | Uint8Array): void {
    if (typeof data !== 'string') {
      const channel = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, false);
      this.hostSendBinary(channel, data.slice(4));
    }
  }
}

function makeCapability(host: FakeLinkHost) {
  return createLinkCapability({
    relayUrl: RELAY,
    token: TOKEN,
    hostId: HOST_ID,
    socketFactory: host.socketFactory,
  });
}

async function connectThrough(host: FakeLinkHost) {
  const capability = makeCapability(host);
  const pending = capability.connect({
    hostId: HOST_ID,
    hostname: RELAY,
    port: 0,
    username: 'link',
    credential: { kind: 'password', password: 'unused' },
    requestId: 'req-connect',
    generationId: 'gen-1',
    expectedHostKey: null,
  });
  host.openSocket();
  return { capability, result: await pending };
}

describe('link fingerprint primitives', () => {
  it('sha256Hex matches the known SHA-256 answers', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex(new TextEncoder().encode(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('canonicalRelayUrl strips default ports and trailing slashes', () => {
    expect(canonicalRelayUrl('wss://relay.example:443/')).toBe('wss://relay.example');
    expect(canonicalRelayUrl('ws://Relay.example:8765/')).toBe('ws://relay.example:8765');
    expect(canonicalRelayUrl('wss://relay.example/base/')).toBe('wss://relay.example/base');
  });

  it('linkHostKeyFingerprint is stable and URL/token sensitive', () => {
    const a = linkHostKeyFingerprint('wss://relay.example:443/', 'tok');
    const b = linkHostKeyFingerprint('wss://relay.example', 'tok');
    const c = linkHostKeyFingerprint('wss://relay.example', 'tok2');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith('SHA256:')).toBe(true);
  });
});

describe('LinkCapability connect', () => {
  it('dials the client leg, handshakes, and returns the synthesized host key', async () => {
    const host = new FakeLinkHost();
    const { result } = await connectThrough(host);
    expect(host.url).toBe(`wss://relay.example:8765/client?token=${TOKEN}&host_id=${HOST_ID}`);
    expect(result.connectionId).toBeTruthy();
    expect(result.generationId).toBe('gen-1');
    expect(result.hostKey.fingerprintSha256).toBe(linkHostKeyFingerprint(RELAY, TOKEN));
    expect(result.hostKey.keyType).toBe('link-v1');
  });

  it('rejects a stale pin with HOST_KEY_MISMATCH before dialing', async () => {
    const host = new FakeLinkHost();
    const capability = makeCapability(host);
    await expect(
      capability.connect({
        hostId: HOST_ID,
        hostname: RELAY,
        port: 0,
        username: 'link',
        credential: { kind: 'password', password: 'unused' },
        requestId: 'req-connect',
        generationId: 'gen-1',
        expectedHostKey: { kind: 'sha256-fingerprint', fingerprintSha256: 'SHA256:stale' },
      }),
    ).rejects.toMatchObject({ code: 'HOST_KEY_MISMATCH' });
    expect(host.handlers).toBeNull();
  });

  it('accepts the TOFU pin after the first connect', async () => {
    const host = new FakeLinkHost();
    const { result } = await connectThrough(host);
    const capability = makeCapability(host);
    const second = capability.connect({
      hostId: HOST_ID,
      hostname: RELAY,
      port: 0,
      username: 'link',
      credential: { kind: 'password', password: 'unused' },
      requestId: 'req-connect-2',
      generationId: 'gen-2',
      expectedHostKey: { kind: 'sha256-fingerprint', fingerprintSha256: result.hostKey.fingerprintSha256 },
    });
    host.openSocket();
    expect((await second).connectionId).toBeTruthy();
  });

  it('surfaces HOST_OFFLINE as a structured error', async () => {
    const host = new FakeLinkHost();
    host.paired = false;
    const capability = makeCapability(host);
    const pending = capability.connect({
      hostId: HOST_ID,
      hostname: RELAY,
      port: 0,
      username: 'link',
      credential: { kind: 'password', password: 'unused' },
      requestId: 'req-connect',
      generationId: 'gen-1',
      expectedHostKey: null,
    });
    host.openSocket();
    await expect(pending).rejects.toMatchObject({ code: 'HOST_OFFLINE' });
  });

  it('times out a dial that never opens', async () => {
    const capability = createLinkCapability({
      relayUrl: RELAY,
      token: TOKEN,
      hostId: HOST_ID,
      socketFactory: () => ({ send: () => undefined, close: () => undefined }),
      connectTimeoutMs: 25,
    });
    await expect(
      capability.connect({
        hostId: HOST_ID,
        hostname: RELAY,
        port: 0,
        username: 'link',
        credential: { kind: 'password', password: 'unused' },
        requestId: 'req-connect',
        generationId: 'gen-1',
        expectedHostKey: null,
      }),
    ).rejects.toMatchObject({ code: 'TIMED_OUT' });
  });
});

describe('LinkCapability exec', () => {
  it('collects stdout, stderr and the exit code', async () => {
    const host = new FakeLinkHost();
    const { capability, result: connection } = await connectThrough(host);
    const result: SshExecResult = await capability.exec({
      connectionId: connection.connectionId,
      generationId: 'gen-1',
      requestId: 'req-exec',
      command: 'pocketshell tree --json',
      timeoutMs: 15000,
    });
    expect(result.stdout).toBe('hello-out');
    expect(result.stderr).toBe('err-text');
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
    expect(result.requestId).toBe('req-exec');
    const open = host.controlFrames().find((frame) => frame.t === 'open');
    expect(open).toMatchObject({ mode: 'exec', cmd: 'pocketshell tree --json', timeout_ms: 15000 });
  });

  it('resolves timedOut with a null exit code and asks the host to close', async () => {
    const host = new FakeLinkHost();
    host.autoExec = false;
    const { capability, result } = await connectThrough(host);
    const pending = capability.exec({
      connectionId: result.connectionId,
      generationId: 'gen-1',
      requestId: 'req-exec',
      command: 'sleep 30',
      timeoutMs: 30,
    });
    await expect(pending).resolves.toMatchObject({ exitCode: null, timedOut: true });
    expect(host.controlFrames().some((frame) => frame.t === 'close')).toBe(true);
  });

  it('rejects a pending exec with CONNECTION_LOST when the socket drops', async () => {
    const host = new FakeLinkHost();
    host.autoExec = false;
    const { capability, result } = await connectThrough(host);
    const pending = capability.exec({
      connectionId: result.connectionId,
      generationId: 'gen-1',
      requestId: 'req-exec',
      command: 'sleep 30',
      timeoutMs: 60000,
    });
    host.dropSocket();
    await expect(pending).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
  });
});

describe('LinkCapability pty', () => {
  it('opens, writes, echoes, resizes and reports eof after exit', async () => {
    const host = new FakeLinkHost();
    const { capability, result } = await connectThrough(host);
    const pty = await capability.openPty({
      connectionId: result.connectionId,
      generationId: 'gen-1',
      requestId: 'req-pty',
      command: 'a attach --no-status s1',
      cols: 80,
      rows: 24,
      term: 'xterm-256color',
    });
    expect(pty.channelId).toBe('1');
    const written = capability.writePty({
      connectionId: result.connectionId,
      generationId: 'gen-1',
      channelId: pty.channelId,
      requestId: 'req-write',
      sequence: 1,
      dataBase64: btoa('ls\n'),
    });
    await expect(written).resolves.toMatchObject({ sequence: 1 });

    // deliver the echo and read it back through the buffer
    const binary = new Uint8Array(4 + 3);
    new DataView(binary.buffer).setUint32(0, 1, false);
    binary.set(new TextEncoder().encode('ls\n'), 4);
    host.hostSendBinary(1, binary.slice(4));
    const read = await capability.readPty({
      connectionId: result.connectionId,
      generationId: 'gen-1',
      channelId: pty.channelId,
      requestId: 'req-read',
      sequence: 1,
      waitMs: 50,
    });
    expect(read.dataBase64).toBe(btoa('ls\n'));
    expect(read.eof).toBe(false);

    await capability.resizePty({
      connectionId: result.connectionId,
      generationId: 'gen-1',
      channelId: pty.channelId,
      requestId: 'req-resize',
      sequence: 2,
      cols: 100,
      rows: 40,
    });
    expect(host.controlFrames().some((frame) => frame.t === 'resize')).toBe(true);

    host.hostSendText(JSON.stringify({ v: 1, t: 'eof', ch: 1 }));
    host.hostSendText(JSON.stringify({ v: 1, t: 'exit', ch: 1, exit_code: 0, timed_out: false }));
    const drained = await capability.readPty({
      connectionId: result.connectionId,
      generationId: 'gen-1',
      channelId: pty.channelId,
      requestId: 'req-read-2',
      sequence: 2,
      waitMs: 50,
    });
    expect(drained.eof).toBe(true);
  });

  it('writePty on an unknown channel throws NO_SUCH_CHANNEL', async () => {
    const host = new FakeLinkHost();
    const { capability, result } = await connectThrough(host);
    await expect(
      capability.writePty({
        connectionId: result.connectionId,
        generationId: 'gen-1',
        channelId: '999',
        requestId: 'req-write',
        sequence: 1,
        dataBase64: btoa('x'),
      }),
    ).rejects.toMatchObject({ code: 'NO_SUCH_CHANNEL' });
  });
});

describe('LinkCapability unsupported operations', () => {
  it('rejects SFTP and port forwarding with UNSUPPORTED', async () => {
    const host = new FakeLinkHost();
    const { capability, result } = await connectThrough(host);
    const ref = { connectionId: result.connectionId, generationId: 'gen-1' };
    await expect(capability.sftpList({ ...ref, requestId: 'r', path: '/' })).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    await expect(
      capability.sftpRead({ ...ref, requestId: 'r', path: '/etc/hostname', maxBytes: 10 }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(
      capability.openPortForward({ ...ref, requestId: 'r', remoteHost: 'h', remotePort: 80 }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
});

describe('LinkCapability connection lifecycle', () => {
  it('emits connectionState lost when the socket drops', async () => {
    const host = new FakeLinkHost();
    const { capability, result } = await connectThrough(host);
    const events: SshConnectionStateEvent[] = [];
    const listener = await capability.addListener('connectionState', (event) => events.push(event));
    host.dropSocket();
    await Promise.resolve();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ connectionId: result.connectionId, state: 'lost' });
    const state = await capability.getConnectionState({
      connectionId: result.connectionId,
      generationId: 'gen-1',
      requestId: 'req-state',
    });
    expect(state.state).toBe('lost');
    await listener.remove();
  });

  it('closeConnection emits closed and acks', async () => {
    const host = new FakeLinkHost();
    const { capability, result } = await connectThrough(host);
    const events: SshConnectionStateEvent[] = [];
    await capability.addListener('connectionState', (event) => events.push(event));
    const ack = await capability.closeConnection({
      connectionId: result.connectionId,
      generationId: 'gen-1',
      requestId: 'req-close',
    });
    expect(ack.requestId).toBe('req-close');
    expect(events.some((event) => event.state === 'closed')).toBe(true);
  });

  it('resourceSnapshot counts connected links and ptys', async () => {
    const host = new FakeLinkHost();
    const { capability, result } = await connectThrough(host);
    await capability.openPty({
      connectionId: result.connectionId,
      generationId: 'gen-1',
      requestId: 'req-pty',
      command: 'sh',
      cols: 80,
      rows: 24,
    });
    const snapshot = await capability.resourceSnapshot('req-snap');
    expect(snapshot).toMatchObject({ connections: 1, ptys: 1, sftpClients: 0, forwards: 0 });
  });
});
