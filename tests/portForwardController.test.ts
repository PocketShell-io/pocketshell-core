import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type {
  SshCapability,
  SshConnectionRef,
  SshExecOptions,
  SshExecResult,
  SshPortForwardOptions,
  SshPortForwardRef,
} from '../src/sshCapability.js';
import { PortForwardController } from '../src/portForwardController.js';
import { scanRemotePorts } from '../src/remotePortScan.js';

const connection: SshConnectionRef = { connectionId: 'conn-1', generationId: 'gen-1' };
const listenerOutput = readFileSync(
  new URL('./fixtures/portscan/portscan-wire-alpine-root.txt', import.meta.url),
  'utf8',
);

function execResult(options: SshExecOptions, overrides: Partial<SshExecResult> = {}): SshExecResult {
  return {
    requestId: options.requestId,
    connectionId: options.connectionId,
    generationId: options.generationId,
    exitCode: 0,
    stdout: listenerOutput,
    stderr: '',
    timedOut: false,
    ...overrides,
  };
}

function makeCapability() {
  const exec = vi.fn(async (options: SshExecOptions) => {
    if (/readlink/.test(options.command)) {
      return execResult(options, { stdout: '4460\t/home/testuser/project\n' });
    }
    return execResult(options);
  });
  let opened = 0;
  const openPortForward = vi.fn(async (options: SshPortForwardOptions) => {
    opened += 1;
    return {
      requestId: options.requestId,
      connectionId: options.connectionId,
      generationId: options.generationId,
      forwardId: `forward-${opened}`,
      localPort: 40_000 + opened,
    } satisfies SshPortForwardRef & { requestId: string };
  });
  const closePortForward = vi.fn(async (options: SshPortForwardRef & { requestId: string }) => ({
    requestId: options.requestId,
  }));
  return {
    capability: { exec, openPortForward, closePortForward } as unknown as SshCapability,
    exec,
    openPortForward,
    closePortForward,
  };
}

describe('scanRemotePorts + PortForwardController over the SSH capability', () => {
  it('runs the listener and cwd probes through the current SSH generation', async () => {
    const { capability, exec } = makeCapability();
    const ids = ['scan-request', 'cwd-request'];
    const result = await scanRemotePorts(capability, connection, { createRequestId: () => ids.shift()! });

    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[0]?.[0]).toMatchObject({
      ...connection,
      requestId: 'scan-request',
      timeoutMs: 15_000,
    });
    expect(result).toMatchObject({
      ok: true,
      ports: expect.arrayContaining([
        { port: 22, process: 'sshd', pid: 1, cwd: null },
        { port: 8000, process: 'python3', pid: 4460, cwd: '/home/testuser/project' },
      ]),
    });
    expect(exec.mock.calls[1]?.[0].command).toContain('for pid in 1 4460;');
  });

  it('uses JS desired-port policy and native socket effects, then restores manual intent after reconnect', async () => {
    const { capability, openPortForward, closePortForward } = makeCapability();
    const controller = new PortForwardController(capability, connection, {
      createRequestId: (() => {
        let id = 0;
        return () => `request-${++id}`;
      })(),
      desiredManualPorts: [22],
    });

    const first = await controller.reconcile({
      ok: true,
      ports: [
        { port: 22, process: 'sshd', pid: 1, cwd: null },
        { port: 8000, process: 'python3', pid: 4460, cwd: null },
      ],
      error: null,
    });
    expect(first.activeForwards).toEqual([
      { remotePort: 22, localPort: 40_001, origin: 'manual' },
      { remotePort: 8000, localPort: 40_002, origin: 'auto' },
    ]);
    expect(openPortForward.mock.calls.map(([call]) => call.remotePort)).toEqual([22, 8000]);
    expect(openPortForward.mock.calls.every(([call]) => call.localPort === undefined)).toBe(true);

    await controller.setConnection({ connectionId: 'conn-1', generationId: 'gen-2' });
    expect(closePortForward).toHaveBeenCalledTimes(2);
    expect(controller.getManualDesiredPorts()).toEqual([22]);
    const afterReconnect = await controller.reconcile({ ok: false, ports: [], error: 'transport closed' });
    expect(afterReconnect.activeForwards).toEqual([
      { remotePort: 22, localPort: 40_003, origin: 'manual' },
    ]);
    expect(openPortForward.mock.calls.at(-1)?.[0].generationId).toBe('gen-2');
  });

  it('closes auto tunnels only after bounded successful misses and closes all owned handles', async () => {
    const { capability, closePortForward } = makeCapability();
    const controller = new PortForwardController(capability, connection, {
      createRequestId: (() => {
        let id = 0;
        return () => `close-${++id}`;
      })(),
    });
    const initial = await controller.reconcile({
      ok: true,
      ports: [{ port: 3000, process: null, pid: null, cwd: null }],
      error: null,
    });
    expect(initial.activeForwards).toHaveLength(1);

    const firstMiss = await controller.reconcile({
      ok: true,
      ports: [{ port: 8080, process: null, pid: null, cwd: null }],
      error: null,
    });
    expect(firstMiss.activeForwards.map((row) => row.remotePort)).toEqual([3000, 8080]);
    const secondMiss = await controller.reconcile({
      ok: true,
      ports: [{ port: 8080, process: null, pid: null, cwd: null }],
      error: null,
    });
    expect(secondMiss.activeForwards.map((row) => row.remotePort)).toEqual([8080]);

    await controller.closeAll();
    expect(controller.snapshot().activeForwards).toEqual([]);
    expect(closePortForward).toHaveBeenCalledTimes(2);
  });

  it('automatically forwards 9638 while retaining discovered rows 22 and 33307', async () => {
    const { capability, openPortForward } = makeCapability();
    const controller = new PortForwardController(capability, connection, {
      createRequestId: (() => {
        let id = 0;
        return () => `matrix-${++id}`;
      })(),
    });
    const scan = {
      ok: true,
      ports: [22, 9638, 33307].map((port) => ({ port, process: null, pid: null, cwd: null })),
      error: null,
    };

    const snapshot = await controller.reconcile(scan);
    expect(snapshot.scan.ports.map((port) => port.port)).toEqual([22, 9638, 33307]);
    expect(snapshot.activeForwards.map((forward) => forward.remotePort)).toEqual([9638]);
    expect(openPortForward.mock.calls.map(([call]) => call.remotePort)).toEqual([9638]);

    controller.setManualDesiredPort(22, true);
    controller.setAutoEnabled(false);
    const autoOffSnapshot = await controller.reconcile(scan);
    expect(autoOffSnapshot.activeForwards).toEqual([
      expect.objectContaining({ remotePort: 22, origin: 'manual' }),
    ]);
  });

  it('reports a failed or mismatched listener scan instead of an empty port list', async () => {
    const offline = { exec: vi.fn(async () => { throw new Error('transport closed'); }) } as unknown as SshCapability;
    expect(await scanRemotePorts(offline, connection, { createRequestId: () => 'scan-offline' }))
      .toEqual({ ok: false, ports: [], error: 'transport closed' });

    const stale = {
      exec: vi.fn(async (options: SshExecOptions) => execResult(options, { generationId: 'stale-generation' })),
    } as unknown as SshCapability;
    expect(await scanRemotePorts(stale, connection, { createRequestId: () => 'scan-stale' })).toEqual({
      ok: false,
      ports: [],
      error: 'port scan response belonged to a different SSH request or connection',
    });
  });

  it('keeps the listener rows unlabelled when the cwd probe fails or answers another request', async () => {
    for (const cwdAnswer of ['throw', 'mismatch'] as const) {
      const exec = vi.fn(async (options: SshExecOptions) => {
        if (!/readlink/.test(options.command)) return execResult(options);
        if (cwdAnswer === 'throw') throw new Error('cwd probe failed');
        return execResult(options, { requestId: 'someone-else', stdout: '4460\t/leaked\n' });
      });
      const ids = ['scan', 'cwd'];
      const result = await scanRemotePorts({ exec } as unknown as SshCapability, connection, {
        createRequestId: () => ids.shift()!,
      });
      expect(result.ok).toBe(true);
      expect(result.ports.find((port) => port.port === 8000)).toMatchObject({ pid: 4460, cwd: null });
    }
  });

  it('records an error and holds the port down when the native open answers another generation', async () => {
    const { capability, openPortForward } = makeCapability();
    openPortForward.mockImplementationOnce(async (options: SshPortForwardOptions) => ({
      requestId: options.requestId,
      connectionId: options.connectionId,
      generationId: 'stale-generation',
      forwardId: 'forward-stale',
      localPort: 40_100,
    }));
    const controller = new PortForwardController(capability, connection, {
      createRequestId: (() => {
        let id = 0;
        return () => `stale-${++id}`;
      })(),
      now: () => 1_000,
    });
    const snapshot = await controller.reconcile({
      ok: true,
      ports: [{ port: 3000, process: null, pid: null, cwd: null }],
      error: null,
    });
    expect(snapshot.activeForwards).toEqual([]);
    expect(snapshot.errors[3000]).toMatch(/invalid request, connection, or local port/);
    // The failed-open TTL holds the port down on the next pass instead of retrying hot.
    await controller.reconcile({ ok: true, ports: [{ port: 3000, process: null, pid: null, cwd: null }], error: null });
    expect(openPortForward).toHaveBeenCalledTimes(1);
  });
});
