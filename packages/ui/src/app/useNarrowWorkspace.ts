import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';
import { useLayoutClass } from './layoutClass';
import { resolveWorkspaceLayout, type WorkspaceLayout } from './workspaceLayout';

/**
 * The host workspace's narrow (phone) layout: one half at a time below
 * NARROW_WORKSPACE_MAX_WIDTH (./workspaceLayout.ts) — the panel full width
 * until a folder opens, then the folder's pane with the rail as the way back.
 * The panel draws each folder's sessions as leaves in that layout, because the
 * pane's tab bar is not beside it to show them.
 *
 * The width class comes from `useLayoutClass` (./layoutClass.ts); this is its
 * `compact` consumer.
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
  const layoutClass = useLayoutClass();
  // Compact is today's narrow: one half on screen at a time.
  const narrow = computed(() => layoutClass.value === 'compact');

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
