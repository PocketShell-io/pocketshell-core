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
  KillSessionResult,
  PortIntent,
  RemotePort,
  RenameSessionResult,
  ReposCloneOptions,
  ReposListRequest,
  ReposListResult,
  SessionSummary,
  ShellId,
  StageAttachmentsResult,
  StartSessionRequest,
  StartSessionResult,
  SyncApplyResult,
  SyncPullResult,
  SyncPushResult,
  SyncStatus,
  TransferProgress,
  UpdateCheckResult,
  UsageRow,
} from '@pocketshell/core';
import type { ZoomCommand } from '@pocketshell/core/shared/zoomKeys';


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
    "setZoom": (factor: number) => void;
    "onZoomCommand": (handler: (command: ZoomCommand) => void) => Unsubscribe;
    };

    "app": {
    "onResumed": (handler: () => void) => Unsubscribe;
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
      }) => Promise<ConnectResult>;
    "exec": (connectionId: string, command: string) => Promise<ExecResult>;
    "close": (connectionId: string) => Promise<boolean>;
    "onState": (listener: (payload: { connectionId: string; state: ConnectionState }) => void) => (() => void);
    };

    "shell": {
    "open": (payload: {
        connectionId: string;
        command?: string;
        cols?: number;
        rows?: number;
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
    "profiles": (connectionId: string) => Promise<unknown[]>;
    "envList": (connectionId: string, dir: string) => Promise<EnvVarRow[]>;
    "envGet": (connectionId: string, dir: string, keys?: string[]) => Promise<Record<string, string>>;
    "envSet": (connectionId: string, dir: string, values: Record<string, string>, file?: string) => Promise<void>;
    };

    "diag": {
    "log": (entry: { kind: string; message: string; stack?: string; detail?: Record<string, unknown> }) => void;
    };

    "update": {
    "check": () => Promise<UpdateCheckResult>;
    "open": (url: string) => Promise<void>;
    };

    "editors": {
    "openVsCode": (req: { hostToken: string; path: string }) => Promise<boolean>;
    };

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
