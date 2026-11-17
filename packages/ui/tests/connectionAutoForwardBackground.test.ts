import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostEntry } from '@pocketshell/core';
import { provideApi } from '../src/app/ipc';
import type { PocketShellApi } from '../src/app/api';
import { diagErrors } from '../src/app/diag';
import { useConnectionStore } from '../src/app/stores/connection';

/** #3137: connect exposes the connection without waiting for auto-forward restore. */
const HOST: HostEntry = {
  name: 'box', hostname: 'box.example', port: 22, user: 'u', identityFile: null, proxyJump: null,
  forwardAgent: false, localForwards: [], remoteForwards: [], fromConfig: true,
};

function install(forwards: Record<string, unknown>) {
  provideApi({
    ssh: { onState: () => () => undefined, listConfigHosts: async () => [HOST], connect: async () => ({ ok: true, connectionId: 'conn-1' }), close: async () => true, exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
    helper: { bootstrap: async () => null, sessionsListing: async () => ({ sessions: [], errors: [] }), sessionsList: async () => [] },
    forwards,
    preview: { onStats: () => () => undefined },
    diag: { log: () => undefined },
  } as unknown as PocketShellApi);
}

beforeEach(() => {
  setActivePinia(createPinia());
  diagErrors.value = [];
});

describe('connect and auto port-forward restore', () => {
  it('exposes the connected host while startAuto is still pending', async () => {
    let release!: () => void;
    const startAuto = vi.fn(() => new Promise<void>((r) => { release = r; }));
    install({ isAutoEnabled: async () => true, startAuto });
    const store = useConnectionStore();
    const outcome = await Promise.race([store.connect(HOST), new Promise((r) => setTimeout(() => r('blocked'), 200))]);
    expect(outcome).toBe(true);
    expect(store.state).toBe('connected');
    expect(store.connectionId).toBe('conn-1');
    await vi.waitFor(() => expect(startAuto).toHaveBeenCalledWith('conn-1', []));
    release();
  });

  it('records a background restore failure in diagnostics without failing the connection', async () => {
    install({ isAutoEnabled: async () => true, startAuto: async () => { throw new Error('port busy'); } });
    const store = useConnectionStore();
    expect(await store.connect(HOST)).toBe(true);
    await vi.waitFor(() => expect(diagErrors.value.map((d) => d.message).join()).toContain('Port-forward restore failed: port busy'));
    expect(store.state).toBe('connected');
  });
});

describe('background restore only acts for the current connection', () => {
  function installSwitchable(forwards: Record<string, unknown>, ids: string[]) {
    let n = 0;
    const close = vi.fn(async () => true);
    provideApi({
      ssh: { onState: () => () => undefined, listConfigHosts: async () => [HOST], connect: async () => ({ ok: true, connectionId: ids[n++] }), close, exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
      helper: { bootstrap: async () => null, sessionsListing: async () => ({ sessions: [], errors: [] }), sessionsList: async () => [] },
      forwards, preview: { onStats: () => () => undefined }, diag: { log: () => undefined },
    } as unknown as PocketShellApi);
  }

  it('does not call startAuto or record an error for a connection replaced while isAutoEnabled is pending', async () => {
    let answerA!: (v: boolean) => void;
    const startAuto = vi.fn(async (id: string) => { if (id === 'conn-a') throw new Error('stale'); });
    installSwitchable({
      isAutoEnabled: (id: string) => (id === 'conn-a' ? new Promise<boolean>((r) => { answerA = r; }) : Promise.resolve(false)),
      startAuto,
    }, ['conn-a', 'conn-b']);
    const store = useConnectionStore();
    expect(await store.connect(HOST)).toBe(true);
    expect(await store.connect(HOST)).toBe(true);
    expect(store.connectionId).toBe('conn-b');
    answerA(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(startAuto).not.toHaveBeenCalled();
    expect(diagErrors.value).toEqual([]);
  });

  it('records no diag error when the connection is closed while startAuto is failing', async () => {
    let fail!: (e: Error) => void;
    installSwitchable({
      isAutoEnabled: async () => true,
      startAuto: () => new Promise<void>((_r, rej) => { fail = rej; }),
    }, ['conn-a']);
    const store = useConnectionStore();
    expect(await store.connect(HOST)).toBe(true);
    await vi.waitFor(() => expect(fail).toBeTypeOf('function'));
    await store.disconnect();
    expect(store.connectionId).not.toBe('conn-a');
    fail(new Error('connection gone'));
    await new Promise((r) => setTimeout(r, 20));
    expect(diagErrors.value).toEqual([]);
  });
});
