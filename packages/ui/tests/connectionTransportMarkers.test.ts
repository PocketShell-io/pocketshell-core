import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostEntry } from '@pocketshell/core';
import { provideApi } from '../src/app/ipc';
import type { PocketShellApi } from '../src/app/api';
import { useConnectionStore } from '../src/app/stores/connection';

/**
 * Issue #3059 — the shared connect payload preserves transport intent.
 *
 * The store is the one seam every platform's dial goes through: it must hand
 * a host entry's transport markers (`link`, `gateway`) to the platform
 * boundary VERBATIM — valid, null or malformed — and must add neither key
 * for an ordinary host. Deciding support is the platform's job, not the
 * store's; these tests pin the preservation only.
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

function entryWith(markers: Record<string, unknown>): HostEntry {
  return { ...HOST, ...markers } as unknown as HostEntry;
}

function fakeApi() {
  const connect = vi.fn(async () => ({ ok: true, connectionId: 'conn-1' }));
  provideApi({
    ssh: {
      onState: () => () => undefined,
      listConfigHosts: async () => [HOST],
      connect,
      close: async () => true,
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    },
    helper: { bootstrap: async () => null, sessionsListing: async () => ({ sessions: [], errors: [] }), sessionsList: async () => [] },
    forwards: { isAutoEnabled: async () => false },
    preview: { onStats: () => () => undefined },
  } as unknown as PocketShellApi);
  return { connect };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('connection store — transport markers ride the connect payload', () => {
  it('an ordinary host carries no marker keys at all', async () => {
    const { connect } = fakeApi();
    await useConnectionStore().connect(HOST);
    const payload = connect.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(payload, 'gateway')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(payload, 'link')).toBe(false);
  });

  it('a valid gateway marker is passed through verbatim', async () => {
    const { connect } = fakeApi();
    const marker = { serverUrl: 'wss://gateway.pocketshell.io', deviceId: 'device-1' };
    await useConnectionStore().connect(entryWith({ gateway: marker }));
    const payload = connect.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload['gateway']).toEqual(marker);
  });

  it('a null or malformed marker is preserved, never normalized', async () => {
    for (const marker of [null, { deviceId: 42 }]) {
      const { connect } = fakeApi();
      await useConnectionStore().connect(entryWith({ gateway: marker }));
      const payload = connect.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(payload['gateway']).toEqual(marker);
    }
  });

  it('conflicting markers are both preserved for the platform boundary to refuse', async () => {
    const { connect } = fakeApi();
    const link = { relayUrl: 'wss://relay.example:8765', hostId: 'nat-box' };
    const gateway = { serverUrl: 'wss://gateway.pocketshell.io', deviceId: 'device-1' };
    await useConnectionStore().connect(entryWith({ link, gateway }));
    const payload = connect.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload['link']).toEqual(link);
    expect(payload['gateway']).toEqual(gateway);
  });

  it('a link-only host keeps its legacy payload intent', async () => {
    const { connect } = fakeApi();
    const link = { relayUrl: 'wss://relay.example:8765', hostId: 'nat-box' };
    await useConnectionStore().connect(entryWith({ link }));
    const payload = connect.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload['link']).toEqual(link);
    expect(Object.prototype.hasOwnProperty.call(payload, 'gateway')).toBe(false);
  });

  it('the dial itself is still attempted — the store preserves, the platform refuses', async () => {
    const { connect } = fakeApi();
    const ok = await useConnectionStore().connect(entryWith({ gateway: { deviceId: 'x' } }));
    expect(ok).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
