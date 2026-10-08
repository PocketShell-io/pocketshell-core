/**
 * The typed transport contract between the shared UI and whatever platform
 * hosts it. Generated from the desktop preload's api object shape, so the
 * two cannot drift: the desktop's preload bridge satisfies this interface and
 * the desktop's provideApi call typechecks; the web app implements the same
 * interface over its browser transport.
 *
 * Groups map to platform capabilities: win/app (host window), ssh (connection
 * lifecycle), shell (PTY streaming + tmux attach), helper (bootstrap, tmux
 * session plumbing, usage, aplexer), projects, sftp, preview, forwards,
 * attachments, agent, diag, update, editors, sync. Event subscriptions return
 * an unsubscribe closure.
 */
export type Unsubscribe = () => void;

import type {
  AplexerAckOutcome,
  AplexerSessionRef,
  AplexerWarning,
  AttachmentSource,
  AutoForwarderStatus,
  BootstrapResult,
  CloneProgress,
  CloneResult,
  ConnectResult,
  ConnectionState,
  CreateFolderRequest,
  CreateFolderResult,
  DirEntry,
  DiscoveredPort,
  EnvVarRow,
  ExecResult,
  FileStat,
  ForwardSpec,
  ForwardState,
  GeometryProbe,
  HomeResult,
  HostEntry,
  HostKeyTrustChoice,
  HostKeyTrustRequest,
  KillSessionResult,
  PortIntent,
  RemotePort,
  RenameSessionResult,
  ReposCloneOptions,
  ReposListRequest,
  ReposListResult,
  SavedHostInput,
  SavedHostSnapshot,
  SessionSummary,
  SessionsListResult,
  ShellId,
  StageAttachmentsResult,
  StartSessionRequest,
  StartSessionResult,
  SyncApplyResult,
  SyncPullResult,
  SyncPushResult,
  SyncStatus,
  TransferProgress,
  DiagnosticReport,
  UpdateCheckResult,
  UsageRow,
  WorkspaceRootsApi,
} from '@pocketshell/core';

/** The installed build, as the platform's package manager reports it. */
export interface InstalledAppInfo {
  /** e.g. `0.5.5` or `0.5.5-12-gabc1234`; `unknown` when the platform cannot say. */
  versionName: string;
  /** Android `versionCode`; null elsewhere. */
  versionCode: number | null;
  /** Package or bundle id, including any per-install suffix; '' when unknown. */
  applicationId: string;
}

/** How a share request ended: handed to a share target, saved locally, or dismissed. */
export type DiagnosticsShareOutcome = 'shared' | 'saved' | 'cancelled';
import type { ZoomCommand } from '@pocketshell/core/shared/zoomKeys';


/**
 * A platform-owned host list: Android keeps its hosts in core's
 * SavedHostStore and bridges it here one-to-one. Every call answers with the
 * store's full snapshot, so the UI never keeps a second copy of the list, its
 * order or the default host. Hosts carry opaque key references only; no key
 * bytes or passphrases cross this seam in either direction.
 */
export interface PlatformHostStore {
  load: () => Promise<SavedHostSnapshot>;
  add: (input: SavedHostInput) => Promise<SavedHostSnapshot>;
  update: (id: string, input: SavedHostInput) => Promise<SavedHostSnapshot>;
  delete: (id: string) => Promise<SavedHostSnapshot>;
  setDefault: (id: string | null) => Promise<SavedHostSnapshot>;
  move: (id: string, index: number) => Promise<SavedHostSnapshot>;
}

/**
 * One `ssh.onState` notification. `attempt`/`maxAttempts`/`error` are filled
 * only by a transport that owns recovery (`ssh.reconnect` present): the dial
 * of its ladder in progress while `reconnecting`, and the reason once it
 * gives up (`lost`).
 */
export interface ConnectionStateEvent {
  connectionId: string;
  state: ConnectionState;
  attempt?: number;
  maxAttempts?: number;
  error?: string;
}

/**
 * The full transport surface the shared UI consumes, generated from the
 * desktop preload's api object. Desktop provides it over Electron IPC
 * (the preload bridge); the web app provides the same surface over its browser
 * transport. Event subscriptions return an unsubscribe closure.
 */
export interface PocketShellApi {
    "win": {
    "setTitle": (title: string) => void;
    "openAccount": () => Promise<void>;
    /**
     * Optional: open another workspace window, optionally naming the host it
     * should dial at launch. Only a platform that can hold several windows
     * over one app exposes it; where it is absent the shared UI hides its
     * new-window affordances.
     */
    "openNewWindow"?: (request?: { host?: string }) => Promise<void>;
    "setZoom": (factor: number) => void;
    "onZoomCommand": (handler: (command: ZoomCommand) => void) => Unsubscribe;
    };

    "app": {
    "onResumed": (handler: () => void) => Unsubscribe;
    /**
     * Optional: the installed build's identity for Settings → About. A
     * platform without it shows only the shared source revision it knows.
     */
    "info"?: () => Promise<InstalledAppInfo>;
    /**
     * Optional: true on a platform that suspends in the background and holds a
     * live connection for a grace window (Android). Settings shows the grace
     * and reconnect-on-return controls only where they change behaviour.
     */
    "backgroundGrace"?: boolean;
    };

    "ssh": {
    "listConfigHosts": () => Promise<HostEntry[]>;
    "connect": (payload: {
        host: string;
        port?: number;
        user: string;
        /** The `~/.ssh/config` `Host` alias (`HostEntry.name`), when there is one. */
        hostAlias?: string;
        privateKeyPath?: string;
        privateKey?: string;
        passphrase?: string;
        tofuDecision?: 'accept-always' | 'accept-once' | 'reject';
        /**
         * The host entry's transport markers, preserved VERBATIM from the
         * entry the dial came from — never normalized or repaired, so a
         * malformed value stays malformed on the way to the platform.
         * Absent keys mean an ordinary host: the shared store adds these
         * members only when the entry actually carries the marker (issue
         * #3059). The platform boundary decides support: a gateway marker
         * (`gateway`, any value — null and malformed included) on a platform
         * without gateway support must refuse the dial there, before any
         * credential is loaded or socket opened.
         */
        link?: unknown;
        gateway?: unknown;
        /**
         * True when the dial targets the platform's own machine (a
         * `HostEntry.local` host, the desktop's "self"): main then opens
         * processes directly instead of speaking SSH. Platforms without a
         * local transport never see the flag.
         */
        local?: boolean;
      }) => Promise<ConnectResult>;
    "exec": (connectionId: string, command: string) => Promise<ExecResult>;
    "close": (connectionId: string) => Promise<boolean>;
    "onState": (listener: (payload: ConnectionStateEvent) => void) => (() => void);
    /**
     * Present when the transport owns recovery (#2954, D28: one reconnect
     * owner) — Android's core `ConnectionController` today. Its presence is
     * the capability: the shared connection store then runs no reconnect
     * ladder of its own, shows the transport's `reconnecting` state and
     * attempt count, and its Retry calls this with the SAME connection id
     * (the transport keeps the logical id across its re-dials). Resolves
     * true once the link (and the attached session) is back.
     *
     * Absent: the store owns recovery (its `ReconnectLoop` re-dials on
     * `lost`, minting a new connection id) — desktop and web until their
     * transports move onto the controller (#2936 U5/U6).
     */
    "reconnect"?: (connectionId: string) => Promise<boolean>;
    /**
     * OPTIONAL — present only on a platform that asks the user before trusting
     * a first-contact host key (mechanism (i): the capability is present when
     * the member is). The shared connection store registers one decider at
     * startup; while a dial waits on an unknown key the platform calls it and
     * applies the answer. With this present the store dials WITHOUT a
     * `tofuDecision`, so nothing is pinned silently. A platform that provides
     * it must fail closed (refuse the key) when no decider is registered, and
     * must refuse a CHANGED key outright rather than ask.
     */
    "onTrustDecision"?: (decider: (request: HostKeyTrustRequest) => Promise<HostKeyTrustChoice>) => Unsubscribe;
    };

    "shell": {
    "open": (payload: {
        connectionId: string;
        command?: string;
        cols?: number;
        rows?: number;
        /**
         * The interactive shell a LOCAL terminal opens — a core
         * `LocalShellChoice` id. Absent (or empty) on every other platform and
         * every remote host: sshd's login shell is the host's business, and a
         * session join keeps its POSIX join script regardless.
         */
        shell?: string;
      }) => Promise<ShellId>;
    "attachSession": (payload: {
        connectionId: string;
        sessionName: string;
        cols?: number;
        rows?: number;
        backend?: 'tmux' | 'aplexer';
        workspace?: string;
        tag?: string;
        aplexerId?: string;
      }) => Promise<{ shellId: ShellId; switched: boolean }>;
    "input": (shellId: ShellId, data: string, sessionName?: string, workspace?: string) => Promise<boolean>;
    "resize": (shellId: ShellId, cols: number, rows: number) => Promise<boolean>;
    "redraw": (shellId: ShellId) => Promise<boolean>;
    "windowSize": (shellId: ShellId) => Promise<GeometryProbe>;
    "close": (shellId: ShellId) => Promise<boolean>;
    "onData": (handler: (payload: { shellId: ShellId; data: Uint8Array }) => void) => Unsubscribe;
    "onExited": (handler: (payload: { shellId: ShellId; exitCode: number }) => void) => Unsubscribe;
    };

    "helper": {
    "bootstrap": (connectionId: string) => Promise<BootstrapResult>;
    "sessionsList": (connectionId: string, sortBy?: 'activity' | 'created') => Promise<SessionSummary[]>;
    /**
     * The listing WITH the host's `errors[]`. Optional: a platform that can
     * read the host errors (Android's HostCliCore path) provides it and the
     * session panel prefers it, so a partially readable host shows "Some
     * sessions may be missing" instead of looking empty. A platform without
     * it keeps `sessionsList` and reports no list errors.
     */
    "sessionsListing"?: (connectionId: string, sortBy?: 'activity' | 'created') => Promise<SessionsListResult>;
    /**
     * OPTIONAL — a fresh host listing with NO side effects on the connection:
     * it never starts a reconnect, never changes connection state, and
     * rejects when the link is not usable instead of probing it (#3039). The
     * terminal pane's "did this session outlive its client?" verdict uses it,
     * so a verdict asked as the link dies cannot become a second recovery
     * trigger. A platform whose listing already has no such side effects may
     * omit it; the pane then uses `sessionsListing` / `sessionsList`.
     */
    "sessionsProbe"?: (connectionId: string) => Promise<SessionSummary[]>;
    "sessionsCreate": (connectionId: string, name: string, cwd: string) => Promise<boolean>;
    "usage": (connectionId: string) => Promise<UsageRow[]>;
    "warnings": (connectionId: string) => Promise<AplexerWarning[]>;
    "ackWarnings": (connectionId: string, target?: string) => Promise<AplexerAckOutcome>;
    };

    "projects": {
    "home": (connectionId: string) => Promise<HomeResult>;
    "deriveName": (connectionId: string, folder: string, customName?: string) => Promise<string>;
    "createFolder": (connectionId: string, request: CreateFolderRequest) => Promise<CreateFolderResult>;
    "reposList": (connectionId: string, request?: ReposListRequest) => Promise<ReposListResult>;
    "reposClone": (connectionId: string, request: ReposCloneOptions & { requestId?: string }) => Promise<CloneResult>;
    "startSession": (connectionId: string, request: StartSessionRequest) => Promise<StartSessionResult>;
    "renameSession": (connectionId: string, from: string, to: string, ref?: AplexerSessionRef & { backend?: 'tmux' | 'aplexer' }) => Promise<RenameSessionResult>;
    "killSession": (connectionId: string, name: string, ref?: AplexerSessionRef & { backend?: 'tmux' | 'aplexer' }) => Promise<KillSessionResult>;
    "onCloneProgress": (handler: (progress: CloneProgress) => void) => Unsubscribe;
    };

    "sftp": {
    "list": (connectionId: string, path: string) => Promise<DirEntry[]>;
    "stat": (connectionId: string, path: string) => Promise<FileStat>;
    "readFile": (connectionId: string, path: string) => Promise<string>;
    "readBinary": (connectionId: string, path: string, maxBytes?: number) => Promise<Uint8Array>;
    "writeFile": (connectionId: string, path: string, content: string) => Promise<boolean>;
    "createFile": (connectionId: string, path: string, content?: string) => Promise<boolean>;
    "mkdir": (connectionId: string, path: string) => Promise<boolean>;
    "rename": (connectionId: string, fromPath: string, toPath: string) => Promise<boolean>;
    "deleteFile": (connectionId: string, path: string) => Promise<boolean>;
    "rmdir": (connectionId: string, path: string) => Promise<boolean>;
    "realPath": (connectionId: string, path: string) => Promise<string>;
    "upload": (payload: {
        connectionId: string;
        localPath: string;
        remotePath: string;
        transferId: string;
      }) => Promise<boolean>;
    "download": (payload: {
        connectionId: string;
        remotePath: string;
        localPath: string;
        transferId: string;
      }) => Promise<boolean>;
    "saveAs": (payload: { connectionId: string; remotePath: string }) => Promise<string | null>;
    "onProgress": (handler: (payload: { transferId: string } & TransferProgress) => void) => Unsubscribe;
    };

    "preview": {
    "openHtml": (connectionId: string, path: string) => Promise<{ token: string; url: string }>;
    "openMarkdown": (connectionId: string, path: string, style: { palette: Record<string, string>; appearance: 'dark' | 'light' }) => Promise<{ token: string; url: string }>;
    "openSvg": (connectionId: string, path: string) => Promise<{ token: string; url: string }>;
    "release": (token: string) => void;
    "onStats": (handler: (stats: {
          token: string;
          loaded: number;
          blocked: number;
          missing: number;
          capped: boolean;
        }) => void) => (() => void);
    };

    "forwards": {
    "scan": (connectionId: string) => Promise<RemotePort[]>;
    "startAuto": (connectionId: string, configForwards?: ForwardSpec[]) => Promise<boolean>;
    "stopAuto": (connectionId: string) => Promise<boolean>;
    "addManual": (connectionId: string, spec: ForwardSpec) => Promise<boolean>;
    "remove": (connectionId: string, key: string) => Promise<boolean>;
    "list": (connectionId: string) => Promise<ForwardState[]>;
    "refresh": (connectionId: string) => Promise<boolean>;
    "discovered": (connectionId: string) => Promise<DiscoveredPort[]>;
    "status": (connectionId: string) => Promise<AutoForwarderStatus | null>;
    "setName": (connectionId: string, remotePort: number, name: string | null) => Promise<boolean>;
    "setRemap": (connectionId: string, remotePort: number, localPort: number) => Promise<boolean>;
    "clearRemap": (connectionId: string, remotePort: number) => Promise<boolean>;
    "setIntent": (connectionId: string, remotePort: number, intent: PortIntent | null) => Promise<boolean>;
    "togglePort": (connectionId: string, remotePort: number) => Promise<boolean>;
    "isAutoEnabled": (connectionId: string) => Promise<boolean>;
    "onStates": (handler: (payload: { connectionId: string; states: ForwardState[] }) => void) => Unsubscribe;
    };

    "attachments": {
    "stage": (payload: {
        connectionId: string;
        scopeKey: string;
        sources: AttachmentSource[];
      }) => Promise<StageAttachmentsResult>;
    "pickFiles": (payload?: { title?: string; multiple?: boolean }) => Promise<string[]>;
    "readLocal": (path: string) => Promise<Uint8Array>;
    };

    "agent": {
    "kinds": (connectionId: string) => Promise<string[] | null>;
    /**
     * The launch binaries on the host's PATH (`pocketshell` + the engine
     * CLIs, from one `command -v` batch), or null when the probe failed —
     * null reads as "unknown" and refuses nothing, exactly like `kinds`' null.
     */
    "binaries": (connectionId: string) => Promise<string[] | null>;
    "profiles": (connectionId: string) => Promise<unknown[]>;
    "envList": (connectionId: string, dir: string) => Promise<EnvVarRow[]>;
    "envGet": (connectionId: string, dir: string, keys?: string[]) => Promise<Record<string, string>>;
    "envSet": (connectionId: string, dir: string, values: Record<string, string>, file?: string) => Promise<void>;
    };

    "diag": {
    "log": (entry: { kind: string; message: string; stack?: string; errorName?: string; detail?: Record<string, unknown> }) => void;
    };

    // Optional capability: locally stored diagnostic reports (runtime errors
    // the shared app caught, native crashes, and imported 0.5.x reports) that
    // Settings lists, deletes and shares. Reports arrive already redacted
    // (core diagnosticReports.ts). Desktop writes a log file instead and omits
    // the group; the Diagnostics section is hidden over the seam.
    "diagnostics"?: {
    "list": () => Promise<DiagnosticReport[]>;
    "remove": (id: string) => Promise<boolean>;
    "clear": () => Promise<number>;
    "share": (payload: { fileName: string; text: string }) => Promise<DiagnosticsShareOutcome>;
    };

    // Optional capability: a browser deployment IS the current build (a reload
    // is the update path), so the web platform omits the group and the shared
    // UI hides every update surface over the seam.
    "update"?: {
    "check": () => Promise<UpdateCheckResult>;
    "open": (url: string) => Promise<void>;
    };

    // Optional capability: the platform's LOCAL host source, the thing the
    // host picker's group label, empty state and load-failure copy name.
    // Desktop reads ~/.ssh/config and provides the file's name; a browser has
    // no config file and words the same surfaces around the synced account
    // list. Omitting the group gets neutral wording and no source chip.
    "hosts"?: {
    /** Eyebrow over the local host group in the picker. */
    "groupLabel": string;
    /** The source's name; the picker renders it as code where it cites it. */
    "sourceName": string;
    /** Copy for an empty local list; embedding sourceName keeps the chip. */
    "emptyHint": string;
    /** The platform's way out of an empty list, on its own route. */
    "emptyAction"?: { label: string; route: string };
    /**
     * Present only when the platform OWNS its host list rather than reading
     * one: see {@link PlatformHostStore}. Desktop (~/.ssh/config, edited
     * outside the app) and the web (the synced account, managed on its own
     * route) omit it, and the shared UI then offers no create/edit/delete.
     */
    "store"?: PlatformHostStore;
    };

    // Optional capability: the vscode:// deep link. Remote-SSH resolves the
    // host token against the user's LOCAL ~/.ssh/config on the machine the
    // OS dispatches to — a file only the desktop can vouch for (it parsed
    // that config itself). A browser can hand the OS the scheme but cannot
    // prove the alias exists, and a synced-only host would strand the user
    // in a VS Code connect error the app cannot explain. The web omits the
    // group and the shared UI hides the action over the seam.
    "editors"?: {
    "openVsCode": (req: { hostToken: string; path: string }) => Promise<boolean>;
    };

    // Optional capability: the host CLI's `pocketshell workspaces` contract
    // (core `workspaceRootsApiFromExec` builds it from the platform's exec).
    // With it, the session panel's roots are the host's own registrations,
    // partitioned by the stable host identity. Optional capability(connectionId)
    // selects host authority per connection; null retains local Settings roots.
    // Without the group they stay the
    // per-host list in Settings. See stores/workspaceRoots.ts.
    "workspaces"?: WorkspaceRootsApi;

    "sync": {
    "status": () => Promise<SyncStatus>;
    "login": () => Promise<string | null>;
    "logout": () => Promise<void>;
    "pull": (slot: string, passphrase: string) => Promise<SyncPullResult>;
    "push": (slot: string, plaintext: string, passphrase: string, baseVersion: number) => Promise<SyncPushResult>;
    "accountHosts": () => Promise<HostEntry[] | null>;
    "applyHosts": (hosts: HostEntry[]) => Promise<SyncApplyResult>;
    };
}
