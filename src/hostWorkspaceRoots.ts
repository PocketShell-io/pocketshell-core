/**
 * One host's registered workspace roots, sequenced over the host CLI.
 *
 * Framework-free: the shared UI wraps this in a store, and any client with a
 * `HostCliTransport` can use it directly. `hostWorkspaceTree.ts` holds the
 * pure policy (projection, order, validation, the persisted format); this
 * class only sequences it for the selected host:
 *
 *   - reads the memberships with `pocketshell workspaces list --host ID`;
 *   - applies root add/remove through `workspaces add|remove` — a registration
 *     change only; no folder is deleted and no session is stopped;
 *   - keeps an answer that arrives for a previous host or connection out of
 *     the current view (every selection bumps an epoch);
 *   - keeps a failed or malformed listing VISIBLE as an error over whatever
 *     was last known, never as an empty root list;
 *   - restores, once per host, the roots a previous client kept locally
 *     (a 0.5.x Android install, a desktop setting) by registering the missing
 *     ones on the host, without ever overwriting an order chosen here.
 */
import { HostCliWorkspaces, type WorkspaceMembership, type WorkspacesListing } from './hostCliWorkspaces';
import type { HostCliExecOutcome, HostCliTransport } from './hostCliCommon';
import {
  emptyWorkspacePreferences,
  homeFromWorkspaceMemberships,
  hostWorkspacePreferences,
  moveWorkspaceRoot,
  orderWorkspaceMemberships,
  parseWorkspacePreferences,
  seedHostWorkspacePreferences,
  serializeWorkspacePreferences,
  validateWorkspaceRootInput,
  withHostWorkspacePreferences,
  type HostWorkspacePreferences,
  type WorkspacePreferencesDocument,
} from './hostWorkspaceTree';
import { directoryKey, normaliseRootPath } from './sessionRoots';

export const WORKSPACE_ROOT_ORDER_STORAGE_KEY = 'pocketshell.workspace-roots.order.v1';
export const WORKSPACE_ROOTS_RESTORED_STORAGE_KEY = 'pocketshell.workspace-roots.restored.v1';

/** The host CLI surface the workspace layer uses; `HostCliCore` satisfies it. */
export interface WorkspaceRootsCli {
  listWorkspaces(host: string): Promise<WorkspacesListing>;
  addWorkspace(host: string, path: string): Promise<WorkspacesListing>;
  removeWorkspace(host: string, path: string): Promise<WorkspacesListing>;
}

/**
 * The platform-transport shape of the same three verbs, keyed by connection.
 * The shared UI's `PocketShellApi.workspaces` group is this interface; a
 * platform builds it with {@link workspaceRootsApiFromExec}.
 */
export interface WorkspaceRootsApi {
  list(connectionId: string, host: string): Promise<WorkspacesListing>;
  add(connectionId: string, host: string, path: string): Promise<WorkspacesListing>;
  remove(connectionId: string, host: string, path: string): Promise<WorkspacesListing>;
}

/**
 * Build the transport group from a platform's exec primitive. The command and
 * its parsing stay in `HostCliWorkspaces`, so no platform writes a second
 * `workspaces` command or parser.
 */
export function workspaceRootsApiFromExec(
  exec: (connectionId: string, command: string, timeoutMs: number) => Promise<HostCliExecOutcome>,
  binary = 'pocketshell',
): WorkspaceRootsApi {
  const cli = (connectionId: string) => new HostCliWorkspaces(
    { exec: (command, timeoutMs) => exec(connectionId, command, timeoutMs) },
    binary,
  );
  return {
    list: (connectionId, host) => cli(connectionId).listWorkspaces(host),
    add: (connectionId, host, path) => cli(connectionId).addWorkspace(host, path),
    remove: (connectionId, host, path) => cli(connectionId).removeWorkspace(host, path),
  };
}

/** Bind a {@link WorkspaceRootsApi} to one connection. */
export function workspaceRootsCliForConnection(api: WorkspaceRootsApi, connectionId: string): WorkspaceRootsCli {
  return {
    listWorkspaces: (host) => api.list(connectionId, host),
    addWorkspace: (host, path) => api.add(connectionId, host, path),
    removeWorkspace: (host, path) => api.remove(connectionId, host, path),
  };
}

/**
 * Give an exec that has no deadline of its own one, reported the way the host
 * CLI modules expect (`timedOut`), so a hung host command cannot leave the
 * workspace list loading forever.
 */
export function execWithDeadline(
  exec: (command: string) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>,
  setTimer: (callback: () => void, milliseconds: number) => unknown = setTimeout,
): HostCliTransport['exec'] {
  return (command, timeoutMs) => new Promise<HostCliExecOutcome>((resolve, reject) => {
    let settled = false;
    setTimer(() => {
      if (settled) return;
      settled = true;
      resolve({ exitCode: null, stdout: '', stderr: '', timedOut: true });
    }, timeoutMs);
    exec(command).then((outcome) => {
      if (settled) return;
      settled = true;
      resolve({ ...outcome, timedOut: false });
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

export interface WorkspaceStringStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Durable per-host root order over a string storage area. */
export class WorkspaceRootOrderStore {
  private document: WorkspacePreferencesDocument;
  /** Why the stored order could not be read; shown, never swallowed. */
  readonly loadError: string | null;

  constructor(private readonly storage: WorkspaceStringStorage, now: () => number = Date.now) {
    let raw: string | null = null;
    let loadError: string | null = null;
    let document = emptyWorkspacePreferences();
    try {
      raw = storage.getItem(WORKSPACE_ROOT_ORDER_STORAGE_KEY);
      document = parseWorkspacePreferences(raw);
    } catch (error) {
      loadError = `${error instanceof Error ? error.message : String(error)} Root order starts fresh; the unreadable copy was kept.`;
      if (raw !== null) {
        try {
          storage.setItem(`${WORKSPACE_ROOT_ORDER_STORAGE_KEY}.unreadable-${now()}`, raw);
        } catch {
          loadError = 'Saved workspace root order is unreadable and could not be preserved.';
        }
      }
    }
    this.document = document;
    this.loadError = loadError;
  }

  get(hostIdentity: string): HostWorkspacePreferences {
    return hostWorkspacePreferences(this.document, hostIdentity);
  }

  set(hostIdentity: string, preferences: HostWorkspacePreferences): void {
    this.commit(withHostWorkspacePreferences(this.document, hostIdentity, preferences));
  }

  /** Seed a host that has no order yet; returns true when it was written. */
  seed(hostIdentity: string, preferences: HostWorkspacePreferences): boolean {
    const next = seedHostWorkspacePreferences(this.document, hostIdentity, preferences);
    if (next === this.document) return false;
    this.commit(next);
    return true;
  }

  private commit(next: WorkspacePreferencesDocument): void {
    this.storage.setItem(WORKSPACE_ROOT_ORDER_STORAGE_KEY, serializeWorkspacePreferences(next));
    this.document = next;
  }
}

/** Host identities whose previous-client roots were already restored once. */
export class RestoredWorkspaceRootsLedger {
  constructor(private readonly storage: WorkspaceStringStorage) {}

  private read(): string[] {
    try {
      const value: unknown = JSON.parse(this.storage.getItem(WORKSPACE_ROOTS_RESTORED_STORAGE_KEY) ?? '[]');
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  has(hostIdentity: string): boolean {
    return this.read().includes(hostIdentity);
  }

  add(hostIdentity: string): void {
    const current = this.read();
    if (current.includes(hostIdentity)) return;
    this.storage.setItem(WORKSPACE_ROOTS_RESTORED_STORAGE_KEY, JSON.stringify([...current, hostIdentity]));
  }
}

export type WorkspaceRootsStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface WorkspaceRootsState {
  hostIdentity: string | null;
  status: WorkspaceRootsStatus;
  /** The host's registrations; null until a listing for THIS host succeeded. */
  memberships: WorkspaceMembership[] | null;
  /** Why the last listing failed — kept visible over any last-known rows. */
  error: string | null;
  mutating: boolean;
  mutationError: string | null;
  notice: string | null;
  rootOrder: string[];
}

/** Roots a previous client kept for this host, restored once. */
export interface PreviousWorkspaceRoots {
  /** Root paths to register on the host if it does not have them yet. */
  roots: string[];
  /** The order to seed when this host has no order of its own yet. */
  rootOrder: string[];
}

export interface WorkspaceRootsSelection {
  /** The stable identity passed to `workspaces --host`. */
  hostIdentity: string;
  cli: WorkspaceRootsCli;
  previousRoots?: PreviousWorkspaceRoots | null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyState(hostIdentity: string | null, rootOrder: string[]): WorkspaceRootsState {
  return {
    hostIdentity,
    status: 'idle',
    memberships: null,
    error: null,
    mutating: false,
    mutationError: null,
    notice: null,
    rootOrder,
  };
}

export class HostWorkspaceRoots {
  private state: WorkspaceRootsState = emptyState(null, []);
  private selection: WorkspaceRootsSelection | null = null;
  private epoch = 0;
  private readonly listeners = new Set<(state: WorkspaceRootsState) => void>();

  constructor(
    private readonly order: WorkspaceRootOrderStore,
    private readonly restored: RestoredWorkspaceRootsLedger,
  ) {}

  getState(): WorkspaceRootsState {
    return {
      ...this.state,
      memberships: this.state.memberships ? [...this.state.memberships] : null,
      rootOrder: [...this.state.rootOrder],
    };
  }

  subscribe(listener: (state: WorkspaceRootsState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  private set(update: Partial<WorkspaceRootsState>): void {
    this.state = { ...this.state, ...update };
    const snapshot = this.getState();
    for (const listener of this.listeners) listener(snapshot);
  }

  /**
   * Point at a host (or at nothing). A different host identity resets every
   * host-scoped field before anything is read, and the epoch bump discards
   * answers still in flight for the previous host or connection.
   */
  async select(selection: WorkspaceRootsSelection | null): Promise<void> {
    const previous = this.selection;
    this.selection = selection;
    this.epoch += 1;
    if (!selection) {
      this.state = emptyState(null, []);
      this.set({});
      return;
    }
    if (previous?.hostIdentity !== selection.hostIdentity) {
      this.state = emptyState(selection.hostIdentity, this.order.get(selection.hostIdentity).rootOrder);
    }
    await this.refresh();
  }

  /** Re-read the host's registrations; a failure keeps last-known rows. */
  async refresh(): Promise<void> {
    const selection = this.selection;
    if (!selection) return;
    const epoch = this.epoch;
    this.set({ status: 'loading', error: null });
    try {
      const listing = await selection.cli.listWorkspaces(selection.hostIdentity);
      if (epoch !== this.epoch) return;
      this.set({ status: 'ready', memberships: listing.workspaces, error: null });
      await this.restorePrevious(selection, listing.workspaces, epoch);
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.set({ status: 'error', error: `Could not read workspace roots from the host: ${describe(error)}` });
    }
  }

  private async restorePrevious(
    selection: WorkspaceRootsSelection,
    memberships: readonly WorkspaceMembership[],
    epoch: number,
  ): Promise<void> {
    const previous = selection.previousRoots;
    if (!previous) return;
    const identity = selection.hostIdentity;
    if (this.order.seed(identity, { rootOrder: previous.rootOrder })) {
      this.set({ rootOrder: this.order.get(identity).rootOrder });
    }
    if (this.restored.has(identity)) return;
    const home = homeFromWorkspaceMemberships(memberships);
    const keyOf = (path: string) => directoryKey(normaliseRootPath(path) ?? path, home);
    const registered = new Set(memberships.map((workspace) => keyOf(workspace.path)));
    const missing = previous.roots.filter((root) => !registered.has(keyOf(root)));
    let latest: WorkspaceMembership[] = [...memberships];
    if (missing.length > 0) this.set({ mutating: true });
    try {
      for (const root of missing) {
        const listing = await selection.cli.addWorkspace(identity, root);
        if (epoch !== this.epoch) return;
        latest = listing.workspaces;
      }
      this.restored.add(identity);
      this.set({
        memberships: latest,
        mutating: false,
        notice: missing.length > 0
          ? `Restored ${missing.length} workspace root${missing.length === 1 ? '' : 's'} saved on this device.`
          : this.state.notice,
      });
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.set({
        memberships: latest,
        mutating: false,
        mutationError: `Could not restore a workspace root saved on this device: ${describe(error)}`,
      });
    }
  }

  /** Register a root through `workspaces add`; returns true on success. */
  async addRoot(raw: string, home: string | null = null): Promise<boolean> {
    const selection = this.selection;
    if (!selection || this.state.mutating) return false;
    const memberships = this.state.memberships ?? [];
    const validation = validateWorkspaceRootInput(raw, memberships, home ?? homeFromWorkspaceMemberships(memberships));
    if (!validation.ok) {
      this.set({ mutationError: validation.message, notice: null });
      return false;
    }
    return this.mutate(
      selection,
      (cli) => cli.addWorkspace(selection.hostIdentity, validation.path),
      `Added ${validation.path} to this host's workspace roots.`,
    );
  }

  /** Unregister a root through `workspaces remove`. Files and sessions stay. */
  async removeRoot(path: string): Promise<boolean> {
    const selection = this.selection;
    if (!selection || this.state.mutating) return false;
    return this.mutate(
      selection,
      (cli) => cli.removeWorkspace(selection.hostIdentity, path),
      `Removed ${path} from this host's workspace roots. Its files and sessions were not touched.`,
    );
  }

  private async mutate(
    selection: WorkspaceRootsSelection,
    run: (cli: WorkspaceRootsCli) => Promise<WorkspacesListing>,
    success: string,
  ): Promise<boolean> {
    const epoch = this.epoch;
    this.set({ mutating: true, mutationError: null, notice: null });
    try {
      const listing = await run(selection.cli);
      if (epoch !== this.epoch) return false;
      this.set({ memberships: listing.workspaces, mutating: false, status: 'ready', error: null, notice: success });
      return true;
    } catch (error) {
      if (epoch !== this.epoch) return false;
      this.set({ mutating: false, mutationError: describe(error) });
      return false;
    }
  }

  /** The registered roots in display order. */
  ordered(home: string | null = null): WorkspaceMembership[] {
    const memberships = this.state.memberships ?? [];
    return orderWorkspaceMemberships(
      memberships,
      this.state.rootOrder,
      home ?? homeFromWorkspaceMemberships(memberships),
    );
  }

  /** Persist a new position for one registered root. */
  moveRoot(path: string, direction: -1 | 1, home: string | null = null): boolean {
    const identity = this.state.hostIdentity;
    if (!identity || !this.state.memberships) return false;
    const next = moveWorkspaceRoot(this.ordered(home), path, direction);
    if (!next) return false;
    try {
      this.order.set(identity, { rootOrder: next });
    } catch (error) {
      this.set({ mutationError: `Could not save the root order: ${describe(error)}` });
      return false;
    }
    this.set({ rootOrder: this.order.get(identity).rootOrder });
    return true;
  }

  clearMessages(): void {
    this.set({ mutationError: null, notice: null });
  }
}
