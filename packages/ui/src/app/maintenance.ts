/**
 * The maintenance workspace — what "Host monitor" opens instead of a panel
 * that samples the host itself: a hidden root whose TOOLS run in bare panes,
 * `htop` in `~` first of all. docs/MONITOR.md is the feature's decision
 * record; this module is the one home of its state and constants, so the
 * workspace, the sidebar section and the trigger cannot drift apart about
 * what is open, what it is called, and what runs in it.
 *
 * The TOOL is the persistent thing. `openMaintenanceTool` adds to a
 * session-only list (per host, never persisted); the sidebar's Maintenance
 * section renders a closable row per tool, the workspace's tab bar a
 * closable tab per tool, and the section exists only while the list is
 * non-empty (or the workspace is on screen) — closing the last tool is how
 * the user says "I don't have it". The PANE behind a tool is more mortal: it
 * lives while the host's folder workspace stays mounted — across folder
 * navigation on the same host the pane rides along mounted-but-hidden, the
 * way a visited session tab does, so coming back is the SAME htop — but a
 * host-level navigation or a host switch unmounts it, and the next entry
 * starts a fresh one. The tool row survives all of that; only its × ends it.
 *
 * The root is `MAINTENANCE_ROOT` (`::maintenance::`, from core) — a stable
 * workspace key that names no directory, which is why it is not a root in
 * the session tree's grouping: the panel renders a Maintenance section for
 * it while tools are open, and the Host monitor button opens the same route.
 *
 * A tool pane is BARE (`TerminalView`'s `bare` prop): a plain SSH login
 * shell in the user's `$HOME` — sshd's own default cwd — with the tool's
 * command typed into it, so quitting htop leaves a live prompt in `~` and
 * the tab doubles as a maintenance shell.
 */
import { ref } from 'vue';
import { MAINTENANCE_ROOT } from '@pocketshell/core';
import type { WorkspaceTab } from '@pocketshell/core/shared/workspaceTabs';
import type { SessionDirectory } from './sessionTree';
import type { SessionPaneRecord } from './sessionPanes';

export { MAINTENANCE_ROOT };

/** The tools the maintenance workspace can hold. One today; the union grows with the section. */
export type MaintenanceToolKind = 'htop';

/** What runs in a tool pane, keyed by kind. A missing htop prints `command not found` — the honest answer. */
const TOOL_COMMANDS: Record<MaintenanceToolKind, string> = { htop: 'htop' };

/** One open tool on one host. */
export interface MaintenanceTool {
  host: string;
  kind: MaintenanceToolKind;
}

/** The open tools, this app session. Never persisted: a restart forgets, and the button re-teaches. */
const openTools = ref<readonly MaintenanceTool[]>([]);

/** Open [kind] on [host] — a no-op when it is already open. The trigger's one state change. */
export function openMaintenanceTool(host: string, kind: MaintenanceToolKind = 'htop'): void {
  if (maintenanceToolsFor(host).some((tool) => tool.kind === kind)) return;
  openTools.value = [...openTools.value, { host, kind }];
}

/** Close [kind] on [host]: the row and the tab go, and the section follows when the last one does. */
export function closeMaintenanceTool(host: string, kind: MaintenanceToolKind): void {
  openTools.value = openTools.value.filter((tool) => !(tool.host === host && tool.kind === kind));
}

/**
 * Close by kind NAME — for the surfaces that carry the kind as a string
 * (the sidebar row's event payload). An unknown kind is a no-op, not a
 * crash: the row and the list can only disagree for one tick, if ever.
 */
export function closeMaintenanceToolByName(host: string, kind: string): void {
  if (kind in TOOL_COMMANDS) closeMaintenanceTool(host, kind as MaintenanceToolKind);
}

/** [host]'s open tools, in open order. */
export function maintenanceToolsFor(host: string | null | undefined): readonly MaintenanceTool[] {
  return host ? openTools.value.filter((tool) => tool.host === host) : [];
}

/**
 * The registry identity of a tool pane — HOST-scoped, because vue-router
 * reuses the folder workspace across hosts and a bare `tool:htop` would let
 * one host's pane answer for another's.
 */
export function maintenanceToolIdentity(host: string, kind: MaintenanceToolKind): string {
  return `tool:${host}:${kind}`;
}

/** The kind an identity carries, or null for anything that is not a tool pane. */
export function maintenanceKindOf(identity: string): MaintenanceToolKind | null {
  const parts = identity.split(':');
  const kind = parts.length === 3 ? parts[2] : undefined;
  return parts[0] === 'tool' && kind !== undefined && kind in TOOL_COMMANDS
    ? (kind as MaintenanceToolKind)
    : null;
}

/** True when [identity] belongs to a maintenance tool pane. */
export function isMaintenanceIdentity(identity: string): boolean {
  return maintenanceKindOf(identity) !== null;
}

/** The command a tool pane runs, or undefined when [identity] is not one of ours. */
export function maintenanceCommandFor(identity: string): string | undefined {
  const kind = maintenanceKindOf(identity);
  return kind ? TOOL_COMMANDS[kind] : undefined;
}

/** The tab [tool] wears in the maintenance bar. A fresh object per call: tab labels are mutable display state. */
export function maintenanceToolTab(host: string, tool: MaintenanceTool): WorkspaceTab {
  return { kind: 'tool', id: maintenanceToolIdentity(host, tool.kind), label: tool.kind };
}

/** The pane record for a tool identity, minted the first time the tool is shown. */
export function maintenanceToolPane(identity: string): SessionPaneRecord {
  return { id: `pane-${identity}`, session: maintenanceKindOf(identity) ?? identity, identity };
}

/** True when the route's `:folder` is the maintenance root. */
export function isMaintenanceFolder(folderKey: string | null | undefined): boolean {
  return folderKey === MAINTENANCE_ROOT;
}

/**
 * The sidebar row's route-level directory — what the session tree's
 * Maintenance section hands the SAME `select` event the folder rows emit,
 * with the tool's identity as the tab hand-off. It models no directory:
 * `rows` is empty and never enters the grouping (the section is chrome the
 * tree renders beside the roots, not a root among them), and `path` is the
 * pseudo-key itself — the row names a workspace, not a place on disk.
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
