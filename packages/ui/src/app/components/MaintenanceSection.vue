<script setup lang="ts">
// MaintenanceSection: the session panel's pinned door back to the tool
// workspaces (docs/MONITOR.md) — one row per open tool, like the tabs they
// are. Extracted from SessionTreeRowsView.vue with its styles: the section is
// the app's own chrome rather than the host's grouping, and keeping it in one
// component is what makes that difference legible — the roots around it are
// the host's data, this is not.
//
// Presentational like its parent: tools in, events out. The click emits the
// SAME `select` the folder rows do (the workspace directory, the tool's
// identity as the tab hand-off), so navigation, re-click focus and the
// current tint are the folder rows' own machinery; the × emits `closeTool`
// with the tool's kind, and closing the last one retires the section — the
// user saying "I don't have it".
import AppIcon from '@ui/components/AppIcon.vue';
import { MAINTENANCE_ROOT, maintenanceDirectory } from '../maintenance';

defineProps<{
  /** The host's open maintenance tools, in open order — one row each. */
  tools: readonly { kind: string; identity: string }[];
  /** Key of the folder whose workspace is open, for the current-row tint. */
  activeFolder?: string | null;
}>();

const emit = defineEmits<{
  /** The folder rows' own select, with the tool's identity as the tab hand-off. */
  select: [folder: ReturnType<typeof maintenanceDirectory>, session: string];
  /** A row's ×: the kind names the tool to close (maintenance.ts disposes). */
  closeTool: [kind: string];
}>();
</script>

<template>
  <section class="folder maintenance-section" aria-label="Maintenance">
    <div class="folder-header">
      <span class="dot" />
      <span class="folder-label">Maintenance</span>
    </div>
    <ul class="dir-list">
      <li v-for="tool in tools" :key="tool.identity">
        <button
          class="dir-header maintenance-row"
          :class="{ current: activeFolder === MAINTENANCE_ROOT }"
          :title="
            tool.kind === 'htop'
              ? 'Host monitor — htop in ~. Quitting htop leaves a shell in ~.'
              : tool.kind
          "
          @click="emit('select', maintenanceDirectory(), tool.identity)"
        >
          <AppIcon name="activity" :size="12" class="maintenance-glyph" />
          <span class="label">{{ tool.kind }}</span>
          <span
            class="maintenance-close"
            title="Close this tool"
            role="button"
            aria-label="Close this tool"
            @click.stop="emit('closeTool', tool.kind)"
            @dblclick.stop
          >
            <AppIcon name="close" :size="12" />
          </span>
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
/* The section's row leads with the activity glyph instead of the attachment
   dot: nothing in that workspace can be attached, and the pulse is the
   register the Host monitor button wears (AppIcon.vue). */
.maintenance-glyph {
  flex-shrink: 0;
  color: var(--fg-muted);
}
/* The tool's × sits at the row's right end, on hover like every other
   `tab-close` register in the app: visible enough to be found, quiet enough
   to leave the row's label the loudest thing on it. */
.maintenance-close {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  color: var(--fg-muted);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease);
}
.maintenance-row:hover .maintenance-close,
.maintenance-close:focus-visible {
  opacity: 1;
}
</style>
