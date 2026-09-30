import { describe, expect, it } from 'vitest';
import {
  SAVED_HOSTS_STORAGE_KEY,
  SavedHostStore,
  SavedHostStoreError,
  hostEntryId,
  isValidSshKeyHandleCredential,
  savedHostEntry,
  savedHostSshTarget,
  savedHostTrustStorageKey as hostTrustStorageKey,
  validateSavedHostKeyRef,
  type SavedHostKeyRef,
  type StringStorage,
} from '../src';

class MemoryStorage implements StringStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

const nativeKey: SavedHostKeyRef = {
  kind: 'key-handle',
  handleId: 'vault-key-7',
  label: 'main key',
  passphraseRequired: false,
};

function createStore(storage: StringStorage, createId?: () => string): SavedHostStore {
  return new SavedHostStore(storage, { validateCredential: validateSavedHostKeyRef, createId });
}

function hostInput(name = 'devbox') {
  return {
    name,
    hostname: 'dev.example.test',
    port: 22,
    username: 'alex',
    credentialRef: { ...nativeKey },
  };
}

describe('saved host store', () => {
  it('adds, selects, edits, reorders, defaults and deletes stable IDs through persisted state', () => {
    const storage = new MemoryStorage();
    let nextId = 0;
    const firstRun = createStore(storage, () => `stable-${++nextId}`);
    firstRun.load();
    const first = firstRun.add(hostInput('devbox'));
    const second = firstRun.add({ ...hostInput('staging'), hostname: 'staging.example.test' });

    expect(first.id).toBe('stable-1');
    expect(firstRun.defaultHostId).toBe(first.id);
    firstRun.select(second.id);
    firstRun.setDefault(second.id);
    firstRun.update(second.id, { ...hostInput('staging edited'), hostname: 'staging-2.example.test' });
    firstRun.move(second.id, 0);

    const restarted = createStore(storage);
    restarted.load();
    expect(restarted.hosts.map((host) => host.id)).toEqual([second.id, first.id]);
    expect(restarted.hosts[0]).toMatchObject({ name: 'staging edited', hostname: 'staging-2.example.test' });
    expect(restarted.selectedHostId).toBe(second.id);
    expect(restarted.defaultHostId).toBe(second.id);

    restarted.delete(second.id);
    expect(restarted.selectedHostId).toBeNull();
    expect(restarted.defaultHostId).toBeNull();
    expect(restarted.hosts.map((host) => host.id)).toEqual([first.id]);
  });

  it('validates connection fields and opaque key references before writing', () => {
    const storage = new MemoryStorage();
    const store = createStore(storage, () => 'stable-1');
    store.load();

    expect(() => store.add({ ...hostInput(), hostname: 'bad host name' }))
      .toThrowError('Enter a valid host name or IP address.');
    expect(() => store.add({ ...hostInput(), port: 65_536 }))
      .toThrowError('Port must be a whole number from 1 to 65535.');
    expect(() => store.add({ ...hostInput(), credentialRef: { ...nativeKey, privateKeyPem: 'must not persist' } as SavedHostKeyRef }))
      .toThrowError('A saved host has a malformed key reference.');
    expect(storage.getItem(SAVED_HOSTS_STORAGE_KEY)).toBeNull();
  });

  it('rejects malformed or conflicting persisted records without clearing their source bytes', () => {
    const storage = new MemoryStorage();
    const malformed = '{broken';
    storage.setItem(SAVED_HOSTS_STORAGE_KEY, malformed);
    expect(() => createStore(storage).load()).toThrowError(SavedHostStoreError);
    expect(storage.getItem(SAVED_HOSTS_STORAGE_KEY)).toBe(malformed);

    storage.setItem(SAVED_HOSTS_STORAGE_KEY, JSON.stringify({
      schemaVersion: 1,
      hosts: [
        { id: 'duplicate', ...hostInput() },
        { id: 'duplicate', ...hostInput('other') },
      ],
      selectedHostId: null,
      defaultHostId: null,
      defaultHostExplicitlySet: false,
      importedHostIds: [],
      importTombstones: [],
    }));
    const duplicateDocument = storage.getItem(SAVED_HOSTS_STORAGE_KEY);
    expect(() => createStore(storage).load()).toThrowError(/duplicate host ID/);
    expect(storage.getItem(SAVED_HOSTS_STORAGE_KEY)).toBe(duplicateDocument);
  });

  it('imports migrated hosts, key associations and default selection idempotently and refuses conflicting IDs', () => {
    const storage = new MemoryStorage();
    const store = createStore(storage, () => 'new-host');
    store.load();
    const imported = {
      id: '41',
      ...hostInput('devbox'),
      credentialRef: { ...nativeKey },
    };
    store.importHosts([imported], '41');
    expect(store.defaultHostId).toBe('41');
    expect(store.selectedHostId).toBe('41');
    expect(store.hosts[0].credentialRef).toEqual(nativeKey);
    const storedAfterFirstImport = storage.getItem(SAVED_HOSTS_STORAGE_KEY);

    store.importHosts([imported], '41');
    expect(store.hosts).toHaveLength(1);
    expect(store.defaultHostId).toBe('41');

    expect(() => store.importHosts([{ ...imported, name: 'changed' }], '41'))
      .not.toThrow();
    expect(store.hosts[0].name).toBe('devbox');
    expect(() => store.importHosts([
      imported,
      { ...imported, name: 'duplicate source record' },
    ], '41')).toThrowError(/conflicting duplicate ID/);
    expect(storage.getItem(SAVED_HOSTS_STORAGE_KEY)).not.toBeNull();
    expect(JSON.parse(storage.getItem(SAVED_HOSTS_STORAGE_KEY) ?? '{}').hosts[0].name).toBe('devbox');
    expect(storedAfterFirstImport).not.toBeNull();
  });

  it('keeps trust pin identity scoped to the stable host ID, not its shared endpoint', () => {
    expect(hostTrustStorageKey('41')).toBe('pocketshell.ssh.host-key.41');
    expect(hostTrustStorageKey('uuid-two')).not.toBe(hostTrustStorageKey('41'));
    expect(() => hostTrustStorageKey('')).toThrowError(SavedHostStoreError);
  });

  it('preserves edits and explicit default choices across migration replay, and does not resurrect deleted imported hosts', () => {
    const storage = new MemoryStorage();
    const store = createStore(storage, () => 'new-host');
    store.load();
    const imported = { id: '41', ...hostInput('devbox') };
    store.importHosts([imported], '41');
    store.update('41', { ...hostInput('renamed by user'), hostname: 'new.example.test' });

    const manuallyAdded = store.add({ ...hostInput('manual'), hostname: 'manual.example.test' });
    store.setDefault(manuallyAdded.id);
    store.importHosts([imported], '41');
    expect(store.hosts.find((host) => host.id === '41')).toMatchObject({
      name: 'renamed by user',
      hostname: 'new.example.test',
    });
    expect(store.defaultHostId).toBe(manuallyAdded.id);

    store.delete('41');
    const restarted = createStore(storage);
    restarted.load();
    restarted.importHosts([imported], '41');
    expect(restarted.hosts.map((host) => host.id)).toEqual([manuallyAdded.id]);
    expect(restarted.defaultHostId).toBe(manuallyAdded.id);
  });

  it('projects a saved host into the controller key-handle target and the shared host list entry', () => {
    const host = { id: 'stable-9', ...hostInput('devbox'), credentialRef: { ...nativeKey, passphraseRequired: true } };
    const target = savedHostSshTarget(host, 'per-attempt');
    expect(target).toEqual({
      hostId: 'stable-9',
      hostname: 'dev.example.test',
      port: 22,
      username: 'alex',
      credential: { kind: 'key-handle', handleId: 'vault-key-7', passphrase: 'per-attempt' },
    });
    expect(isValidSshKeyHandleCredential(target.credential)).toBe(true);
    expect(savedHostSshTarget({ ...host, credentialRef: nativeKey }, 'ignored').credential)
      .toEqual({ kind: 'key-handle', handleId: 'vault-key-7' });
    expect(() => savedHostSshTarget({ ...host, credentialRef: null })).toThrowError(SavedHostStoreError);
    expect(savedHostEntry(host)).toMatchObject({
      id: 'stable-9', name: 'devbox', hostname: 'dev.example.test', port: 22, user: 'alex', identityFile: null, fromConfig: false,
    });
  });

  it('gives every host-list entry one identity: the saved ID survives a rename, a config alias is its own ID', () => {
    const storage = new MemoryStorage();
    const store = createStore(storage, () => 'stable-1');
    store.load();
    const added = store.add(hostInput('devbox'));
    const before = hostEntryId(savedHostEntry(added));
    const renamed = store.update(added.id, { ...hostInput('renamed'), hostname: 'moved.example.test' });
    expect(hostEntryId(savedHostEntry(renamed))).toBe(before);
    expect(before).toBe('stable-1');
    // Two saved hosts may share a display name; their identities still differ.
    const twin = createStore(storage, () => 'stable-2');
    twin.load();
    const second = twin.add(hostInput('renamed'));
    expect(hostEntryId(savedHostEntry(second))).not.toBe(hostEntryId(savedHostEntry(renamed)));
    // An ~/.ssh/config or account host carries no id: its unique alias is the identity.
    expect(hostEntryId({ name: 'hetzner' })).toBe('hetzner');
  });

  it('snapshots the persisted hosts, selection and default as copies a bridge can hand out', () => {
    const storage = new MemoryStorage();
    let nextId = 0;
    const store = createStore(storage, () => `stable-${++nextId}`);
    store.load();
    const first = store.add(hostInput('devbox'));
    const second = store.add({ ...hostInput('staging'), hostname: 'staging.example.test' });
    store.select(second.id);
    const snapshot = store.snapshot();
    expect(snapshot).toEqual({
      hosts: [first, second],
      selectedHostId: second.id,
      defaultHostId: first.id,
    });
    snapshot.hosts[0]!.name = 'mutated by the caller';
    expect(store.hosts[0]!.name).toBe('devbox');
    const restarted = createStore(storage);
    restarted.load();
    expect(restarted.snapshot()).toEqual({ ...snapshot, hosts: [first, second] });
  });
});
