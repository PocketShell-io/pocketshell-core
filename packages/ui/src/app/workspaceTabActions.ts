import { computed, shallowRef, type ComputedRef } from 'vue';
import type { WorkspaceTab } from '@pocketshell/core/shared/workspaceTabs';

/**
 * What the front workspace tab offers besides being looked at: rename it,
 * stop it, close it.
 *
 * On a phone the tab strip carries no `×` and right-click has no touch twin
 * yet, so these actions are reached from the host overflow sheet instead. The
 * host workspace (the app bar's owner) cannot see into the folder workspace
 * that owns the tab model, so the folder workspace advertises the rows here —
 * the same one-slot shape as `workspaceFocus.ts`. Each row's `run` is the
 * handler the tab bar's own menu and `×` already use, so Stop still arms the
 * named confirm dialog and never kills directly.
 */
export interface TabActionRow {
  id: 'rename' | 'stop' | 'close';
  label: string;
  /** Tinted like the tab menu's Stop: the one row that can lose work. */
  danger?: boolean;
  run: () => void;
}

type Source = () => readonly TabActionRow[];

const EMPTY: readonly TabActionRow[] = [];
const source = shallowRef<Source | null>(null);

/** The mounted folder workspace advertises its front tab's actions. */
export function registerTabActions(fn: Source): void {
  source.value = fn;
}

/** The workspace is going away; a stale slot must not act on an unmounted tree. */
export function unregisterTabActions(fn: Source): void {
  if (source.value === fn) source.value = null;
}

/** The rows for whatever tab is in front right now; empty when no workspace is mounted. */
export function useActiveTabActions(): ComputedRef<readonly TabActionRow[]> {
  return computed(() => source.value?.() ?? EMPTY);
}

/**
 * The rows for [tab], built from the handlers the tab bar and the chords
 * already use. A pure function so its contract is testable without mounting a
 * terminal: a session tab offers Rename and Stop (which only ARMS the named
 * confirm dialog, via `stop`), a Files tab offers its close, a tool tab its
 * close. No tab, no rows.
 */
export function tabActionRowsFor(
  tab: WorkspaceTab | null | undefined,
  handlers: {
    rename: (tab: Extract<WorkspaceTab, { kind: 'session' }>) => void;
    stop: (session: string) => void;
    closeFiles: (id: string) => void;
    closeTool: (tab: Extract<WorkspaceTab, { kind: 'tool' }>) => void;
  },
): readonly TabActionRow[] {
  if (!tab) return EMPTY;
  if (tab.kind === 'session') {
    return [
      { id: 'rename', label: 'Rename session…', run: () => handlers.rename(tab) },
      { id: 'stop', label: 'Stop this session', danger: true, run: () => handlers.stop(tab.session) },
    ];
  }
  if (tab.kind === 'files') {
    return [{ id: 'close', label: 'Close this Files tab', run: () => handlers.closeFiles(tab.id) }];
  }
  return [{ id: 'close', label: 'Close this tool', run: () => handlers.closeTool(tab) }];
}
