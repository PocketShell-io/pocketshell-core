import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostEntry } from '@pocketshell/core';
import { provideApi } from '../src/app/ipc';
import type { ConnectionStateEvent, PocketShellApi } from '../src/app/api';
import { useConnectionStore } from '../src/app/stores/connection';

/**
 * #2954 (D28/D42): who owns recovery is decided by one capability — whether
 * the platform's `ssh` group has `reconnect`. With it (Android, core's
 * ConnectionController) the store never re-dials by itself; without it
 * (desktop, web until #2936 U5/U6) the store's own ReconnectLoop does.
 */

const HOST: HostEntry = {
  name: 'box',
  hostname: 'box.example',
  port: 22,
  user: 'u',
  identityFile: null,
  proxyJump: null,
  forwardAgent: false,
  localForwards: [],
  remoteForwards: [],
  fromConfig: true,
};

function fakeApi(withReconnect: boolean) {
  let listener: ((payload: ConnectionStateEvent) => void) | null = null;
  const connect = vi.fn(async () => ({ ok: true, connectionId: 'conn-1' }));
  const reconnect = vi.fn(async () => true);
  const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
  const ssh: Record<string, unknown> = {
    onState: (handler: (payload: ConnectionStateEvent) => void) => {
      listener = handler;
      return () => undefined;
    },
    listConfigHosts: async () => [HOST],
    connect,
    close: vi.fn(async () => true),
    exec,
  };
  if (withReconnect) ssh.reconnect = reconnect;
  provideApi({
    ssh,
    helper: { bootstrap: async () => null, sessionsListing: async () => ({ sessions: [], errors: [] }), sessionsList: async () => [] },
    forwards: { isAutoEnabled: async () => false },
    preview: { onStats: () => () => undefined },
  } as unknown as PocketShellApi);
  return {
    connect,
    reconnect,
    exec,
    emit: (payload: ConnectionStateEvent) => listener?.(payload),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('connection store recovery ownership', () => {
  it('follows a recovery-owning transport and never re-dials by itself', async () => {
    const api = fakeApi(true);
    const store = useConnectionStore();
    expect(await store.connect(HOST)).toBe(true);

    api.emit({ connectionId: 'conn-1', state: 'reconnecting', attempt: 2, maxAttempts: 5 });
    expect(store.state).toBe('reconnecting');
    expect(store.transportRetry).toEqual({ attempt: 2, maxAttempts: 5 });
    api.emit({ connectionId: 'conn-1', state: 'lost', error: 'Could not reconnect to box after 5 attempts.' });
    expect(store.error).toBe('Could not reconnect to box after 5 attempts.');

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(api.connect).toHaveBeenCalledTimes(1);
    expect(store.autoRetry).toBeNull();

    // Retry asks the transport to recover the SAME connection.
    expect(await store.reconnect()).toBe(true);
    expect(api.reconnect).toHaveBeenCalledWith('conn-1');
    expect(api.connect).toHaveBeenCalledTimes(1);
    expect(store.connectionId).toBe('conn-1');
    expect(store.state).toBe('connected');

    // The resume probe is the transport's too.
    await store.onOsResume();
    expect(api.exec).not.toHaveBeenCalledWith('conn-1', 'true');
    expect(store.transportOwnsRecovery).toBe(true);
  });

  it('runs its own ladder on a transport without reconnect (desktop, web)', async () => {
    const api = fakeApi(false);
    const store = useConnectionStore();
    expect(await store.connect(HOST)).toBe(true);
    expect(store.transportOwnsRecovery).toBe(false);

    api.emit({ connectionId: 'conn-1', state: 'lost' });
    expect(store.autoRetry).not.toBeNull();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(api.connect).toHaveBeenCalledTimes(2);
  });
});
