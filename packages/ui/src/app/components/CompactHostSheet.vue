<script setup lang="ts">
// CompactHostSheet: the compact layout's overflow (⋮) menu, as a bottom sheet
// of labelled 48px rows. It replaces two desktop surfaces at once — the 36px
// icon rail's host buttons and the session panel header's strip of icon
// squares — with words instead of tooltips (a tooltip never shows on touch).
//
// Rows: the host tools (Ports, Usage, Monitor from HOST_PANEL_ITEMS, so the
// vocabulary is the same one the desktop buttons use), Quick actions, Settings,
// and — when the caller has a tab in front — that tab's own actions (Rename,
// "Stop this session"), which the compact tab strip no longer carries a `×`
// for. Stop arrives as the tab bar's own handler: it arms the named confirm
// dialog, it never kills on this tap.
import AppIcon from '@ui/components/AppIcon.vue';
import CompactSheet from './CompactSheet.vue';
import { HOST_PANEL_ITEMS, hostPanelTitle, type HostPanel } from '../hostPanels';
import type { TabActionRow } from '../workspaceTabActions';

withDefaults(
  defineProps<{
    autoForward?: boolean;
    forwardCount?: number;
    tabActions?: readonly TabActionRow[];
  }>(),
  { autoForward: false, forwardCount: 0, tabActions: () => [] },
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
  <CompactSheet label="Host menu" @close="emit('close')">
    <ul data-testid="host-overflow-sheet">
      <li v-for="item in HOST_PANEL_ITEMS" :key="item.panel">
        <button
          class="sheet-row"
          :data-testid="`host-overflow-${item.panel}`"
          @click="pick(item.panel)"
        >
          <AppIcon :name="item.icon" :size="16" />
          <span>{{ hostPanelTitle(item, { autoForward, forwardCount }) }}</span>
        </button>
      </li>
      <li>
        <button class="sheet-row" data-testid="host-overflow-palette" @click="palette">
          <AppIcon name="search" :size="16" />
          <span>Quick actions</span>
        </button>
      </li>
      <li>
        <button class="sheet-row" data-testid="host-overflow-settings" @click="pick('settings')">
          <AppIcon name="settings" :size="16" />
          <span>Settings</span>
        </button>
      </li>
      <template v-if="tabActions.length">
        <li class="sheet-sep" />
        <li v-for="row in tabActions" :key="row.id">
          <button
            :class="['sheet-row', { danger: row.danger }]"
            :data-testid="`host-overflow-tab-${row.id}`"
            @click="runTabAction(row)"
          >
            <span>{{ row.label }}</span>
          </button>
        </li>
      </template>
    </ul>
  </CompactSheet>
</template>
