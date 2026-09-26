<script setup lang="ts">
// FolderSortMenu: the session panel's folder-sort menu — one stored value,
// `settings.sessionTreeSort`, reached through THREE doors (the search row's
// trigger and the root rows' marks in SessionTree, Settings' "Session panel"
// select beside them). This component owns the open state and the PopupMenu;
// the doors hand it the button that was clicked. The rules the keys obey live
// in ../folderSort.ts (within roots, stable, the manual drag still wins on
// top); the choice itself lives in the settings store, global rather than per
// host — a way of reading a list, not a fact about a box (the store's field
// comment holds the argument).
//
// Extracted from SessionTree.vue, which had grown three doors' worth of menu
// plumbing past the component-size line without owning the one decision any
// of it turns on: which key is picked.
import { ref } from 'vue';
import AppIcon from '@ui/components/AppIcon.vue';
import PopupMenu from './PopupMenu.vue';
import { FOLDER_SORT_KEYS, FOLDER_SORT_LABELS, type FolderSortKey } from '../folderSort';
import { useSettingsStore } from '../stores/settings';
import type { Box } from '@pocketshell/core/shared/popupPlacement';

const settings = useSettingsStore();

/**
 * The open state, carrying the button that holds it. PopupMenu with a
 * snapshotted anchor box, exactly the collapsed rail's session switcher
 * (HostWorkspaceView `toggleSwitcher`): the menu is teleported past every
 * clipping ancestor and placed from a measured rect, and the trigger sits in
 * the `ignore` list so the click that toggles it cannot be the click that
 * closes it.
 */
const menu = ref<{ anchor: Box; trigger: HTMLButtonElement } | null>(null);

/**
 * Open on `trigger`, or close when THIS trigger already holds the menu. A
 * second trigger MOVES it rather than closing: the doors are equal, and a
 * click that names another door reads as "open here", not "dismiss". The
 * element is kept, not just its rect, so the toggle can tell the doors apart
 * and PopupMenu can ignore the one that opened it.
 */
function toggle(trigger: HTMLButtonElement): void {
  if (menu.value?.trigger === trigger) {
    menu.value = null;
    return;
  }
  menu.value = { anchor: trigger.getBoundingClientRect(), trigger };
}

/**
 * The search row's trigger unmounts with the row; SessionTree's `searchOpen`
 * watch calls this so the menu cannot hang anchored to the rect of a button
 * that no longer exists — with the element gone, the toggle could not close
 * it either.
 */
function close(): void {
  menu.value = null;
}

const options = FOLDER_SORT_KEYS.map((key) => ({ key, label: FOLDER_SORT_LABELS[key] }));

function setSort(key: FolderSortKey): void {
  // The action, not a bare write: picking a sort clears every host's dragged
  // arrangement — the store action's comment holds the story of the sort the
  // user picked and never saw applied.
  settings.setSessionTreeSort(key);
  menu.value = null;
}

defineExpose({ toggle, close });
</script>

<template>
  <PopupMenu
    v-if="menu"
    :anchor="menu.anchor"
    :ignore="[menu.trigger]"
    label="Sort folders"
    @close="close"
  >
    <ul>
      <!-- One key per item, the active one ticked — a radio in menu clothing.
           The tick is rendered only on the active key inside a fixed-width
           slot, so the labels align and the tick cannot be misread as
           one-per-item. The slot spans are THIS component's markup, so their
           scoped styles follow them through the menu's teleport — the earlier
           `visibility` attempt hung off `.popup-menu :deep(...)`, which needs
           the menu root to carry this component's scope id; a teleported root
           does not, and all four ticks showed at once. -->
      <li v-for="opt in options" :key="opt.key">
        <button class="menu-item" @click="setSort(opt.key)">
          <span class="sort-tick">
            <AppIcon v-if="settings.sessionTreeSort === opt.key" name="check" :size="14" />
          </span>
          {{ opt.label }}
        </button>
      </li>
    </ul>
  </PopupMenu>
</template>

<style scoped>
/* The tick slot: always laid out so the labels align across items, holding
   the check only on the active key. Direct scoped rule on this component's
   own markup — see the template comment for why it must not hang off
   `.popup-menu :deep(...)`. */
.sort-tick {
  flex: none;
  display: inline-flex;
  justify-content: center;
  width: 14px;
  color: var(--accent);
}
</style>
