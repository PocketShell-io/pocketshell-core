<script setup lang="ts">
// AppRoot: the shared app's root component, mounted by every client.
//
// It is the router outlet plus the one place the app's appearance settings
// become pixels: the theme's tokens and the three typography settings are
// written onto <html> as inline custom properties, which outrank the no-JS
// defaults in @ui/styles.css and stay visible in devtools. Everything that
// paints from the cascade — which is everything except xterm (TerminalView
// assigns its theme and font from the same records) — repaints on the next
// frame, no restart, no remount. Desktop, web and Android each used to carry
// a copy of these watchers; this is now the only one.
//
// What stays with a client is what only that client has: the desktop's frame
// zoom and its account window, the web's navigation guard, a phone's inset
// writer and back gesture. A client wraps or mounts this component and adds
// those around it; nothing here asks which platform it is on.
import { onBeforeUnmount, onMounted, watchEffect } from 'vue';
import { fontCssVariables } from '@ui/fonts';
import { resolveTheme } from '@ui/themes';
import { isShortcut } from '@pocketshell/core/shared/shortcuts';
import { deleteWordBackward } from '@pocketshell/core/shared/deleteWord';
import { useUpdateStore } from './stores/update';
import { useSettingsStore } from './stores/settings';
import DiagBanner from './components/DiagBanner.vue';
import UpdateBanner from './components/UpdateBanner.vue';
import HostKeyTrustGate from './components/HostKeyTrustGate.vue';

const props = withDefaults(
  defineProps<{
    /**
     * The mono font stack a user's chosen family falls back to. The shared
     * default is the desktop's (Consolas first); a client whose fonts differ
     * passes its own.
     */
    monoFallback?: string;
    /**
     * Whether the app claims the `text.deleteWordBackward` chord (Ctrl+W) in
     * its own text fields. False where a native menu already holds that chord
     * and would run its own command as well (the desktop on macOS).
     */
    claimDeleteWord?: boolean;
  }>(),
  { monoFallback: undefined, claimDeleteWord: true },
);

const settings = useSettingsStore();
const updates = useUpdateStore();

/**
 * Readline's `Ctrl+W` (`unix-word-rubout`) in the app's own text fields, with
 * the shell's semantics (core shared/deleteWord.ts): kill the selection, else
 * back through the nearest whitespace. `.xterm` inputs are NOT text fields
 * here — xterm's sink is a <textarea>, and swallowing its keys would eat `\x17`
 * out of the shell. Applied through the native edit path so the undo stack
 * hears the deletion and Vue's `v-model` listeners fire as for any edit.
 */
function onDeleteWordBackward(e: KeyboardEvent): void {
  if (!isShortcut(settings.shortcutBindings, 'text.deleteWordBackward', e)) return;
  const target = e.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
  if (target.disabled || target.readOnly) return;
  if (target.closest('.xterm')) return;
  const { selectionStart, selectionEnd, value } = target;
  if (selectionStart === null || selectionEnd === null) return;

  const result = deleteWordBackward(value, selectionStart, selectionEnd);
  const changed = result.value !== value;
  e.preventDefault();
  e.stopPropagation();
  if (!changed) return;

  try {
    target.setSelectionRange(result.caret, selectionEnd);
    if (!document.execCommand('delete')) throw new Error('unsupported');
  } catch {
    // jsdom, or an engine without the editing API. setRangeText performs the
    // same splice; it fires no input event, so one is dispatched by hand to
    // keep every framework listener honest.
    target.setRangeText('', result.caret, selectionEnd, 'end');
    target.setSelectionRange(result.caret, result.caret);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

/**
 * The ONE place a theme becomes pixels. `resolveTheme` is reactive on both
 * inputs — the stored choice and (for `system`) the OS preference — so
 * flipping the OS light/dark mode restyles a running app. `data-theme` is
 * stamped for devtools and tests, not for CSS to branch on.
 */
watchEffect(() => {
  const theme = resolveTheme(settings.theme);
  const el = document.documentElement;
  el.dataset['theme'] = theme.id;
  el.style.colorScheme = theme.appearance;
  for (const [name, value] of Object.entries(theme.tokens)) {
    el.style.setProperty(name, value);
  }
});

watchEffect(() => {
  const vars = fontCssVariables(
    {
      monospaceFontFamily: settings.monospaceFontFamily,
      terminalFontSize: settings.terminalFontSize,
      editorFontSize: settings.editorFontSize,
    },
    props.monoFallback,
  );
  for (const [name, value] of Object.entries(vars)) {
    document.documentElement.style.setProperty(name, value);
  }
});

onMounted(() => {
  // One update check per launch; a client without the `update` group has
  // none to run (the store returns at once).
  void updates.check();
  if (props.claimDeleteWord) window.addEventListener('keydown', onDeleteWordBackward, true);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onDeleteWordBackward, true);
});
</script>

<template>
  <!-- The app-wide surfaces: unhandled renderer errors (so a component that
       dies mid-render reports itself instead of leaving a blank screen) and
       an available update. Then the client's content — the router outlet
       unless the client passes something else (the desktop's account
       window). Last, the host-key question (#2953), over everything; it
       renders nothing on a client without `ssh.onTrustDecision`. -->
  <DiagBanner />
  <UpdateBanner />
  <slot>
    <RouterView />
  </slot>
  <HostKeyTrustGate />
</template>

<style>
* {
  box-sizing: border-box;
}
html,
body,
#app {
  height: 100%;
  margin: 0;
}
body {
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  line-height: var(--lh-300);
  /* CSS equivalent of Windows Terminal's "antialiasingMode": "grayscale", so
     the UI and the terminal it frames are rasterised the same way. */
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  /* The inset contract (app/insets.ts): 0 on desktop and web, the platform's
     bars and keyboard where its chrome draws over the page. */
  padding: var(--ps-inset-top) var(--ps-inset-right) calc(var(--ps-inset-bottom) + var(--ps-inset-keyboard))
    var(--ps-inset-left);
}

/* Numbers must not jitter between rows: timestamps, ports, percentages. */
.session-time,
.fwd-table,
.meter-pct,
.sz,
.host-detail,
.folder-count {
  font-variant-numeric: tabular-nums;
}

/* Rows live inside `overflow-y: auto` lists, which clip a +2px offset ring.
   Inset it instead. */
:where(.session-row, .entry, .folder-header):focus-visible {
  outline-offset: -2px;
}
</style>
