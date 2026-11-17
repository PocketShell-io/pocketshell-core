<script setup lang="ts">
// CompactSheet: a bottom sheet for the compact (phone) layout — a scrim, a
// surface docked to the bottom edge, and whatever rows the caller slots in.
//
// It exists for the compact chrome's two menus (the host overflow and the
// folder switcher): on a phone a menu hung off a 28px anchor is a target
// practice, while a bottom sheet is thumb-reachable and its rows can be 48px.
// Teleported to `<body>` like PopupMenu, for the same clipping reason. It is a
// dismiss layer (extensions.ts `app.dismissLayers`), so Android Back closes it
// before it navigates, and so do the scrim and Escape.
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useDismissLayer } from '../extensions';

defineProps<{ label: string }>();
const emit = defineEmits<{ close: [] }>();

useDismissLayer(() => emit('close'));

const sheetEl = ref<HTMLElement | null>(null);

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close');
}
onMounted(() => {
  document.addEventListener('keydown', onKeydown);
  sheetEl.value?.focus();
});
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown));
</script>

<template>
  <Teleport to="body">
    <div class="compact-sheet-scrim" @click.self="emit('close')">
      <div
        ref="sheetEl"
        class="compact-sheet"
        role="dialog"
        aria-modal="true"
        :aria-label="label"
        tabindex="-1"
      >
        <slot />
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.compact-sheet-scrim {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: flex-end;
  background: var(--scrim);
  /* Above the composer dock and PopupMenu (60), like any modal layer. */
  z-index: 70;
}
.compact-sheet {
  width: 100%;
  max-height: 70vh;
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-bottom: none;
  border-radius: var(--r-xl) var(--r-xl) 0 0;
  box-shadow: var(--shadow-overlay);
  /* The sheet sits at the physical bottom edge, under the navigation bar the
     body padding keeps everything else out of. */
  padding: var(--sp-2) 0 calc(var(--sp-2) + var(--ps-inset-bottom));
  margin-bottom: var(--ps-inset-keyboard);
}
.compact-sheet:focus-visible {
  outline: none;
}
/* The row vocabulary both sheets share. `:deep` because the rows arrive
   through the slot and carry the caller's scope id, not this one's. */
.compact-sheet :deep(ul) {
  list-style: none;
  margin: 0;
  padding: 0;
}
.compact-sheet :deep(.sheet-row) {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  min-height: 48px;
  padding: 0 var(--sp-4);
  background: transparent;
  border: none;
  color: var(--fg);
  font-family: var(--font-ui);
  font-size: var(--fs-400);
  text-align: left;
  cursor: pointer;
}
.compact-sheet :deep(.sheet-row:active) {
  background: var(--state-hover);
}
.compact-sheet :deep(.sheet-row.danger) {
  color: var(--error);
}
.compact-sheet :deep(.sheet-head) {
  padding: var(--sp-2) var(--sp-4);
  color: var(--fg-muted);
  font-size: var(--fs-200);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.compact-sheet :deep(.sheet-sep) {
  height: 1px;
  margin: var(--sp-1) 0;
  background: var(--border);
}
</style>
