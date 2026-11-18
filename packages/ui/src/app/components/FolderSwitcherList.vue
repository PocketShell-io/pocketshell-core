<script setup lang="ts">
// FolderSwitcherList: the folder switcher's contents — one head per root, one
// item per folder, the session panel's two levels in the panel's order. One
// list shared by the two surfaces that hold it: the PopupMenu hung off the
// collapsed rail's button and the app bar's title on a phone (PopupMenu is a
// bottom sheet there, usePopupSheet), so the two cannot disagree about what a row says.
import AppIcon from '@ui/components/AppIcon.vue';
import type { SessionDirectory } from '../sessionTree';

defineProps<{
  roots: ReadonlyArray<{ key: string; directories: readonly SessionDirectory[] }>;
  folders: readonly SessionDirectory[];
  activeFolder: string | null;
}>();
const emit = defineEmits<{ pick: [dir: SessionDirectory] }>();
</script>

<template>
  <ul>
    <!-- One head per root, one item per folder: the panel's two levels, in the
         panel's order. A root holding no folders is skipped — its header is a
         label over rows that are not there, and a switcher item you cannot
         switch to is noise (the expanded panel, which can explain an empty
         registered root in words, still draws it). -->
    <template v-for="root in roots" :key="root.key">
      <li v-if="root.directories.length" class="menu-head switch-root">
        {{ root.key }}
      </li>
      <li v-for="dir in root.directories" :key="dir.key">
        <button
          :class="['menu-item', 'switch-item', { current: dir.key === activeFolder }]"
          @click="emit('pick', dir)"
        >
          <!-- The panel row's two marks, same meanings: the dot says something
               live is in here, the check says this is the workspace already on
               screen. -->
          <span class="dot" :class="{ active: dir.active }" />
          <span class="switch-label">{{ dir.label }}</span>
          <span v-if="dir.rows.length > 1" class="switch-count muted">
            {{ dir.rows.length }}
          </span>
          <AppIcon
            v-if="dir.key === activeFolder"
            name="check"
            :size="14"
            class="current-check"
          />
        </button>
      </li>
    </template>
    <li v-if="!folders.length" class="menu-head switch-root">no sessions</li>
  </ul>
</template>

<style scoped>
/* The switcher menu's own register, on top of PopupMenu's `.menu-item`. The
   root head is a PATH (`~/git`), not a label — uppercasing it would spell the
   directory wrong, so it opts out of the menu-head transform the way the
   panel's own `path-prefix` keeps `~/` in its lower-case voice. */
.switch-root {
  text-transform: none;
  letter-spacing: 0;
}
/* The panel row's marks at menu size: the same 8px dot with the same two
   states (grey quiet, green something-live), and a label that ellipsises
   rather than pushes the count and check off the menu. */
.switch-item .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--fg-muted);
  flex: none;
}
.switch-item .dot.active {
  background: var(--success);
}
.switch-label {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Count hugs its label the way the panel's row count does, and the check —
   the open workspace's mark — takes the far end. */
.switch-count {
  flex: none;
  font-size: var(--fs-200);
}
.current-check {
  margin-left: auto;
  color: var(--accent);
  flex: none;
}
.switch-item.current {
  background: var(--state-selected);
}
.switch-item.current .switch-label {
  color: var(--accent);
  font-weight: var(--fw-medium);
}
</style>
