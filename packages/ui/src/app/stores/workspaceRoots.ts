import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import {
  HostWorkspaceRoots,
  RestoredWorkspaceRootsLedger,
  WorkspaceRootOrderStore,
  workspaceRootsCliForConnection,
  type WorkspaceMembership,
  type WorkspaceRootsState,
  type WorkspaceStringStorage,
} from '@pocketshell/core';
import { api } from '../ipc';
import { useConnectionStore } from './connection';
import { useSettingsStore } from './settings';

/**
 * Where the session panel's registered ROOTS come from.
 *
 * Two sources, chosen by a platform capability rather than by a fallback:
 *
 *   - **host** — the platform provides `api.workspaces`, the host CLI's
 *     `pocketshell workspaces` contract (core `workspaceRootsApiFromExec`).
 *     The roots are the host's own registrations, partitioned by the stable
 *     host identity, so they follow the host rather than the device and two
 *     hosts that both register `~/git` never collide. The ORDER is a client
 *     preference, kept per host identity in local storage. A failed or
 *     malformed listing is an error the panel shows, never an empty list.
 *   - **local** — no `api.workspaces`: the roots are the per-host list in
 *     Settings, exactly as before.
 *
 * A platform that turns the capability on keeps its users' Settings roots:
 * the first listing for a host registers the ones the host does not have yet,
 * once, and seeds their order. The Settings value is only read, never cleared.
 */
function browserStorage(): WorkspaceStringStorage {
  try {
    if (typeof globalThis.localStorage !== 'undefined') return globalThis.localStorage;
  } catch {
    // Blocked storage: order changes fail visibly on write instead.
  }
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

export const useWorkspaceRootsStore = defineStore('workspaceRoots', () => {
  const settings = useSettingsStore();
  const hostManaged = computed(() => api.workspaces !== undefined);

  let model: HostWorkspaceRoots | null = null;
  let orderStore: WorkspaceRootOrderStore | null = null;
  const state = ref<WorkspaceRootsState>({
    hostIdentity: null,
    status: 'idle',
    memberships: null,
    error: null,
    mutating: false,
    mutationError: null,
    notice: null,
    rootOrder: [],
  });
  const orderLoadError = ref<string | null>(null);
  const boundConnection = ref<string | null>(null);
  /** The in-flight (or settled) load for the current binding, so a second
   *  caller for the same binding waits on it instead of re-listing. */
  let bindTask: Promise<void> = Promise.resolve();
  let bindKey = '';

  function ensureModel(): HostWorkspaceRoots {
    if (model) return model;
    const storage = browserStorage();
    orderStore = new WorkspaceRootOrderStore(storage);
    orderLoadError.value = orderStore.loadError;
    model = new HostWorkspaceRoots(orderStore, new RestoredWorkspaceRootsLedger(storage));
    model.subscribe((next) => {
      state.value = next;
    });
    return model;
  }

  /**
   * Follow the active connection. `host` is the stable host identity (the SSH
   * alias on desktop, the saved-host id on a phone); an empty host or a null
   * connection clears the host-scoped state.
   */
  async function bind(connectionId: string | null, host: string): Promise<void> {
    const workspaces = api.workspaces;
    if (!workspaces) return;
    const roots = ensureModel();
    const key = connectionId && host ? `${connectionId}\u0000${host}` : '';
    if (key === bindKey) return bindTask;
    bindKey = key;
    if (!connectionId || !host) {
      boundConnection.value = null;
      bindTask = roots.select(null);
      return bindTask;
    }
    boundConnection.value = connectionId;
    const local = settings.sessionRootsFor(host);
    bindTask = roots.select({
      hostIdentity: host,
      cli: workspaceRootsCliForConnection(workspaces, connectionId),
      previousRoots: local.length ? { roots: local, rootOrder: local } : null,
    });
    return bindTask;
  }

  async function refresh(): Promise<void> {
    if (hostManaged.value) await ensureModel().refresh();
  }

  /** The registered roots, in display order, as membership rows. */
  function membershipsFor(host: string, home: string | null = null): WorkspaceMembership[] {
    if (!hostManaged.value || !host || state.value.hostIdentity !== host) return [];
    // Read the reactive state so a computed over this call re-runs on change.
    void state.value.memberships;
    void state.value.rootOrder;
    return ensureModel().ordered(home);
  }

  /**
   * The root paths the tree groups under for [host]. Host mode answers only
   * for the host it is bound to — another host's registrations are not known
   * here, and borrowing them would be exactly the cross-host collision the
   * identity partition exists to prevent.
   */
  function rootsFor(host: string, home: string | null = null): string[] {
    if (!hostManaged.value) return settings.sessionRootsFor(host);
    return membershipsFor(host, home).map((workspace) => workspace.path);
  }

  async function add(host: string, path: string, home: string | null = null): Promise<boolean> {
    if (!hostManaged.value) return settings.addSessionRoot(host, path);
    if (state.value.hostIdentity !== host) return false;
    return ensureModel().addRoot(path, home);
  }

  async function remove(host: string, path: string): Promise<boolean> {
    if (!hostManaged.value) {
      settings.removeSessionRoot(host, path);
      return true;
    }
    if (state.value.hostIdentity !== host) return false;
    return ensureModel().removeRoot(path);
  }

  function move(host: string, path: string, direction: -1 | 1, home: string | null = null): boolean {
    if (!hostManaged.value || state.value.hostIdentity !== host) return false;
    return ensureModel().moveRoot(path, direction, home);
  }

  function clearMessages(): void {
    if (model) model.clearMessages();
  }

  return {
    hostManaged,
    state,
    orderLoadError,
    bind,
    refresh,
    membershipsFor,
    rootsFor,
    add,
    remove,
    move,
    clearMessages,
  };
});

/**
 * Keep the store bound to the active connection for as long as the calling
 * component (the host workspace) is mounted, so the panel's roots are always
 * the connected host's.
 */
export function useWorkspaceRootsBinding(): void {
  const connection = useConnectionStore();
  const workspaceRoots = useWorkspaceRootsStore();
  watch(
    () => [connection.connectionId, connection.activeHost?.name ?? ''] as const,
    ([connectionId, host]) => {
      void workspaceRoots.bind(connectionId, host);
    },
    { immediate: true },
  );
}
