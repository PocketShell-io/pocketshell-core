/**
 * The quick-actions palette's command list and open state, lifted out of
 * `HostWorkspaceView` — not as a tidy-up but as a design gate payment: the
 * view sits under CLEAN_CODE's 1000-line cap only while the verbs it does not
 * own the implementations of live in their own module.
 *
 * The rules the list follows are the view's, and they are stated there: this
 * composable builds from the SAME stores the panel and tabs read — one
 * derivation, no second opinion — in a fixed rhetorical order. Folders first
 * (the palette's "go to file": jumping to a folder is the thing the palette is
 * FOR), then creation and the search row, then the overlays, then the panel
 * chrome and the way out. `allFolders`, not the drawn rows: a palette is a
 * jump list, and the search row's query is nobody's business here.
 *
 * Everything the list can DO is a handler the owning surfaces publish —
 * `onSelectFolder` is the panel row's own navigation, the session-tree verbs
 * arrive through the exposed ref, the overlays flip the same `panel` ref the
 * header buttons flip. The palette re-implements nothing; that is the point.
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue';
import type { PaletteCommand } from './commandPalette';
import { FOLDER_SORT_KEYS, FOLDER_SORT_LABELS, type FolderSortKey } from './folderSort';
import { useSettingsStore } from './stores/settings';
import type { HostPanel } from './hostPanels';
import type { SessionDirectory, SessionRootFolder } from './sessionTree';

export interface QuickActionsDeps {
  /** Every folder on the host, pre-filter — the palette's jump list. */
  allFolders: ComputedRef<SessionDirectory[]>;
  /** The root sections, for a folder's muted hint (`~/git`). */
  roots: ComputedRef<SessionRootFolder[]>;
  /** The overlay ref: the panel commands flip the same ref the buttons flip. */
  panel: Ref<HostPanel | null>;
  /** The panel's collapsed flag, for the show/hide verb. */
  panelCollapsed: Ref<boolean>;
  /** The session panel's published verbs (`openCreate`, `openSearch`). */
  sessionTree: Ref<{ openCreate: () => void; openSearch: () => void } | null>;
  /** The panel row's own navigation — a palette folder pick IS a row click. */
  onSelectFolder: (dir: SessionDirectory, session?: string) => void;
  /** The way out: back to the host list. */
  onBack: () => void;
}

export function useQuickActions(deps: QuickActionsDeps): {
  open: Ref<boolean>;
  commands: ComputedRef<PaletteCommand[]>;
} {
  const settings = useSettingsStore();

  const open = ref(false);

  const commands = computed<PaletteCommand[]>(() => {
    const list: PaletteCommand[] = [];
    for (const dir of deps.allFolders.value) {
      const rootKey = deps.roots.value.find((root) =>
        root.directories.some((d) => d.key === dir.key),
      )?.key;
      list.push({
        id: `folder:${dir.key}`,
        label: `Open ${dir.label}`,
        hint: rootKey ?? dir.path,
        keywords: `${dir.path} ${dir.rows.map((r) => r.session.name).join(' ')}`,
        run: () => deps.onSelectFolder(dir),
      });
    }
    list.push(
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
    );
    for (const key of FOLDER_SORT_KEYS) {
      list.push({
        id: `sort:${key}`,
        label: `Sort folders: ${FOLDER_SORT_LABELS[key as FolderSortKey]}`,
        keywords: 'order',
        run: () => settings.setSessionTreeSort(key as FolderSortKey),
      });
    }
    list.push(
      {
        id: 'panel:toggle',
        label: deps.panelCollapsed.value ? 'Show the session panel' : 'Hide the session panel',
        run: () => (deps.panelCollapsed.value = !deps.panelCollapsed.value),
      },
      {
        id: 'hosts:back',
        label: 'Back to the host list',
        keywords: 'switch host connect',
        run: deps.onBack,
      },
    );
    return list;
  });

  return { open, commands };
}
