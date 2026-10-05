<script setup lang="ts">
// StopSessionDialog: the named confirmation the tab bar's `×`, the tab menu
// and Ctrl+F4 all arm. Extracted from FolderWorkspaceView.vue with its styles
// and its reasoning; the parent owns the state (the armed name, the busy
// latch) and the kill itself (useSessionStop's confirmStop) — this component
// is the question, not the execution.
import OverlayPanel from './OverlayPanel.vue';

defineProps<{
  /**
   * The session to stop, named verbatim — the same string the tab reads, so
   * what is being destroyed is spelled out in full and a tab called `main`
   * never leaves the user guessing which workspace's `main` it is. Null
   * renders nothing.
   */
  session: string | null;
  /** While the kill is in flight: Stop reads Stopping… and cannot be re-aimed. */
  busy: boolean;
}>();

const emit = defineEmits<{
  /** Escape, the backdrop and Cancel — every one of them costs exactly nothing. */
  close: [];
  /** The aimed click. Nothing is created until the parent's confirm fires. */
  confirm: [];
}>();
</script>

<template>
  <!-- It also says what goes, because "Stop" undersells it — a session is
       usually an agent mid-task, and its scrollback and process tree go with
       it. Escape and the backdrop cancel, and Cancel is the DEFAULT-looking
       button while Stop carries the error tint, so the dangerous half of the
       dialog is the half that has to be aimed at. -->
  <OverlayPanel v-if="session" title="Stop session" size="sm" @close="emit('close')">
    <div class="stop-confirm">
      <p>Stop <code>{{ session }}</code> ?</p>
      <p class="muted">
        This kills the session on the host. Anything running in it stops, its scrollback goes,
        and there is no undo.
      </p>
      <footer class="actions">
        <button class="btn-secondary" @click="emit('close')">Cancel</button>
        <button class="btn-danger" :disabled="busy" @click="emit('confirm')">
          {{ busy ? 'Stopping…' : 'Stop session' }}
        </button>
      </footer>
    </div>
  </OverlayPanel>
</template>

<style scoped>
.stop-confirm {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-4);
  font-size: var(--fs-300);
  line-height: var(--lh-300);
}
.stop-confirm p {
  margin: 0;
}
.stop-confirm code {
  font-family: var(--font-mono);
  word-break: break-all;
}
.stop-confirm .actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--border);
}
.stop-confirm .btn-secondary,
.stop-confirm .btn-danger {
  height: var(--control-h);
  display: inline-flex;
  align-items: center;
  padding: 0 var(--sp-4);
  border-radius: var(--r-md);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-semibold);
  transition: background var(--dur-fast) var(--ease);
}
.stop-confirm .btn-secondary {
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  color: var(--fg);
}
.stop-confirm .btn-secondary:hover {
  background: var(--state-hover);
}
/* Solid error, not a tinted ghost. This is the button that destroys the
   session, and a confirm dialog whose dangerous option is the quieter of the
   two is a trap. */
.stop-confirm .btn-danger {
  background: var(--error);
  border: 1px solid var(--error);
  color: var(--on-accent);
}
.stop-confirm .btn-danger:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
</style>
