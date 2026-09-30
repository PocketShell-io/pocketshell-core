import { computed, onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from 'vue';
import { NARROW_WORKSPACE_QUERY, resolveWorkspaceLayout, type WorkspaceLayout } from './workspaceLayout';

/**
 * The host workspace's narrow (phone) layout: one half at a time below
 * NARROW_WORKSPACE_MAX_WIDTH (./workspaceLayout.ts) — the panel full width
 * until a folder opens, then the folder's pane with the rail as the way back.
 * The panel draws each folder's sessions as leaves in that layout, because the
 * pane's tab bar is not beside it to show them.
 *
 * `matchMedia` is absent in some test DOMs; no query means the wide layout,
 * which is exactly what the desktop has always drawn.
 */
export function useNarrowWorkspace(deps: {
  activeFolder: ComputedRef<string | null>;
  panelCollapsed: Ref<boolean>;
}): {
  layout: ComputedRef<WorkspaceLayout>;
  /** What is on screen: the collapsed rail, the panel, its splitter, the pane. */
  shown: ComputedRef<{ rail: boolean; panel: boolean; splitter: boolean; pane: boolean }>;
  onShowPanel: () => void;
  onCollapsePanel: () => void;
  closeNarrowPanel: () => void;
} {
  const narrow = ref(false);
  let query: MediaQueryList | null = null;
  const onChange = (event: MediaQueryListEvent): void => {
    narrow.value = event.matches;
  };
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    query = window.matchMedia(NARROW_WORKSPACE_QUERY);
    narrow.value = query.matches;
    query.addEventListener('change', onChange);
  }
  onBeforeUnmount(() => query?.removeEventListener('change', onChange));

  /** The rail's "show panel" over an open folder, in the narrow layout. */
  const narrowPanelOpen = ref(false);
  watch(deps.activeFolder, () => {
    narrowPanelOpen.value = false;
  });

  const layout = computed(() =>
    resolveWorkspaceLayout({
      narrow: narrow.value,
      hasFolder: deps.activeFolder.value !== null,
      panelRequested: narrowPanelOpen.value,
    }),
  );

  const shown = computed(() => {
    const split = layout.value === 'split';
    const collapsed = deps.panelCollapsed.value;
    return {
      rail: layout.value === 'pane' || (split && collapsed),
      panel: layout.value === 'panel' || (split && !collapsed),
      splitter: split && !collapsed,
      pane: layout.value !== 'panel',
    };
  });

  return {
    layout,
    shown,
    onShowPanel: () => {
      if (narrow.value) narrowPanelOpen.value = true;
      else deps.panelCollapsed.value = false;
    },
    onCollapsePanel: () => {
      if (layout.value === 'split') deps.panelCollapsed.value = true;
      else narrowPanelOpen.value = false;
    },
    closeNarrowPanel: () => {
      narrowPanelOpen.value = false;
    },
  };
}
