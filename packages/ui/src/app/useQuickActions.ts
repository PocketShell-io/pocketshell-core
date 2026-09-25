/**
 * The quick-actions palette's command list and open state, lifted out of
 * `HostWorkspaceView` — not as a tidy-up but as a design gate payment: the
 * view sits under CLEAN_CODE's 1000-line cap only while the verbs it does not
 * own the implementations of live in their own module.
 *
 * The rules the list follows are the view's, and they are stated there: this
 * composable builds from the SAME stores the panel and tabs read — one
 * derivation, no second opinion. The list is in a fixed rhetorical order:
 * the host's SESSIONS first, grouped under their root keys the way the panel
 * groups them — the palette's "go to file", and the answer to "which of this
 * folder's three sessions do I mean": a folder holding several sessions gets
 * one row per session, each opening the folder workspace with THAT tab in
 * front (`onSelectFolder`'s second argument, the same channel a create uses).
 * A folder holding one keeps a single row labelled by the folder, because a
 * folder and its only session are one destination. Then creation and the
 * search row, then the overlays, then the panel chrome, the view-level
 * preferences, and the way out. `allFolders`, not the drawn rows: a palette
 * is a jump list, and the search row's query is nobody's business here.
 *
 * Everything the list can DO is a handler the owning surfaces publish —
 * `onSelectFolder` is the panel row's own navigation, the session-tree verbs
 * arrive through the exposed ref, the overlays flip the same `panel` ref the
 * header buttons flip, host switching is the picker's own connect. The
 * palette re-implements nothing; that is the point.
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue';
import type { PaletteCommand } from './commandPalette';
import { FOLDER_SORT_KEYS, FOLDER_SORT_LABELS, type FolderSortKey } from './folderSort';
import { sessionIdentityKey } from './sessionIdentity';
import { useSettingsStore } from './stores/settings';
import { useConnectionStore } from './stores/connection';
import { useSessionsStore } from './stores/sessions';
import type { HostPanel } from './hostPanels';
import type { HostEntry } from '@pocketshell/core';
import type { SessionDirectory, SessionRootFolder } from './sessionTree';

export interface QuickActionsDeps {
  /** Every folder on the host, pre-filter — the palette's jump list. */
  allFolders: ComputedRef<SessionDirectory[]>;
  /** The root sections, for a session's group head and a folder's hint. */
  roots: ComputedRef<SessionRootFolder[]>;
  /** The overlay ref: the panel commands flip the same ref the buttons flip. */
  panel: Ref<HostPanel | null>;
  /** The panel's collapsed flag, for the show/hide verb. */
  panelCollapsed: Ref<boolean>;
  /** The session panel's published verbs (`openCreate`, `openSearch`). */
  sessionTree: Ref<{ openCreate: () => void; openSearch: () => void } | null>;
  /** The panel row's own navigation — a palette pick IS a row click. */
  onSelectFolder: (dir: SessionDirectory, session?: string) => void;
  /** Host switching, the picker's own connect (`connect` + `host-sessions`). */
  onConnectHost: (host: HostEntry) => void;
  /** The way out: back to the host list. */
  onBack: () => void;
}

export function useQuickActions(deps: QuickActionsDeps): {
  open: Ref<boolean>;
  commands: ComputedRef<PaletteCommand[]>;
} {
  const settings = useSettingsStore();
  const connection = useConnectionStore();
  const sessions = useSessionsStore();

  const open = ref(false);

  const commands = computed<PaletteCommand[]>(() => {
    const list: PaletteCommand[] = [];
    for (const dir of deps.allFolders.value) {
      const rootKey =
        deps.roots.value.find((root) => root.directories.some((d) => d.key === dir.key))
          ?.key ?? 'other';
      const names = dir.rows.map((r) => r.session.name).join(' ');
      // The folder row: the switcher's row, in the palette. A folder holding
      // several sessions also gets one row PER SESSION below — that is the
      // "which one" the user asked for — while a folder holding exactly one
      // needs no session row, because folder and session are one destination
      // and saying so twice is the dead field the panel's count rule retired.
      list.push({
        id: `folder:${dir.key}`,
        label: `Open ${dir.label}`,
        hint: dir.rows.length > 1 ? `${rootKey} · ${dir.rows.length}` : (rootKey ?? dir.path),
        keywords: `${dir.path} ${names}`,
        group: rootKey,
        dot: dir.active,
        run: () => deps.onSelectFolder(dir),
      });
      if (dir.rows.length > 1) {
        for (const row of dir.rows) {
          // `folder:session` — the host's own selector spelling (the same
          // `workspace:tag` the crash warnings speak). The label carries the
          // whole address because `main` alone repeats down the list; the
          // hint would only say the label again.
          list.push({
            id: `session:${sessionIdentityKey(row.session.name, {
              backend: row.session.backend,
              workspace: row.session.workspace,
            })}:${dir.key}`,
            label: `Open ${dir.label}:${row.session.name}`,
            keywords: `${dir.label} ${row.session.name} ${dir.path}`,
            group: rootKey,
            dot: row.session.attached,
            run: () => deps.onSelectFolder(dir, row.session.name),
          });
        }
      }
    }

    const verbs: PaletteCommand[] = [
      {
        id: 'sessions:new',
        label: 'New session…',
        run: () => deps.sessionTree.value?.openCreate(),
      },
      {
        id: 'sessions:search',
        label: 'Quick search sessions',
        run: () => deps.sessionTree.value?.openSearch(),
      },
      { id: 'panel:ports', label: 'Port forwarding', run: () => (deps.panel.value = 'ports') },
      { id: 'panel:usage', label: 'Provider usage', run: () => (deps.panel.value = 'usage') },
      { id: 'panel:settings', label: 'Settings', run: () => (deps.panel.value = 'settings') },
    ];
    for (const key of FOLDER_SORT_KEYS) {
      verbs.push({
        id: `sort:${key}`,
        label: `Sort folders: ${FOLDER_SORT_LABELS[key as FolderSortKey]}`,
        run: () => settings.setSessionTreeSort(key as FolderSortKey),
      });
    }
    verbs.push(
      {
        id: 'panel:toggle',
        label: deps.panelCollapsed.value ? 'Show the session panel' : 'Hide the session panel',
        run: () => (deps.panelCollapsed.value = !deps.panelCollapsed.value),
      },
      {
        id: 'sessions:refresh',
        label: 'Refresh sessions',
        run: () => {
          if (connection.connectionId) void sessions.refresh(connection.connectionId);
        },
      },
    );
    for (const host of connection.hosts) {
      if (host.name === connection.activeHost?.name) continue;
      verbs.push({
        id: `hosts:connect:${host.name}`,
        label: `Connect to ${host.name}`,
        keywords: 'host ssh switch',
        run: () => deps.onConnectHost(host),
      });
    }
    verbs.push(
      { id: 'view:zoomIn', label: 'Zoom in', run: () => settings.zoomIn() },
      { id: 'view:zoomOut', label: 'Zoom out', run: () => settings.zoomOut() },
      { id: 'view:zoomReset', label: 'Reset zoom', run: () => settings.resetZoom() },
      {
        id: 'hosts:back',
        label: 'Back to the host list',
        keywords: 'switch host',
        run: deps.onBack,
      },
    );
    list.push(...verbs.map((verb) => ({ ...verb, group: 'Commands' })));
    return list;
  });

  return { open, commands };
}
