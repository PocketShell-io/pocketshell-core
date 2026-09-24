/**
 * The transport data contracts the renderer UI reads, moved out of the
 * desktop's main-process modules so the shared UI package (@pocketshell/ui)
 * can type against the same shapes both apps produce.
 *
 * Nothing here runs code: these are the wire shapes only. The desktop main
 * process re-exports them from their original modules; the web app produces
 * the same shapes over its browser transport.
 */
import type { ForwardSpec } from './types';

// ---- from src/main/sftp/SftpService.ts ----

export interface TransferProgress {
  /** Bytes transferred so far. */
  bytes: number;
  /** Total bytes, when known (file transfers); undefined for streams. */
  total?: number;
}

// ---- from src/main/helper/usageParsers.ts ----

export interface UsageRow {
  provider: string;
  // `string & {}` keeps the documented literals visible to narrowing and
  // autocomplete while still accepting values a newer helper may add. A bare
  // `| string` would absorb the literals and enforce nothing.
  status: 'ok' | 'limited' | 'blocked' | 'error' | (string & {});
  /**
   * The windows this provider actually has, shortest term first — codex and
   * grok carry a single weekly window, copilot a single monthly one, go three
   * (5h + weekly + monthly). Windows the helper reports as empty (both
   * fields null) are DROPPED rather than carried as "not reported" rows: a
   * rendered row reads as a meter, and a meter that is not there is not the
   * same fact as a meter at zero. Same rule for the synthesized 100%-no-reset
   * filler the helper emits beside copilot's real monthly window.
   */
  windows: UsageWindow[];
  error: string | null;
  details: Record<string, unknown>;
  /**
   * How many "full reset" credits the provider reports (codex's reset
   * credits, grok's restok tokens) — null when the provider has no such
   * concept, 0 when it does and the credit is spent. The helper spells the
   * count under two different detail keys, one per provider; this is the
   * normalized view of both, so consumers print one field.
   */
  resets_available: number | null;
}

// ---- from src/main/projects/repos.ts ----

export interface RepoEntry {
  /** Directory basename for a local clone; GitHub repo name for a remote row. */
  name: string;
  /** GitHub owner, or null (non-GitHub origin / no origin). */
  owner: string | null;
  /** `owner/name`, or null when the owner is unknown. */
  fullName: string | null;
  local: RepoLocal | null;
  remote: RepoRemote | null;
}

// ---- from src/main/projects/repos.ts ----

export type ReposScopeState =
  | 'ok'
  | 'gh-missing'
  | 'gh-unauthenticated'
  | 'helper-missing'
  | 'failed';

// ---- from src/main/projects/ProjectsService.ts ----

export interface AplexerSessionRef {
  /** Canonical workspace the session lives in. */
  workspace?: string | null;
  /** Immutable session UUID. Preferred: survives renames. */
  aplexerId?: string | null;
}

// ---- from src/main/projects/ProjectsService.ts ----

export interface CloneProgress {
  requestId: string;
  phase: 'started' | 'finished';
  repository: string;
  path?: string;
  error?: string;
}

// ---- from src/main/projects/ProjectsService.ts ----

export interface CloneResult {
  ok: boolean;
  path: string | null;
  /** True when the clone target was already on disk and we reused it. */
  alreadyExists: boolean;
  error: string | null;
  /**
   * On failure, WHY — so the UI can say "this host has no pocketshell" rather
   * than dumping a git error. Absent on success.
   */
  state?: Exclude<ReposScopeState, 'ok'>;
}

// ---- from src/main/projects/ProjectsService.ts ----

export interface CreateFolderRequest {
  /** Existing parent directory. */
  parent: string;
  /** Single folder name to create under it. */
  name: string;
}

// ---- from src/main/projects/ProjectsService.ts ----

export interface CreateFolderResult {
  ok: boolean;
  /** Canonical absolute path of the created folder. */
  path: string | null;
  error: string | null;
}

// ---- from src/main/projects/ProjectsService.ts ----

export interface HomeResult {
  ok: boolean;
  home: string | null;
  error: string | null;
}

// ---- from src/main/projects/ProjectsService.ts ----

export interface ReposListRequest {
  /** Which scopes to run. Defaults to `both`. */
  scope?: 'local' | 'remote' | 'both';
  /** Local scan roots (replaces the helper default `~/git`). */
  roots?: string[];
  /** Local scan depth. */
  maxDepth?: number;
  /** Cap on remote rows. */
  limit?: number;
}

// ---- from src/main/projects/ProjectsService.ts ----

export interface KillSessionResult {
  ok: boolean;
  error: string | null;
  code: KillSessionFailure | null;
}

// ---- from src/main/projects/ProjectsService.ts ----

export interface RenameSessionResult {
  ok: boolean;
  /** The name the session now has on the host. */
  sessionName: string | null;
  error: string | null;
  code: RenameSessionFailure | null;
}

// ---- from src/main/projects/ProjectsService.ts ----

export interface StartSessionRequest {
  /** Remote folder to start in. Absolute, or `~`-relative. */
  folder: string;
  /** Optional user label; blank/punctuation-only falls back to the derived name. */
  customName?: string;
  /** Defaults to `reuse`. */
  namePolicy?: SessionNamePolicy;
}

// ---- from src/main/projects/ProjectsService.ts ----

export interface StartSessionResult {
  ok: boolean;
  /** The session name on the host — what to attach to. */
  sessionName: string | null;
  /** The canonical folder the session was started in. */
  folder: string | null;
  /** True when a session for this folder was already open and got reused. */
  reused: boolean;
  /** Which create path ran; `tmux-fallback` means no memory cap. */
  via: CreateSessionVia | null;
  /**
   * The aplexer UUID of the created session, when the host handed one over
   * (`a start --json` echoes the record). The renderer needs it to join by id
   * WITHOUT waiting for the next snapshot — the optimistic row it builds from
   * this result would otherwise cost the join its exact selector and push a
   * workspace+tag lookup onto the attach. Null whenever the create did not go
   * through aplexer, or the host's answer was unreadable.
   */
  aplexerId: string | null;
  error: string | null;
  code: StartSessionFailure | null;
}

// ---- from src/main/portfwd/AutoForwarder.ts ----

export interface AutoForwarderStatus {
  scanning: boolean;
  lastScanAt: number | null;
  lastScanOk: boolean;
  lastError: string | null;
}

// ---- from src/main/portfwd/AutoForwarder.ts ----

export interface DiscoveredPort extends RemotePort {
  /** True when a live forward exists for this remote port. */
  forwarded: boolean;
  /** Local port in use, when forwarded. */
  localPort: number | null;
  /** Explicit user intent, when one is set. */
  intent: PortIntent | null;
  /** Friendly name, when one is set. */
  name: string | null;
  /** True when auto policy alone would forward it (ignoring intent). */
  eligible: boolean;
  /** Set when the last attempt to open this port failed. */
  lastError: string | null;
}

// ---- from src/main/portfwd/Forwarder.ts ----

export interface ForwardState extends ForwardMeta {
  /** Stable identity of this forward. Always {@link forwardKey}(spec). */
  key: string;
  kind: ForwardSpec['kind'];
  listenHost: string;
  listenPort: number;
  destHost: string;
  destPort: number;
  origin: ForwardOrigin;
  active: boolean;
  /** Bytes received FROM the remote side (download). */
  bytesIn: number;
  /** Bytes sent TO the remote side (upload). */
  bytesOut: number;
  /** Download rate, bytes/sec, since the previous snapshot. */
  rateIn: number;
  /** Upload rate, bytes/sec, since the previous snapshot. */
  rateOut: number;
}

// ---- from src/main/portfwd/PortfwdStore.ts ----

export type PortIntent = 'force-on' | 'force-off';

// ---- from src/main/portfwd/PortScanner.ts ----

export interface RemotePort {
  port: number;
  /** Process name when attribution succeeded; otherwise null. */
  process: string | null;
  /** Owning PID when attribution succeeded; otherwise null. */
  pid: number | null;
  /** Working directory of {@link pid}, when readable; otherwise null. */
  cwd: string | null;
}
// ---- from src/main/projects/repos.ts ----

export interface ReposListResult {
  /** True when every requested scope came back `ok`. */
  ok: boolean;
  /** Local and remote rows merged by `fullName` (falling back to `name`). */
  repos: RepoEntry[];
  local: ReposScopeResult | null;
  remote: ReposScopeResult | null;
}
// ---- src/main/projects/repos.ts ----

export interface ReposScopeResult {
  state: ReposScopeState;
  repos: RepoEntry[];
  /** Host-supplied reason, when there is one. */
  error: string | null;
}

// ---- src/main/projects/ProjectsService.ts ----

export type SessionNamePolicy = 'reuse' | 'unique';

// ---- src/main/projects/ProjectsService.ts ----

export type StartSessionFailure = 'folder-missing' | 'create-failed' | 'name-unavailable';
export interface UsageWindow {
  percent_remaining: number | null;
  reset_at: string | null;
  /**
   * Human label, e.g. `5h` / `7d` / `weekly` / `monthly`. Never empty on a
   * parsed row: the key is the label except when it is the slot's own name
   * (`short_term`/`long_term`), and those fall back to the generic
   * short-term/long-term wording here, so consumers can print it as-is.
   */
  window: string;
}

export interface RepoLocal {
  path: string;
  /** Checked-out branch, or null when it could not be read. */
  head: string | null;
}

export interface RepoRemote {
  defaultBranch: string | null;
  htmlUrl: string | null;
  sshUrl: string | null;
  updatedAt: string | null;
}

export type RenameSessionFailure = 'illegal-name' | 'name-taken' | 'rename-failed';

export type KillSessionFailure = 'not-found' | 'kill-failed';

export type CreateSessionVia = 'helper' | 'tmux-fallback' | 'aplexer';
export type ForwardOrigin = 'auto' | 'manual' | 'ssh-config';

export interface ForwardMeta {
  /** User-chosen friendly name for the remote port, or null. */
  name: string | null;
  /** Remote process name, from the port scan. */
  process: string | null;
  /** Remote process working directory, from the port scan. */
  cwd: string | null;
  /** True when listenPort !== destPort (mirroring was not possible/wanted). */
  remapped: boolean;
}
export interface ReposCloneOptions {
  /** `owner/repo`. */
  repository: string;
  /** Clone root. Helper default is `~/git`. */
  root?: string;
  /** Target folder name under the root. Helper default is the repo name. */
  folder?: string;
  /** Clone URL protocol. Helper default is `ssh`. */
  protocol?: 'ssh' | 'https';
}
export interface ReposCloneOptions {
  /** `owner/repo`. */
  repository: string;
  /** Clone root. Helper default is `~/git`. */
  root?: string;
  /** Target folder name under the root. Helper default is the repo name. */
  folder?: string;
  /** Clone URL protocol. Helper default is `ssh`. */
  protocol?: 'ssh' | 'https';
}
