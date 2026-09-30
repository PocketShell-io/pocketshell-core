/**
 * Host-registered workspace roots: the `pocketshell workspaces` membership list
 * (one host's registered ROOTS) folded into the shared root -> folder ->
 * session projection that {@link groupSessionsIntoRoots} renders.
 *
 * Everything here is pure policy for a client whose roots come from the host
 * CLI rather than from a local setting:
 *
 *   - mapping the host CLI's {@link SessionRow} onto the {@link SessionSummary}
 *     the grouping algebra consumes;
 *   - recovering `$HOME` from the memberships the host itself canonicalised;
 *   - root ORDER, a presentation preference the host CLI deliberately does not
 *     own (it answers sorted by path), persisted per stable host identity so
 *     two hosts that both register `/home/me/git` can never share or overwrite
 *     each other's arrangement;
 *   - validation of a root the user types before it reaches the host.
 *
 * No I/O. Removing a root is a host registration change only — nothing here
 * can express deleting a folder or stopping a session.
 */
import type { SessionSummary } from './types';
import type { SessionRow } from './hostCliSessions';
import type { WorkspaceMembership } from './hostCliWorkspaces';
import {
  directoryKey,
  inferHome,
  normaliseHome,
  normaliseRootPath,
  SESSION_ROOTS_MAX,
} from './sessionRoots';
import { groupSessionsIntoRoots, type SessionRootFolder } from './sessionTree';

/**
 * The host CLI's session row in the shape the shared grouping reads.
 *
 * Host CLI sessions are aplexer sessions: `workspace` is the session's
 * canonical working directory and `tag` its name within that workspace, so the
 * row files under its folder with no inference and is addressed by workspace
 * plus tag rather than by a name that can repeat across folders.
 */
export function sessionSummaryFromHostRow(row: SessionRow): SessionSummary {
  const created = row.createdEpoch ?? 0;
  return {
    name: row.name,
    created,
    activity: row.activityEpoch ?? created,
    attached: row.attached,
    path: row.workspace,
    backend: 'aplexer',
    workspace: row.workspace,
    tag: row.tag,
    aplexerId: row.id,
    profile: row.profile,
  };
}

/**
 * Recover the host's `$HOME` from the memberships themselves.
 *
 * The host CLI returns each root as a canonical absolute `path` plus the
 * `display_path` the user registered it with. A `~/git` display beside a
 * `/home/me/git` path IS the host's own expansion of `~` — better evidence
 * than guessing from the path shape, which is only the fallback.
 */
export function homeFromWorkspaceMemberships(workspaces: readonly WorkspaceMembership[]): string | null {
  for (const workspace of workspaces) {
    const display = workspace.displayPath.trim().replace(/\/+$/, '');
    const path = workspace.path.trim().replace(/\/+$/, '');
    if (!path.startsWith('/')) continue;
    if (display === '~') return normaliseHome(path);
    if (!display.startsWith('~/')) continue;
    const suffix = display.slice(1);
    if (path.length > suffix.length && path.endsWith(suffix)) {
      return normaliseHome(path.slice(0, path.length - suffix.length));
    }
  }
  return null;
}

/**
 * The registered roots in the user's order: roots named in `order` first, in
 * that order, then every other membership in the host's own order.
 *
 * An order entry matches a membership by its resolved directory key, so an
 * order saved as `~/git` (an older client's root, a desktop setting) still
 * places the `/home/me/git` the host reports once `$HOME` is known.
 *
 * An entry the host no longer reports is dropped rather than drawn: the host's
 * registration is the source of truth for WHAT the roots are, the client only
 * for HOW they are arranged. A newly registered root appears last until moved.
 */
export function orderWorkspaceMemberships(
  workspaces: readonly WorkspaceMembership[],
  order: readonly string[],
  home: string | null = null,
): WorkspaceMembership[] {
  const keyOf = (path: string): string => directoryKey(normaliseRootPath(path) ?? path, home);
  const byKey = new Map<string, WorkspaceMembership>();
  for (const workspace of workspaces) {
    const key = keyOf(workspace.path);
    if (!byKey.has(key)) byKey.set(key, workspace);
  }
  const ordered: WorkspaceMembership[] = [];
  for (const path of order) {
    const key = keyOf(path);
    const workspace = byKey.get(key);
    if (!workspace) continue;
    ordered.push(workspace);
    byKey.delete(key);
  }
  return [...ordered, ...byKey.values()];
}

/**
 * Move one registered root a step up (`-1`) or down (`+1`) and return the new
 * full order, or null when the move is impossible (unknown root, edge).
 */
export function moveWorkspaceRoot(
  ordered: readonly WorkspaceMembership[],
  path: string,
  direction: -1 | 1,
): string[] | null {
  const paths = ordered.map((workspace) => workspace.path);
  const index = paths.indexOf(path);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= paths.length) return null;
  paths.splice(index, 1);
  paths.splice(target, 0, path);
  return paths;
}

export interface WorkspaceRootsProjectionInput {
  /** The host's sessions, in the host's order. */
  sessions: readonly SessionSummary[];
  /** `pocketshell workspaces list --host ID` memberships. */
  workspaces: readonly WorkspaceMembership[];
  /** The user's saved root order (any spelling of each root). */
  rootOrder?: readonly string[];
  /** The host's `$HOME` when the caller knows it. */
  home?: string | null;
}

export interface WorkspaceRootsProjection {
  /** The `$HOME` the projection resolved keys against, or null. */
  home: string | null;
  /** Registered roots in display order. */
  registered: WorkspaceMembership[];
  /** The root -> folder -> session tree. */
  roots: SessionRootFolder[];
}

/**
 * Fold one host's registered roots and sessions into the shared tree.
 *
 * With no registered roots this is the desktop's derived view (roots are
 * `$HOME`'s children); with registered roots, unmatched sessions go to the
 * `other` bucket and an empty registered root still renders.
 */
export function projectWorkspaceRoots(input: WorkspaceRootsProjectionInput): WorkspaceRootsProjection {
  const home = normaliseHome(input.home)
    ?? homeFromWorkspaceMemberships(input.workspaces)
    ?? inferHome([
      ...input.sessions.map((session) => session.path),
      ...input.workspaces.map((workspace) => workspace.path),
    ]);
  const registered = orderWorkspaceMemberships(input.workspaces, input.rootOrder ?? [], home);
  const roots = groupSessionsIntoRoots(
    [...input.sessions],
    home,
    registered.map((workspace) => workspace.path),
  );
  return { home, registered, roots };
}

export type WorkspacePathResult = { ok: true; path: string } | { ok: false; message: string };

/**
 * Check a root the user typed before it is sent to `workspaces add`.
 *
 * The host canonicalises (expands `~`, resolves symlinks) and stays the
 * authority; this rejects what could never be a root — relative paths, `..`,
 * control characters — and a duplicate of an already registered root, so the
 * user gets the reason instead of an idempotent no-op.
 */
export function validateWorkspaceRootInput(
  raw: string,
  registered: readonly WorkspaceMembership[],
  home: string | null,
): WorkspacePathResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, message: 'Enter a folder path such as ~/git or /srv/apps.' };
  if (trimmed.length > 4096) return { ok: false, message: 'That path is too long.' };
  const canonical = normaliseRootPath(trimmed);
  if (canonical === null) {
    return {
      ok: false,
      message: 'Use an absolute path or one under ~, without .. or control characters.',
    };
  }
  const key = directoryKey(canonical, home);
  const duplicate = registered.find(
    (workspace) => directoryKey(normaliseRootPath(workspace.path) ?? workspace.path, home) === key,
  );
  if (duplicate) return { ok: false, message: `${duplicate.displayPath} is already a workspace root.` };
  if (registered.length >= SESSION_ROOTS_MAX) {
    return { ok: false, message: `A host can have at most ${SESSION_ROOTS_MAX} workspace roots.` };
  }
  return { ok: true, path: canonical };
}

/* ---------------------------------------------------------------------------
 * Per-host root order
 * ------------------------------------------------------------------------- */

export const WORKSPACE_PREFERENCES_SCHEMA = 1;
const HOST_IDENTITY_MAX = 256;
const ROOT_IDENTITY_MAX = 4096;

export interface HostWorkspacePreferences {
  /** Roots in the user's order (any spelling; matched by resolved key). */
  rootOrder: string[];
}

export interface WorkspacePreferencesDocument {
  schemaVersion: typeof WORKSPACE_PREFERENCES_SCHEMA;
  /** Keyed by the stable host identity passed to `workspaces --host`. */
  hosts: Record<string, HostWorkspacePreferences>;
}

export class WorkspacePreferencesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspacePreferencesError';
  }
}

export function emptyWorkspacePreferences(): WorkspacePreferencesDocument {
  return { schemaVersion: WORKSPACE_PREFERENCES_SCHEMA, hosts: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControl(value: string): boolean {
  return [...value].some((ch) => ch < ' ' || ch === '\u007f');
}

export function isValidWorkspaceHostIdentity(value: string): boolean {
  return value.trim().length > 0 && value.length <= HOST_IDENTITY_MAX && !hasControl(value);
}

function validRootIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= ROOT_IDENTITY_MAX
    && !hasControl(value);
}

/**
 * Parse the stored document. Absent storage is an empty document; anything
 * present but malformed throws, so the caller can surface it instead of
 * silently replacing the user's arrangement with defaults.
 */
export function parseWorkspacePreferences(raw: string | null): WorkspacePreferencesDocument {
  if (raw === null) return emptyWorkspacePreferences();
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new WorkspacePreferencesError('Saved workspace root order is not valid JSON.');
  }
  if (!isRecord(value) || value.schemaVersion !== WORKSPACE_PREFERENCES_SCHEMA || !isRecord(value.hosts)) {
    throw new WorkspacePreferencesError('Saved workspace root order has an unsupported format.');
  }
  const hosts: Record<string, HostWorkspacePreferences> = {};
  for (const [hostId, entry] of Object.entries(value.hosts)) {
    if (!isValidWorkspaceHostIdentity(hostId) || !isRecord(entry)) {
      throw new WorkspacePreferencesError('Saved workspace root order has a malformed host entry.');
    }
    const order = entry.rootOrder;
    if (!Array.isArray(order) || order.length > SESSION_ROOTS_MAX * 4 || !order.every(validRootIdentity)
      || new Set(order).size !== order.length) {
      throw new WorkspacePreferencesError('Saved workspace root order has a malformed root list.');
    }
    hosts[hostId] = { rootOrder: [...order] };
  }
  return { schemaVersion: WORKSPACE_PREFERENCES_SCHEMA, hosts };
}

export function serializeWorkspacePreferences(document: WorkspacePreferencesDocument): string {
  return JSON.stringify(document);
}

export function hostWorkspacePreferences(
  document: WorkspacePreferencesDocument,
  hostIdentity: string,
): HostWorkspacePreferences {
  const entry = Object.prototype.hasOwnProperty.call(document.hosts, hostIdentity)
    ? document.hosts[hostIdentity]
    : undefined;
  return { rootOrder: entry ? [...entry.rootOrder] : [] };
}

/** Return a new document with one host's preferences replaced. */
export function withHostWorkspacePreferences(
  document: WorkspacePreferencesDocument,
  hostIdentity: string,
  update: HostWorkspacePreferences,
): WorkspacePreferencesDocument {
  if (!isValidWorkspaceHostIdentity(hostIdentity)) {
    throw new WorkspacePreferencesError('A workspace host identity is required.');
  }
  const rootOrder = [...new Set(update.rootOrder.filter(validRootIdentity))];
  return {
    schemaVersion: WORKSPACE_PREFERENCES_SCHEMA,
    hosts: { ...document.hosts, [hostIdentity]: { rootOrder } },
  };
}

/**
 * Seed one host from an older client's data without overwriting anything the
 * user has already chosen here: a host that already has an entry is untouched.
 */
export function seedHostWorkspacePreferences(
  document: WorkspacePreferencesDocument,
  hostIdentity: string,
  seed: HostWorkspacePreferences,
): WorkspacePreferencesDocument {
  if (Object.prototype.hasOwnProperty.call(document.hosts, hostIdentity)) return document;
  return withHostWorkspacePreferences(document, hostIdentity, seed);
}
