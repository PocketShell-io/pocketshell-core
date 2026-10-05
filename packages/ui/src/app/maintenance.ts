/**
 * The maintenance workspace — what "Host monitor" opens instead of a panel
 * that samples the host itself: a hidden root holding one tool pane running
 * `htop` in `~`. docs/MONITOR.md is the feature's decision record; this module
 * is the one home of its constants, so the workspace branch, the tab bar and
 * the trigger cannot drift apart about what the pane is called or what runs
 * in it.
 *
 * The root is `MAINTENANCE_ROOT` (`::maintenance::`, from core) — a stable
 * workspace key that names no directory, which is why it is not a root in the
 * session tree's grouping: the panel renders a pinned Maintenance section for
 * it instead (SessionTreeRowsView), and the Host monitor button opens the
 * same route. The pane is
 * BARE (`TerminalView`'s `bare` prop): a plain SSH login shell in the user's
 * `$HOME` — sshd's own default cwd, no `cd` typed on their behalf — with
 * {@link MAINTENANCE_COMMAND} typed into it, so quitting htop leaves a live
 * prompt in `~` and the tab doubles as a maintenance shell.
 *
 * Ephemeral by construction: the pane is a PTY of our own, not a host
 * session, and its lifetime is the workspace visit — navigating away prunes
 * the pane (the ordinary pane rule), unmounting the TerminalView closes the
 * SSH shell, and htop dies with it. Nothing is left polling the host, and no
 * session appears in any host-side listing.
 */
import { MAINTENANCE_ROOT } from '@pocketshell/core';
import type { WorkspaceTab } from '@pocketshell/core/shared/workspaceTabs';
import type { SessionDirectory } from './sessionTree';
import type { SessionPaneRecord } from './sessionPanes';

export { MAINTENANCE_ROOT };

/** The tool pane's registry identity — `TerminalView`'s `sessionKey` in bare mode. */
export const MAINTENANCE_IDENTITY = 'tool:htop';

/** Typed into the login shell. Missing htop prints `command not found`, which is the honest answer. */
export const MAINTENANCE_COMMAND = 'htop';

/** The one tab the maintenance bar holds. A fresh object per call: tab labels are mutable display state. */
export function maintenanceTab(): WorkspaceTab {
  return { kind: 'tool', id: MAINTENANCE_IDENTITY, label: 'htop' };
}

/** The one pane record, minted on arrival and pruned on leaving. */
export function maintenancePane(): SessionPaneRecord {
  return { id: 'pane-maintenance', session: 'htop', identity: MAINTENANCE_IDENTITY };
}

/** True when the route's `:folder` is the maintenance root. */
export function isMaintenanceFolder(folderKey: string | null | undefined): boolean {
  return folderKey === MAINTENANCE_ROOT;
}

/**
 * The sidebar row's directory shape — what the session tree's pinned
 * Maintenance section hands the SAME `select` event the folder rows emit, so
 * navigation, re-click focus and the current-row tint are the folder rows'
 * own machinery. It models no directory: `rows` is empty and never enters the
 * grouping (the section is chrome the tree renders beside the roots, not a
 * root among them), and `path` is the pseudo-key itself — the row names a
 * workspace, not a place on disk.
 */
export function maintenanceDirectory(): SessionDirectory {
  return {
    key: MAINTENANCE_ROOT,
    path: MAINTENANCE_ROOT,
    label: 'htop',
    rows: [],
    mostRecentActivity: 0,
    active: false,
    untracked: false,
    inferredRoot: false,
  };
}
