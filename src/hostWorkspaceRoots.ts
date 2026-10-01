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
  clearTimer: (timer: unknown) => void = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
): HostCliTransport['exec'] {
  return (command, timeoutMs) => new Promise<HostCliExecOutcome>((resolve, reject) => {
    let settled = false;
    const timer = setTimer(() => {
      if (settled) return;
      settled = true;
      resolve({ exitCode: null, stdout: '', stderr: '', timedOut: true });
    }, timeoutMs);
    // A fast answer releases the deadline instead of leaving it pending.
    const finish = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimer(timer);
      return true;
    };
    exec(command).then((outcome) => {
      if (finish()) resolve({ ...outcome, timedOut: false });
    }, (error: unknown) => {
      if (finish()) reject(error);
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

/** The ledger entry that marks EVERY host as already restored. */
const ALL_HOSTS_RESTORED = '*';

/**
 * Host identities whose previous-client roots were already restored once.
 *
 * FAILS CLOSED: a record that cannot be read counts as "every host already
 * restored". Treating it as empty would re-register roots the user removed on
 * purpose, which is the one thing a one-time restore must never do. The
 * unreadable value is preserved beside it and reported once; the record is
 * then rewritten to the readable "every host restored" form, so it stays
 * closed without reporting the same damage on every listing and restart.
 */
export class RestoredWorkspaceRootsLedger {
  /** Why the record could not be read; the restore is skipped while set. */
  readonly loadError: string | null;

  constructor(private readonly storage: WorkspaceStringStorage, now: () => number = Date.now) {
    let loadError: string | null = null;
    const raw = storage.getItem(WORKSPACE_ROOTS_RESTORED_STORAGE_KEY);
    if (raw !== null && this.parse(raw) === null) {
      loadError = 'The workspace roots restore record is unreadable, so roots saved on this device were not '
        + 'restored again; the unreadable copy was kept.';
      try {
        storage.setItem(`${WORKSPACE_ROOTS_RESTORED_STORAGE_KEY}.unreadable-${now()}`, raw);
        // Only after the copy is safe: repair to the closed, readable form.
        storage.setItem(WORKSPACE_ROOTS_RESTORED_STORAGE_KEY, JSON.stringify([ALL_HOSTS_RESTORED]));
      } catch {
        loadError = 'The workspace roots restore record is unreadable and could not be preserved; '
          + 'roots saved on this device were not restored again.';
      }
    }
    this.loadError = loadError;
  }

  private parse(raw: string): string[] | null {
    try {
      const value: unknown = JSON.parse(raw);
      return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
    } catch {
      return null;
    }
  }

  private read(): string[] | null {
    const raw = this.storage.getItem(WORKSPACE_ROOTS_RESTORED_STORAGE_KEY);
    return raw === null ? [] : this.parse(raw);
  }

  has(hostIdentity: string): boolean {
    const current = this.read();
    return current === null || current.includes(ALL_HOSTS_RESTORED) || current.includes(hostIdentity);
  }

  add(hostIdentity: string): void {
    const current = this.read();
    if (current === null || current.includes(ALL_HOSTS_RESTORED) || current.includes(hostIdentity)) return;
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
  /**
   * Bumped by every registration change (add, remove, restore) as it starts.
   * A listing records it when sent; if it moved by the time the reply lands,
   * the listing may predate that change and is re-read instead of written.
   */
  private generation = 0;
  /** The registration change holding the lock, tagged with its epoch. */
  private operation: { epoch: number } | null = null;
  /** Every listing's send order; only the latest one sent may be written. */
  private listSequence = 0;
  /** The current selection's one-time restore still waits for an accepted listing. */
  private restoreDue = false;
  /** A listing arrived (or was owed) while an operation held the lock. */
  private relistAfterOperation = false;
  /** An unreadable restore record is reported once per process. */
  private restoreErrorShown = false;
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
    // Whatever was in flight belongs to the old epoch: it can no longer write
    // this view, and it no longer holds the lock (see `busy`).
    this.relistAfterOperation = false;
    this.restoreDue = false;
    if (!selection) {
      this.state = emptyState(null, []);
      this.set({});
      return;
    }
    if (previous?.hostIdentity !== selection.hostIdentity) {
      this.state = emptyState(selection.hostIdentity, this.order.get(selection.hostIdentity).rootOrder);
    } else {
      // Same host, new connection (a reconnect): the rows stay, the controls
      // unlock unless the new connection starts its own operation.
      this.state = { ...this.state, mutating: false, mutationError: null, notice: null };
    }
    await this.refresh();
  }

  /**
   * True while an add, remove or restore started in THIS epoch is running.
   * It is the one lock: at most one registration change per host connection
   * at a time, and `mutating` reports exactly this.
   */
  private busy(): boolean {
    return this.operation !== null && this.operation.epoch === this.epoch;
  }

  /**
   * Run one registration change under the lock. `body` returns whether it
   * completed in its own epoch; a superseded body has already routed its
   * late reply through `settleSuperseded`.
   *
   * The generation moves when the change STARTS and again when it ENDS —
   * superseded changes included — so any listing whose send-to-reply window
   * overlapped a change, in either direction, sees a different generation.
   * (The start bump is subsumed today — a reply landing mid-change is already
   * deferred by `busy()` and the end bump follows — but it keeps the rule
   * true on its own, without leaning on that ordering.)
   */
  private async locked<T>(body: (epoch: number) => Promise<T>): Promise<T> {
    const operation = { epoch: this.epoch };
    this.operation = operation;
    this.generation += 1;
    this.set({ mutating: true });
    try {
      return await body(operation.epoch);
    } finally {
      this.generation += 1;
      if (this.operation === operation) this.operation = null;
      if (operation.epoch === this.epoch) {
        this.set({ mutating: false });
        await this.flushRelist();
      }
    }
  }

  /**
   * Re-read the host's registrations, and decide the one-time restore on the
   * first listing this selection accepts. A failure keeps last-known rows.
   */
  async refresh(): Promise<void> {
    if (!this.selection) return;
    this.restoreDue = true;
    await this.list();
  }

  /**
   * Send one listing and apply its reply under the ONE rule every listing
   * obeys (the invariant this class exists to keep):
   *
   *   A listing reply is written only if (1) its epoch is still current,
   *   (2) it is the LATEST listing sent, (3) the generation is unchanged since
   *   it was sent — no add, remove, move or restore started or ended in
   *   between — and (4) no change is running now. Otherwise it is dropped;
   *   if it was the latest listing, it is re-read (after the running change,
   *   if any), so the view always converges on a listing no change overlapped.
   *
   * The restore decision is made only on an accepted listing; a dropped one
   * leaves it due for the next accepted listing rather than postponing it.
   */
  private async list(): Promise<void> {
    const selection = this.selection;
    if (!selection) return;
    const epoch = this.epoch;
    const generation = this.generation;
    const sequence = ++this.listSequence;
    this.set({ status: 'loading', error: null });
    let listing: WorkspacesListing;
    try {
      listing = await selection.cli.listWorkspaces(selection.hostIdentity);
    } catch (error) {
      if (epoch !== this.epoch || sequence !== this.listSequence) return;
      this.set({ status: 'error', error: `Could not read workspace roots from the host: ${describe(error)}` });
      return;
    }
    if (epoch !== this.epoch) return;
    // (2) A newer listing is out: it answers for the view, this one is moot.
    if (sequence !== this.listSequence) return;
    if (this.busy()) {
      // (4) Read again once the running change has settled. The rows are
      // still owed a fresh read, so the view keeps saying `loading`.
      this.relistAfterOperation = true;
      return;
    }
    if (generation !== this.generation) {
      // (3) A change overlapped this listing; it may predate that change.
      await this.list();
      return;
    }
    this.set({ status: 'ready', memberships: listing.workspaces, error: null });
    if (this.restoreDue) {
      this.restoreDue = false;
      await this.restorePrevious(selection, listing.workspaces);
    }
  }

  /** A plain re-read: it may decide a restore only if one is still due. */
  private async relist(): Promise<void> {
    await this.list();
  }

  private async flushRelist(): Promise<void> {
    if (!this.relistAfterOperation || this.busy()) return;
    this.relistAfterOperation = false;
    await this.relist();
  }

  /**
   * A reply that arrived after its epoch ended. The host may well have applied
   * the command, so re-read rather than guess — but only while the SAME host
   * is still selected (another host's view must not hear about it at all),
   * only as a plain listing (never a second restore), and only once the
   * current connection's own operation, if any, has finished.
   */
  private async settleSuperseded(selection: WorkspaceRootsSelection): Promise<void> {
    if (this.selection?.hostIdentity !== selection.hostIdentity) return;
    if (this.busy()) {
      this.relistAfterOperation = true;
      return;
    }
    await this.relist();
  }

  private async restorePrevious(
    selection: WorkspaceRootsSelection,
    memberships: readonly WorkspaceMembership[],
  ): Promise<void> {
    const previous = selection.previousRoots;
    if (!previous) return;
    const identity = selection.hostIdentity;
    if (this.order.seed(identity, { rootOrder: previous.rootOrder })) {
      this.set({ rootOrder: this.order.get(identity).rootOrder });
    }
    if (this.restored.loadError && !this.restoreErrorShown) {
      // Said once per process; the ledger has already repaired the record.
      this.restoreErrorShown = true;
      this.set({ mutationError: this.restored.loadError });
      return;
    }
    if (this.restored.has(identity)) return;
    const home = homeFromWorkspaceMemberships(memberships);
    const keyOf = (path: string) => directoryKey(normaliseRootPath(path) ?? path, home);
    const registered = new Set(memberships.map((workspace) => keyOf(workspace.path)));
    const missing = previous.roots.filter((root) => !registered.has(keyOf(root)));
    if (missing.length === 0) {
      this.restored.add(identity);
      return;
    }
    await this.locked(async (epoch) => {
      let latest: WorkspaceMembership[] = [...memberships];
      try {
        for (const root of missing) {
          const listing = await selection.cli.addWorkspace(identity, root);
          if (epoch !== this.epoch) {
            await this.settleSuperseded(selection);
            return;
          }
          latest = listing.workspaces;
        }
        this.restored.add(identity);
        this.set({
          memberships: latest,
          notice: `Restored ${missing.length} workspace root${missing.length === 1 ? '' : 's'} saved on this device.`,
        });
      } catch (error) {
        if (epoch !== this.epoch) {
          await this.settleSuperseded(selection);
          return;
        }
        this.set({
          memberships: latest,
          mutationError: `Could not restore a workspace root saved on this device: ${describe(error)}`,
        });
      }
    });
  }

  /** Register a root through `workspaces add`; returns true on success. */
  async addRoot(raw: string, home: string | null = null): Promise<boolean> {
    const selection = this.selection;
    if (!selection || this.busy()) return false;
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
    if (!selection || this.busy()) return false;
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
    this.set({ mutationError: null, notice: null });
    return this.locked(async (epoch) => {
      try {
        const listing = await run(selection.cli);
        if (epoch !== this.epoch) {
          await this.settleSuperseded(selection);
          return false;
        }
        this.set({ memberships: listing.workspaces, status: 'ready', error: null, notice: success });
        return true;
      } catch (error) {
        if (epoch !== this.epoch) {
          await this.settleSuperseded(selection);
          return false;
        }
        this.set({ mutationError: describe(error) });
        return false;
      }
    });
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
    // A move is a change too: it starts and ends inside this call, so any
    // listing in flight across it is re-read (the listing rule in `list`).
    this.generation += 2;
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
