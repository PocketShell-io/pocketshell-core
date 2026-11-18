<script setup lang="ts">
// DiagBanner: the app-wide strip for unhandled renderer errors, mounted once
// in App.vue above the router outlet.
//
// Fixed, not in-flow, on purpose. Every view sizes itself to the root
// (`height: 100%`, inside the inset padding), so a strip that pushed content down would overflow the
// window by its own height and nudge a scrollbar into every screen it appeared
// on. An error report may overlay the top bar briefly; that is the honest
// cost of being visible everywhere without rearranging every screen for a
// state that is usually absent. Dismiss it and it is gone — the same text is
// in the desktop log (see renderer/diag.ts), so dismissing loses nothing.
//
// Compact layout (a phone, pocketshell#3161, D44): there is no desktop log to
// open, and `[terminal-stall] terminal output parsing stalled` means nothing
// to the person holding the phone. Each row says what happened in plain words
// and offers the raw record through "Copy details" for a bug report. The strip
// also clears the status bar there (`--ps-inset-top`, 0 on desktop). The
// expanded and medium layouts render exactly what they always did.
import { computed, ref } from 'vue';
import AppIcon from '@ui/components/AppIcon.vue';
import { diagErrors, dismissDiagError, type DiagEntry } from '../diag';
import { diagDetailsText, plainDiagSummary } from '../diagPresentation';
import { copyToClipboard } from '../terminalClipboard';
import { useLayoutClass } from '../layoutClass';

const layoutClass = useLayoutClass();
const compact = computed(() => layoutClass.value === 'compact');

/** The row whose details were just copied, so its button can say so. */
const copiedId = ref<number | null>(null);

async function copyDetails(entry: DiagEntry): Promise<void> {
  await copyToClipboard(diagDetailsText(entry));
  copiedId.value = entry.id;
}
</script>

<template>
  <div v-if="diagErrors.length && compact" class="diag-strip compact" role="alert">
    <div class="rows">
      <div v-for="entry in diagErrors" :key="entry.id" class="row plain" :data-diag-kind="entry.kind">
        <span class="message">{{ plainDiagSummary(entry.kind) }}</span>
        <button class="btn-ghost copy" @click="copyDetails(entry)">
          {{ copiedId === entry.id ? 'Copied' : 'Copy details' }}
        </button>
        <button class="icon-btn sm dismiss" title="Dismiss" aria-label="Dismiss" @click="dismissDiagError(entry.id)">
          <AppIcon name="close" :size="16" />
        </button>
      </div>
    </div>
  </div>
  <div v-else-if="diagErrors.length" class="diag-strip" role="alert">
    <div class="rows">
      <p v-for="entry in diagErrors" :key="entry.id" class="row" :title="entry.stack ?? entry.message">
        <span class="kind">[{{ entry.kind }}]</span>
        <span class="message">{{ entry.message }}</span>
        <button class="icon-btn sm dismiss" title="Dismiss" @click="dismissDiagError(entry.id)">
          <AppIcon name="close" :size="12" />
        </button>
      </p>
    </div>
  </div>
</template>

<style scoped>
.diag-strip {
  position: fixed;
  /* --ps-inset-top is 0 on desktop and web, so this is var(--sp-2) there. */
  top: calc(var(--ps-inset-top) + var(--sp-2));
  left: 50%;
  transform: translateX(-50%);
  z-index: 50; /* overlays, including overlays: an error report outranks them */
  width: min(640px, calc(100vw - var(--sp-6)));
  background: var(--surface-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-overlay);
  overflow: hidden;
}
.rows {
  display: flex;
  flex-direction: column;
}
.row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: 0;
  padding: var(--sp-1) var(--sp-2);
  font-size: var(--fs-200);
  line-height: var(--lh-200);
  color: var(--error);
}
.row + .row {
  border-top: 1px solid var(--border-soft);
}
.kind {
  flex: none;
  font-family: var(--font-mono);
  font-size: var(--fs-100);
  color: var(--fg-secondary);
}
/* The message takes the slack and truncates; the stack — the real content —
   is the row's title, one hover away, and always whole in the desktop log. */
.message {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dismiss {
  flex: none;
}
/* Compact rows: a plain sentence that wraps instead of truncating, then the
   actions. The colour is the ordinary foreground — the strip itself says
   something went wrong; red text only made it harder to read. */
.row.plain {
  color: var(--fg);
  font-size: var(--fs-300);
}
.row.plain .message {
  white-space: normal;
}
.copy {
  flex: none;
  color: var(--accent);
}
</style>
