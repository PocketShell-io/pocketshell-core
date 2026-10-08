<script setup lang="ts">
// SessionTreeRows: the desktop panel's binding of the presentational rows
// (SessionTreeRowsView.vue) to the stores — the shared tree derivation
// (../folderTree.ts), the sort setting, the session list's loading state and
// the folder drag (../useFolderDrag.ts). It adds no markup of its own; the
// rows, their reasoning and their styles live in the view.
import { computed } from 'vue';
import { useFolderTree } from '../folderTree';
import { useSessionsStore } from '../stores/sessions';
import { useSettingsStore } from '../stores/settings';
import type { SessionDirectory } from '../sessionTree';
import { tabOrderFor } from '../tabOrders';
import { useFolderDrag } from '../useFolderDrag';
import SessionTreeRowsView from './SessionTreeRowsView.vue';

const props = defineProps<{
  /** Key of the folder whose workspace is open (see SessionTreeRowsView). */
  activeFolder?: string | null;
  /** The open folder's selected session tab, for the narrow layout's leaves. */
  activeSession?: string | null;
  /** The panel's minute clock (`useSessionTreePoll`), for the relative ages. */
  now: number;
  /** Where the empty state's "New session…" starts the picker. */
  defaultStartIn: string | null;
  /** Draw each folder's sessions as leaf rows (the narrow layout). */
  showSessions?: boolean;
}>();

const emit = defineEmits<{
  select: [folder: SessionDirectory, session?: string];
  menu: [dir: SessionDirectory, e: MouseEvent];
  create: [startIn: string | null];
  sort: [trigger: HTMLButtonElement];
}>();

// The same derivation the parent renders from — one code path, two component
// instances reading it. See ../folderTree.ts for why this is not private to
// either of them.
const { home, host, roots, filtering, filterQuery } = useFolderTree();

/**
 * Every drawn folder's stored tab ranking, keyed by folder key — the marks a
 * row wears are the folder's tab bar folded flat, so the view needs the same
 * arrangement the workspace's bar applies.
 *
 * Read here rather than in the view because the view reads no store
 * (its header holds that rule); the read is `tabOrderFor`, whose reactive
 * tick makes this computed — and with it the rows — re-render the moment a
 * tab drag lands in the workspace. The view receives the result as the plain
 * data prop it expects.
 */
const tabOrders = computed<Record<string, readonly string[]>>(() => {
  const out: Record<string, readonly string[]> = {};
  for (const root of roots.value) {
    for (const dir of root.directories) out[dir.key] = tabOrderFor(host.value, dir.key);
  }
  return out;
});

const sessions = useSessionsStore();
const settings = useSettingsStore();

// The drag's state, handlers and reasoning live in ../useFolderDrag.ts; this
// binds them to the rows — the folder rows' drag and, one level up, the root
// headers' own.
const {
  dragging,
  dropTarget,
  rootDragging,
  rootDropTarget,
  onRowDragStart,
  onRowDragOver,
  onRowDrop,
  onRootDragStart,
  onRootDragOver,
  onRootDrop,
  onRowDragEnd,
} = useFolderDrag({ roots, host, settings });
</script>

<template>
  <SessionTreeRowsView
    :roots="roots"
    :home="home"
    :active-folder="props.activeFolder ?? null"
    :active-session="props.activeSession ?? null"
    :now="props.now"
    :default-start-in="props.defaultStartIn"
    :sort-engaged="settings.sessionTreeSort !== 'host'"
    :filtering="filtering"
    :filter-query="filterQuery"
    :loading="sessions.loading"
    :show-sessions="props.showSessions ?? false"
    :dragging="dragging"
    :drop-target="dropTarget"
    :root-dragging="rootDragging"
    :root-drop-target="rootDropTarget"
    :tab-orders="tabOrders"
    @select="(folder, session) => emit('select', folder, session)"
    @menu="(dir, e) => emit('menu', dir, e)"
    @create="emit('create', $event)"
    @sort="emit('sort', $event)"
    @drag-start="onRowDragStart"
    @drag-over="onRowDragOver"
    @drop="onRowDrop"
    @drag-end="onRowDragEnd"
    @root-drag-start="onRootDragStart"
    @root-drag-over="onRootDragOver"
    @root-drop="onRootDrop"
  />
</template>
