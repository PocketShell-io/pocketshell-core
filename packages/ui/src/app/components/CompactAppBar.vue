<script setup lang="ts">
// CompactAppBar: the phone's one row of workspace navigation, above the folder
// tabs — back, the folder switcher (the title, with a chevron), and the
// overflow (⋮). It stands where the 36px icon rail stood on a narrow screen and
// does the rail's jobs with thumb-sized controls: ← returns to the session
// list, the title opens the folder switcher, ⋮ opens the host tools.
//
// Presentation only: it announces, HostWorkspaceView disposes.
import AppIcon from '@ui/components/AppIcon.vue';
import type { Box } from '@pocketshell/core/shared/popupPlacement';

defineProps<{ title: string }>();
const emit = defineEmits<{ back: []; switcher: [anchor: Box, el: HTMLElement]; overflow: [anchor: Box, el: HTMLElement] }>();

/** The trigger's box, for the menu to hang from when it is not a sheet. */
function boxOf(e: MouseEvent): [Box, HTMLElement] {
  const el = e.currentTarget as HTMLElement;
  return [el.getBoundingClientRect(), el];
}
</script>

<template>
  <header class="compact-app-bar" data-testid="compact-app-bar">
    <button class="icon-btn" title="Back to sessions" aria-label="Back to sessions" @click="emit('back')">
      <AppIcon name="arrow-left" :size="16" />
    </button>
    <button
      class="bar-title"
      data-testid="compact-app-bar-title"
      aria-haspopup="dialog"
      :aria-label="`${title}, switch folder`"
      @click="emit('switcher', ...boxOf($event))"
    >
      <span class="bar-title-text">{{ title }}</span>
      <AppIcon name="chevron-down" :size="14" />
    </button>
    <button class="icon-btn" title="More" aria-label="More" aria-haspopup="dialog" @click="emit('overflow', ...boxOf($event))">
      <AppIcon name="more-vertical" :size="16" />
    </button>
  </header>
</template>

<style scoped>
.compact-app-bar {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  height: var(--topbar-h);
  flex: 0 0 auto;
  padding: 0 var(--sp-1);
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
/* The title takes the middle and is the switcher's trigger: left-aligned like
   a navigation title, the whole stretch tappable, the name truncating rather
   than pushing the overflow off the bar. */
.bar-title {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex: 1 1 auto;
  min-width: 0;
  min-height: var(--hit-min);
  height: 100%;
  padding: 0 var(--sp-2);
  background: transparent;
  border: none;
  color: var(--fg);
  font-family: var(--font-ui);
  font-size: var(--fs-400);
  font-weight: var(--fw-semibold);
  text-align: left;
  cursor: pointer;
}
.bar-title-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bar-title :deep(svg) {
  flex: none;
  color: var(--fg-muted);
}
</style>
