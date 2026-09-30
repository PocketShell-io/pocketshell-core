import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, defineStore, setActivePinia } from 'pinia';
import {
  SavedHostStore,
  SavedHostStoreError,
  hostEntryId,
  validateSavedHostKeyRef,
  type HostEntry,
  type SavedHostInput,
  type SavedHostKeyRef,
  type StringStorage,
} from '@pocketshell/core';
import { provideApi } from '../src/app/ipc';
import type { PlatformHostStore, PocketShellApi } from '../src/app/api';
import { useHostsStore } from '../src/app/stores/hosts';
import { useConnectionStore } from '../src/app/stores/connection';
import { useSettingsStore } from '../src/app/stores/settings';
import { decideAutoConnect, defaultHostStatus } from '../src/app/autoConnect';

class MemoryStorage implements StringStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

const key: SavedHostKeyRef = { kind: 'key-handle', handleId: 'vault-key-7', label: 'main key', passphraseRequired: false };

function input(name: string, hostname = `${name}.example.test`): SavedHostInput {
  return { name, hostname, port: 22, username: 'alex', credentialRef: { ...key } };
}

/**
 * The Android shape of `api.hosts.store`: a one-to-one bridge onto core's
 * SavedHostStore. The snapshot crosses a JSON boundary, as it would over the
 * WebView bridge, so the UI never shares an object with the platform store.
 */
function savedHostBridge(storage: StringStorage, ids: () => string) {
  const store = new SavedHostStore(storage, { validateCredential: validateSavedHostKeyRef, createId: ids });
  store.load();
  const answer = () => Promise.resolve(JSON.parse(JSON.stringify(store.snapshot())));
  const run = <A extends unknown[]>(fn: (...args: A) => void) => vi.fn(async (...args: A) => {
    fn(...args);
    return answer();
  });
  return {
    load: vi.fn(answer),
    add: run((host: SavedHostInput) => { store.add(host); }),
    update: run((id: string, host: SavedHostInput) => { store.update(id, host); }),
    delete: run((id: string) => { store.delete(id); }),
    setDefault: run((id: string | null) => { store.setDefault(id); }),
    move: run((id: string, index: number) => { store.move(id, index); }),
  };
}

function platform(extra: { hostStore?: PlatformHostStore }, configHosts: HostEntry[] = []) {
  const listConfigHosts = vi.fn(async () => configHosts);
  const copy = { groupLabel: 'Saved hosts', sourceName: 'this device', emptyHint: 'No saved hosts yet.' };
  provideApi({
    ssh: { listConfigHosts, onState: () => () => undefined },
    hosts: extra.hostStore ? { ...copy, store: extra.hostStore } : copy,
  } as unknown as PocketShellApi);
  return { listConfigHosts };
}

function restartUi(): void {
  setActivePinia(createPinia());
}

beforeEach(() => {
  restartUi();
});

describe('shared hosts store over a platform-owned SavedHostStore', () => {
  it('adds, edits, reorders, defaults and deletes through the platform store, and the picker list follows every snapshot', async () => {
    const storage = new MemoryStorage();
    let next = 0;
    const bridge = savedHostBridge(storage, () => `stable-${++next}`);
    const { listConfigHosts } = platform({ hostStore: bridge });
    const hosts = useHostsStore();
    const connection = useConnectionStore();

    await connection.loadHosts();
    expect(listConfigHosts).not.toHaveBeenCalled();
    expect(hosts.editable).toBe(true);
    expect(connection.hosts).toEqual([]);

    const devbox = await hosts.add(input('devbox'));
    const staging = await hosts.add(input('staging'));
    expect(devbox.id).toBe('stable-1');
    expect(staging.id).toBe('stable-2');
    expect(connection.hosts.map(hostEntryId)).toEqual(['stable-1', 'stable-2']);
    // SavedHostStore semantics: the first host becomes the default.
    expect(hosts.defaultHostKey).toBe('stable-1');
    expect(hosts.isDefault(devbox)).toBe(true);

    // A rename keeps the identity, and with it the default.
    await hosts.update('stable-1', input('devbox renamed', 'moved.example.test'));
    expect(connection.hosts[0]).toMatchObject({ id: 'stable-1', name: 'devbox renamed', hostname: 'moved.example.test' });
    expect(hosts.isDefault(connection.hosts[0]!)).toBe(true);
    expect(hosts.savedHost('stable-1')?.credentialRef).toEqual(key);

    await hosts.toggleDefault(connection.hosts[1]!);
    expect(hosts.defaultHostKey).toBe('stable-2');
    await hosts.move('stable-2', 0);
    expect(connection.hosts.map(hostEntryId)).toEqual(['stable-2', 'stable-1']);

    // The renderer settings never become a second copy of the default.
    expect(useSettingsStore().defaultHost).toBeNull();

    await hosts.remove('stable-2');
    expect(connection.hosts.map(hostEntryId)).toEqual(['stable-1']);
    expect(hosts.defaultHostKey).toBeNull();
  });

  it('survives a restart: list, order and default come back from the platform store alone', async () => {
    const storage = new MemoryStorage();
    let next = 0;
    platform({ hostStore: savedHostBridge(storage, () => `stable-${++next}`) });
    const first = useHostsStore();
    await first.add(input('devbox'));
    const staging = await first.add(input('staging'));
    await first.setDefaultHost(hostEntryId(staging));
    await first.move(hostEntryId(staging), 0);

    restartUi();
    platform({ hostStore: savedHostBridge(storage, () => 'unused') });
    const connection = useConnectionStore();
    await connection.loadHosts();
    const restarted = useHostsStore();
    expect(connection.hosts.map((host) => [host.id, host.name])).toEqual([['stable-2', 'staging'], ['stable-1', 'devbox']]);
    expect(restarted.defaultHostKey).toBe('stable-2');
  });

  it('refuses invalid input before the platform is asked, and a platform rejection leaves the list unchanged', async () => {
    const storage = new MemoryStorage();
    const bridge = savedHostBridge(storage, () => 'stable-1');
    platform({ hostStore: bridge });
    const hosts = useHostsStore();
    const connection = useConnectionStore();
    await connection.loadHosts();

    await expect(hosts.add(input('devbox', 'bad host'))).rejects.toThrow('Enter a valid host name or IP address.');
    await expect(hosts.add({ ...input('devbox'), port: 0 })).rejects.toThrow(/Port must be/);
    await expect(hosts.add({ ...input('devbox'), credentialRef: { ...key, privateKey: 'bytes' } as SavedHostKeyRef }))
      .rejects.toThrow('A saved host has a malformed key reference.');
    expect(bridge.add).not.toHaveBeenCalled();

    await hosts.add(input('devbox'));
    const before = JSON.stringify(connection.hosts);
    await expect(hosts.update('gone', input('ghost'))).rejects.toThrow(SavedHostStoreError);
    await expect(hosts.setDefaultHost('gone')).rejects.toThrow(SavedHostStoreError);
    expect(JSON.stringify(connection.hosts)).toBe(before);
    expect(hosts.defaultHostKey).toBe('stable-1');
  });

  it('surfaces malformed stored data on load without clearing it', async () => {
    const storage = new MemoryStorage();
    const bridge = savedHostBridge(storage, () => 'stable-1');
    await bridge.add(input('devbox'));
    const document = storage.values.values().next().value as string;
    const broken = document.replace('"stable-1"', '""');
    const [storageKey] = [...storage.values.keys()];
    storage.setItem(storageKey!, broken);
    platform({
      hostStore: {
        ...bridge,
        load: vi.fn(async () => {
          const reloaded = new SavedHostStore(storage, { validateCredential: validateSavedHostKeyRef });
          reloaded.load();
          return reloaded.snapshot();
        }),
      },
    });
    await expect(useConnectionStore().loadHosts()).rejects.toThrow(SavedHostStoreError);
    expect(storage.getItem(storageKey!)).toBe(broken);
  });

  it('auto-connects to the default by stable id, so a renamed default host still dials', async () => {
    let next = 0;
    platform({ hostStore: savedHostBridge(new MemoryStorage(), () => `stable-${++next}`) });
    const hosts = useHostsStore();
    await hosts.add(input('devbox'));
    await hosts.update('stable-1', input('renamed'));
    const connection = useConnectionStore();
    const decision = decideAutoConnect({
      defaultHost: hosts.defaultHostKey,
      hosts: connection.hosts,
      attempted: false,
      connected: false,
    });
    expect(decision).toEqual({ action: 'connect', host: expect.objectContaining({ id: 'stable-1', name: 'renamed' }) });
    // A display name is not an identity for a saved host.
    expect(defaultHostStatus('renamed', connection.hosts)).toBe('missing');
    expect(defaultHostStatus('stable-1', connection.hosts)).toBe('present');
  });
});

describe('shared hosts store on a platform that reads its hosts', () => {
  const config: HostEntry = {
    name: 'hetzner', hostname: '135.181.114.209', port: 22, user: 'alexey', identityFile: null,
    proxyJump: null, forwardAgent: false, localForwards: [], remoteForwards: [], fromConfig: true,
  };

  it('keeps ~/.ssh/config as the list, the alias as the identity and settings as the default', async () => {
    const { listConfigHosts } = platform({}, [config]);
    const hosts = useHostsStore();
    const connection = useConnectionStore();
    await connection.loadHosts();
    expect(listConfigHosts).toHaveBeenCalledOnce();
    expect(hosts.editable).toBe(false);
    expect(connection.hosts).toEqual([config]);

    await hosts.toggleDefault(config);
    expect(useSettingsStore().defaultHost).toBe('hetzner');
    expect(hosts.isDefault(config)).toBe(true);
    expect(decideAutoConnect({ defaultHost: hosts.defaultHostKey, hosts: connection.hosts, attempted: false, connected: false }))
      .toEqual({ action: 'connect', host: config });
    await hosts.toggleDefault(config);
    expect(useSettingsStore().defaultHost).toBeNull();

    await expect(hosts.add(input('devbox'))).rejects.toThrow(/cannot be edited here/);
  });
});

describe('shared hosts store id', () => {
  const config: HostEntry = {
    name: 'hetzner', hostname: '135.181.114.209', port: 22, user: 'alexey', identityFile: null,
    proxyJump: null, forwardAgent: false, localForwards: [], remoteForwards: [], fromConfig: true,
  };

  /**
   * A client's own options store under the id 'hosts' — the web app's shape
   * (pocketshell-web src/stores/hosts.ts). The web mounts the shared picker at
   * `/` with this store live, so a shared store registered under the same id
   * would be handed this one (or hand its own to the web), and each side
   * would lose its API.
   */
  const useClientHostsStore = defineStore('hosts', {
    state: () => ({ hosts: [config] as HostEntry[], unlocked: false }),
    actions: {
      unlock(): void { this.unlocked = true; },
    },
  });

  it('keeps its own API when a client already registered a "hosts" store first', async () => {
    platform({}, [config]);
    const client = useClientHostsStore();
    const shared = useHostsStore();
    // Identity compared as a boolean: a failing toBe would try to diff two
    // live Pinia stores, which are circular and exhaust the worker's heap.
    expect(Object.is(shared, client)).toBe(false);
    expect(typeof shared.isDefault).toBe('function');
    expect(typeof shared.toggleDefault).toBe('function');
    expect(shared.defaultHostKey).toBeNull();
    await shared.toggleDefault(config);
    expect(shared.defaultHostKey).toBe('hetzner');
    expect(shared.isDefault(config)).toBe(true);
    // The client's store is untouched and still its own.
    expect(client.hosts?.map((host) => host.name)).toEqual(['hetzner']);
    client.unlock();
    expect(client.unlocked).toBe(true);
  });

  it('leaves the client store intact when the shared store is created first', () => {
    platform({}, [config]);
    const shared = useHostsStore();
    const client = useClientHostsStore();
    expect(Object.is(client, shared)).toBe(false);
    expect(client.hosts?.map((host) => host.name)).toEqual(['hetzner']);
    expect(typeof client.unlock).toBe('function');
    expect(typeof shared.isDefault).toBe('function');
  });
});
