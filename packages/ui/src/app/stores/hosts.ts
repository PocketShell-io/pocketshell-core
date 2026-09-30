import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import {
  hostEntryId,
  savedHostEntry,
  validateSavedHostInput,
  validateSavedHostKeyRef,
  type HostEntry,
  type SavedHost,
  type SavedHostInput,
  type SavedHostSnapshot,
} from '@pocketshell/core';
import { api } from '../ipc';
import type { PlatformHostStore } from '../api';
import { useConnectionStore } from './connection';
import { useSettingsStore } from './settings';

/**
 * The shared host-list model: which host is the default, and — on a platform
 * that owns its host list — create, edit, delete and reorder.
 *
 * Two kinds of platform mount this UI:
 *
 *   - A platform that READS its hosts (desktop: ~/.ssh/config; web: the
 *     synced account) provides no `api.hosts.store`. The list is whatever
 *     `ssh.listConfigHosts()` says, identity is the `Host` alias, and the
 *     default host is the renderer's `settings.defaultHost`. Nothing here
 *     changes for it.
 *   - A platform that OWNS its hosts (Android) provides `api.hosts.store`, a
 *     one-to-one bridge onto core's SavedHostStore. The store's snapshot is
 *     then the single source of the list, its order and its default host:
 *     every mutation answers with a fresh snapshot and this store only
 *     mirrors it, so there is no second copy that can drift. Identity is the
 *     saved host's stable `id`, which is what survives a rename.
 *
 * Input is validated here with the same core function SavedHostStore runs
 * before its write, so an editor gets the store's own message without a
 * round trip; the platform validates again, and its rejection wins.
 */
export const useHostsStore = defineStore('hosts', () => {
  const settings = useSettingsStore();
  /** The platform store's hosts, credential references included, in its order. */
  const saved = shallowRef<SavedHost[]>([]);
  const savedDefaultId = ref<string | null>(null);

  /** True when the platform owns its host list and accepts edits. */
  const editable = computed(() => api.hosts?.store !== undefined);

  /** The saved hosts as the picker's list rows. */
  const entries = computed<HostEntry[]>(() => saved.value.map(savedHostEntry));

  /**
   * The default host's identity ({@link hostEntryId}), from whichever source
   * owns it on this platform.
   */
  const defaultHostKey = computed<string | null>(() =>
    editable.value ? savedDefaultId.value : settings.defaultHost,
  );

  function manager(): PlatformHostStore {
    const hostStore = api.hosts?.store;
    if (!hostStore) throw new Error('This platform reads its hosts from elsewhere; they cannot be edited here.');
    return hostStore;
  }

  function apply(snapshot: SavedHostSnapshot): HostEntry[] {
    saved.value = snapshot.hosts;
    savedDefaultId.value = snapshot.defaultHostId;
    const list = entries.value;
    useConnectionStore().hosts = list;
    return list;
  }

  /** Read the platform store. Rejections (malformed stored data) propagate untouched. */
  async function load(): Promise<HostEntry[]> {
    return apply(await manager().load());
  }

  /** The store's own validation, for an editor to show before submitting. */
  function validate(input: SavedHostInput): SavedHostInput {
    return validateSavedHostInput(input, validateSavedHostKeyRef);
  }

  /** Add a host; resolves to its list row, carrying the stable id the platform allocated. */
  async function add(input: SavedHostInput): Promise<HostEntry> {
    const normalized = validate(input);
    const before = new Set(saved.value.map((host) => host.id));
    apply(await manager().add(normalized));
    const created = entries.value.find((host) => !before.has(hostEntryId(host)));
    if (!created) throw new Error('The new host did not appear in the saved host list.');
    return created;
  }

  async function update(id: string, input: SavedHostInput): Promise<void> {
    apply(await manager().update(id, validate(input)));
  }

  async function remove(id: string): Promise<void> {
    apply(await manager().delete(id));
  }

  async function move(id: string, index: number): Promise<void> {
    apply(await manager().move(id, index));
  }

  /** The saved record behind a list row, for an editor to prefill (key reference included). */
  function savedHost(id: string): SavedHost | null {
    return saved.value.find((host) => host.id === id) ?? null;
  }

  function isDefault(host: Pick<HostEntry, 'id' | 'name'>): boolean {
    return defaultHostKey.value === hostEntryId(host);
  }

  /** Set or clear the default host, in the store that owns it on this platform. */
  async function setDefaultHost(key: string | null): Promise<void> {
    if (editable.value) {
      apply(await manager().setDefault(key));
      return;
    }
    settings.set('defaultHost', key);
  }

  /** The picker's star: make this host the default, or clear it. */
  function toggleDefault(host: Pick<HostEntry, 'id' | 'name'>): Promise<void> {
    return setDefaultHost(isDefault(host) ? null : hostEntryId(host));
  }

  return {
    saved,
    editable,
    entries,
    defaultHostKey,
    load,
    validate,
    add,
    update,
    remove,
    move,
    savedHost,
    isDefault,
    setDefaultHost,
    toggleDefault,
  };
});
