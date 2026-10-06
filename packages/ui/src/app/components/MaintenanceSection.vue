<script setup lang="ts">
// MaintenanceSection: the session panel's pinned door to the tool workspaces
// (docs/MONITOR.md) — ONE row, not a row per tool. The tools are the
// workspace's tabs (closable there, at the tab bar's ×), so a second list of
// them here said everything twice; the row says only that the workspace
// exists, and the count says how much is in it — the root headers' own
// notation for "what's inside". Extracted from SessionTreeRowsView.vue with
// its styles: the section is the app's own chrome rather than the host's
// grouping, and keeping it in one component is what makes that difference
// legible — the roots around it are the host's data, this is not.
//
// Presentational like its parent: a count in, one event out. The click emits
// the SAME `select` the folder rows do (the workspace directory, no tab
// hand-off — which tab lands in front is the workspace's own memory), so
// navigation, re-click focus and the current tint are the folder rows' own
// machinery.
import AppIcon from '@ui/components/AppIcon.vue';
import { MAINTENANCE_ROOT, maintenanceDirectory } from '../maintenance';

defineProps<{
  /** How many tools the host has open — the row's count, and nothing else. */
  count: number;
  /** Key of the folder whose workspace is open, for the current-row tint. */
  activeFolder?: string | null;
}>();

const emit = defineEmits<{
  /** The folder rows' own select, with the workspace directory. */
  select: [folder: ReturnType<typeof maintenanceDirectory>];
}>();
</script>

<template>
  <section class="folder maintenance-section" aria-label="Maintenance">
    <button
      class="dir-header maintenance-row"
      :class="{ current: activeFolder === MAINTENANCE_ROOT }"
      title="Maintenance tools — usage, ports, host monitor"
      @click="emit('select', maintenanceDirectory())"
    >
      <!-- The wrench, not a per-tool glyph: the row names the WORKSPACE, and
           the tabs inside it wear the tools' own marks. Muted, like every
           glyph the panel leads a row with. -->
      <AppIcon name="tool" :size="12" class="maintenance-glyph" />
      <span class="label">Maintenance</span>
      <span v-if="count > 0" class="count">{{ count }}</span>
    </button>
  </section>
</template>

<style scoped>
/* CARRIED from SessionTreeRowsView.vue's stylesheet, and it must move with
   it: scoped styles do not cross the component boundary (the reason that
   file's own header gives for carrying its rules beside its rows), so this
   component's row would render as a bare default button without its own
   copy. The custom properties (--row-h, --row-pad-x, --sp-*, colour and
   state tokens) are global (src/tokens.css) and need no carrying. When a row
   rule changes THERE, change it here — the section must read as the same
   tree it sits beside. */
.folder {
  margin-bottom: var(--sp-1);
}
/* The row sits at the ROOT headers' indent (--sp-3), not the folder rows'
   18px: it is chrome beside the roots, not a folder under one — the same
   register the section's header wore when it was a header. */
.dir-header {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  height: var(--row-h);
  background: transparent;
  border: none;
  border-left: 2px solid transparent;
  color: var(--fg);
  text-align: left;
  padding: 0 var(--row-pad-x) 0 var(--sp-3);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  line-height: var(--lh-300);
  font-weight: var(--fw-semibold);
  overflow: hidden;
}
.dir-header:hover {
  background: var(--state-hover);
}
/* Selection is accent-tinted and railed, the folder rows' own rule. */
.dir-header.current {
  background: var(--state-selected);
  border-left-color: var(--accent);
}
.label {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg);
}
/* The workspace's open-tool count, the root headers' `.folder-count` at the
   shared metric: bare digit, muted weight, beside the label it counts. */
.count {
  flex: none;
  font-weight: var(--fw-regular);
  font-size: var(--fs-100);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  color: var(--fg-secondary);
}
/* The row leads with the wrench instead of the attachment dot: nothing in
   that workspace can be attached, and the tools' own glyphs live on the tabs
   inside it — the row's mark names the place, not a tool. */
.maintenance-glyph {
  flex-shrink: 0;
  color: var(--fg-muted);
}
</style>
