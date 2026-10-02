<script setup lang="ts">
// The Settings tab strip. Settings is a tall stack of groups rendered inside
// OverlayPanel, whose body is the scroll container, so the strip sticks to the
// top of the body (full-bleed: the panels own the padding) and stays reachable
// while a long tab scrolls under it.
//
// ARIA tabs with roving tabindex: the selected tab is the only one in the Tab
 // order; Arrow keys (and Home/End) move BOTH selection and focus — automatic
// activation, the APG's recommended pattern for a panel whose content is
// already mounted, so no second keystroke is ever needed to see a tab.
import { ref } from 'vue';

const props = defineProps<{
  /** The tabs in display order; ids are stable slugs (`general`, `sessions`…). */
  tabs: readonly { id: string; label: string }[];
  /** The selected tab's id. */
  modelValue: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [id: string] }>();

/** Roving tabindex: the buttons, in display order, for focusing the neighbour. */
const tabEls = ref<(HTMLButtonElement | null)[]>([]);

function select(id: string): void {
  emit('update:modelValue', id);
}

function onKeydown(event: KeyboardEvent): void {
  const index = props.tabs.findIndex((tab) => tab.id === props.modelValue);
  let next: number;
  if (event.key === 'ArrowRight') next = (index + 1) % props.tabs.length;
  else if (event.key === 'ArrowLeft') next = (index - 1 + props.tabs.length) % props.tabs.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = props.tabs.length - 1;
  else return;
  event.preventDefault();
  select(props.tabs[next].id);
  tabEls.value[next]?.focus();
}
</script>

<template>
  <div class="strip" role="tablist" aria-label="Settings sections" @keydown="onKeydown">
    <button
      v-for="(tab, index) in tabs"
      :id="`settings-tab-${tab.id}`"
      :key="tab.id"
      :ref="(el) => (tabEls[index] = el as HTMLButtonElement | null)"
      class="tab"
      role="tab"
      type="button"
      :aria-selected="tab.id === modelValue"
      :aria-controls="`settings-panel-${tab.id}`"
      :tabindex="tab.id === modelValue ? 0 : -1"
      @click="select(tab.id)"
    >
      {{ tab.label }}
    </button>
  </div>
</template>

<style scoped>
/* Full-bleed and sticky: the scroller is OverlayPanel's body, the panels own
   the padding, and the hairline reads as the strip's own edge rather than a
   rule that happens to stop at the content inset. */
.strip {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: stretch;
  gap: var(--sp-1);
  padding: 0 var(--sp-3);
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
/* Ghost at rest like the rest of the app's chrome — the underline, not a
   box, is what marks the selected tab. */
.tab {
  height: var(--control-h);
  padding: 0 var(--sp-3);
  background: transparent;
  border: none;
  /* The 2px seat is always reserved so selection never shifts the strip. */
  border-bottom: 2px solid transparent;
  border-radius: 0;
  color: var(--fg-secondary);
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-medium);
  cursor: pointer;
  transition: color var(--dur-fast) var(--ease);
}
.tab:hover {
  color: var(--fg);
  background: var(--state-hover);
}
.tab[aria-selected='true'] {
  color: var(--fg);
  border-bottom-color: var(--accent);
}
</style>
