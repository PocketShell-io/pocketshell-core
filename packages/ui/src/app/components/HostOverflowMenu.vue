<script setup lang="ts">
// HostOverflowMenu: the compact layout's overflow (⋮) menu — the host tools as
// labelled rows. It replaces two desktop surfaces at once, the 36px icon rail's
// host buttons and the session panel header's strip of icon squares, with words
// instead of tooltips (a tooltip never shows on touch).
//
// It is a plain PopupMenu: the app's ONE menu, which on a finger-on-compact
// screen is already a bottom sheet with 48px rows (usePopupSheet), and a normal
// anchored menu for a mouse in a narrow window. No second sheet component.
//
// Rows: the host tools (Ports, Usage, Monitor from HOST_PANEL_ITEMS, so the
// vocabulary is the one the desktop buttons use), Quick actions, Settings, and
// — when the caller has a tab in front — that tab's own actions (Rename,
// "Stop this session"), which the compact tab strip no longer carries a `×`
// for. Stop arrives as the tab bar's own handler: it arms the named confirm
// dialog, it never kills on this tap.
import AppIcon from '@ui/components/AppIcon.vue';
import PopupMenu from './PopupMenu.vue';
import type { Box } from '@pocketshell/core/shared/popupPlacement';
import { HOST_PANEL_ITEMS, hostPanelTitle, type HostPanel } from '../hostPanels';
import type { TabActionRow } from '../workspaceTabActions';

withDefaults(
  defineProps<{
    /** The ⋮ button's box: where the menu hangs when it is not a sheet. */
    anchor: Box;
    ignore?: (HTMLElement | null | undefined)[];
    autoForward?: boolean;
    forwardCount?: number;
    tabActions?: readonly TabActionRow[];
  }>(),
  { ignore: () => [], autoForward: false, forwardCount: 0, tabActions: () => [] },
);

const emit = defineEmits<{
  close: [];
  select: [panel: HostPanel];
  palette: [];
}>();

function pick(panel: HostPanel): void {
  emit('close');
  emit('select', panel);
}

function palette(): void {
  emit('close');
  emit('palette');
}

function runTabAction(row: TabActionRow): void {
  emit('close');
  row.run();
}
</script>

<template>
  <PopupMenu :anchor="anchor" :ignore="ignore" label="Host menu" @close="emit('close')">
    <ul data-testid="host-overflow-sheet">
      <li v-for="item in HOST_PANEL_ITEMS" :key="item.panel">
        <button
          class="menu-item"
          :data-testid="`host-overflow-${item.panel}`"
          @click="pick(item.panel)"
        >
          <AppIcon :name="item.icon" :size="16" />
          <span>{{ hostPanelTitle(item, { autoForward, forwardCount }) }}</span>
        </button>
      </li>
      <li>
        <button class="menu-item" data-testid="host-overflow-palette" @click="palette">
          <AppIcon name="search" :size="16" />
          <span>Quick actions</span>
        </button>
      </li>
      <li>
        <button class="menu-item" data-testid="host-overflow-settings" @click="pick('settings')">
          <AppIcon name="settings" :size="16" />
          <span>Settings</span>
        </button>
      </li>
      <template v-if="tabActions.length">
        <li class="menu-sep" />
        <li v-for="row in tabActions" :key="row.id">
          <button
            :class="['menu-item', { danger: row.danger }]"
            :data-testid="`host-overflow-tab-${row.id}`"
            @click="runTabAction(row)"
          >
            <span>{{ row.label }}</span>
          </button>
        </li>
      </template>
    </ul>
  </PopupMenu>
</template>

<style scoped>
/* The one item that can lose work looks like it (the tab menu's rule). Written
   from `ul` because this component's root is PopupMenu, whose own root is a
   Teleport: it carries no scope id, so a `.popup-menu`-rooted rule here would
   never match. The extra `ul` also outranks PopupMenu's `.menu-item` colour. */
ul .menu-item.danger {
  color: var(--error);
}
ul .menu-item.danger:hover {
  background: var(--error-soft);
}
</style>
