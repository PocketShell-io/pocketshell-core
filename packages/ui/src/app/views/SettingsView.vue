<script setup lang="ts">
// Settings: the renderer preferences screen, ordered into tabs.
// Account & sync is intentionally a separate window (views/AccountView.vue),
// so this overlay stays focused on local application preferences.
//
// WHERE THIS LIVES, AND WHY IT IS AN OVERLAY
//
// Ports and Usage are overlays because they are HOST-level and belong to the
// workspace header. Settings are mostly app-level, so on the face of it they belong
// somewhere else entirely — a route. They are still an overlay, for two
// reasons that both come out of this app's structure rather than out of taste:
//
//   - A route would unmount the workspace. `/settings` as a top-level route
//     replaces HostWorkspaceView, which owns the terminal; leaving the screen
//     to flip a switch would tear down xterm and take the user's scrollback
//     with it. That is a real cost the Ports overlay was already avoiding.
//   - It has to be reachable with no connection. `defaultHost` is a decision
//     about STARTUP, so the host picker is precisely where a user goes looking
//     for it. An overlay is the only host-agnostic surface this app has. The
//     same component, opened from the picker's header and from the workspace's;
//     over whatever is behind it.
//     The project-root section is the host-scoped exception: from the picker
//     it asks for an explicit host, while a workspace supplies its connected
//     host automatically.
//
// So: one view, mounted inside `OverlayPanel` by two callers. It renders no
// heading of its own — the overlay chrome owns the title (see UsageView's
// `embedded` prop and the duplicated-heading note in OverlayPanel).
//
// THE TABS
//
// One scroll of every group became five tabs — General, Sessions, Appearance,
// Keyboard, Advanced — because the stack had grown past what a single sheet
// could hold as one glanceable list: the keyboard registry alone is a page.
// The strip (SettingsTabs) sticks to the top of the overlay body; the panels
// are `v-show`, not `v-if`, so every group stays MOUNTED across tab switches —
// drafts in the roots editor and the shortcut capture survive a round trip,
// the platform groups keep their own mount-time capability probes, and the
// whole settings DOM stays in document order for anything that queries it
// (tests do; `settings.sections` slots render inside the Advanced panel).
// Groups live in components/settings/*Group.vue; this view keeps the shell
// and the two small General/Appearance groups that need no component of
// their own.
import { computed, onMounted, ref } from 'vue';
import { useConnectionStore } from '../stores/connection';
import { useHostsStore } from '../stores/hosts';
import { useSettingsStore } from '../stores/settings';
import { api } from '../ipc';
import { defaultHostStatus } from '../autoConnect';
import { hostEntryId } from '@pocketshell/core';
import { THEME_CHOICE_SYSTEM, THEMES } from '@ui/themes';
import {
  formatZoomPercent,
  ZOOM_PERCENT_DEFAULT,
  ZOOM_PERCENT_MAX,
  ZOOM_PERCENT_MIN,
} from '../zoom';
import ShortcutSettings from '../components/ShortcutSettings.vue';
import SettingsTabs from '../components/settings/SettingsTabs.vue';
import SettingsSessionsGroup from '../components/settings/SettingsSessionsGroup.vue';
import SettingsMonospaceGroup from '../components/settings/SettingsMonospaceGroup.vue';
import SettingsPlatformGroups from '../components/settings/SettingsPlatformGroups.vue';
import SettingsUpdatesGroup from '../components/settings/SettingsUpdatesGroup.vue';
// Used by the default-host notice; it was referenced without an import once,
// and those buttons rendered empty.
import AppIcon from '@ui/components/AppIcon.vue';

const connection = useConnectionStore();
const settings = useSettingsStore();
const hostList = useHostsStore();

/** The five tabs, in reading order; Advanced carries the platform groups. */
const TABS = [
  { id: 'general', label: 'General' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'keyboard', label: 'Keyboard' },
  { id: 'advanced', label: 'Advanced' },
] as const;
// Session-local, deliberately not a stored setting: the panel always opens on
// General, so a preference touched last year cannot hijack the next visit.
const activeTab = ref<string>('general');

onMounted(async () => {
  // The picker loads hosts on its own mount, but the workspace does not
  // re-read the config, and this panel opens over both. `listConfigHosts()` is
  // the single source for the default-host choices, so ask for it when the
  // list is empty rather than rendering an empty select. (The sessions group
  // runs the same guarded load for its root-host select; one of the two fills
  // the store, the other's guard sees it and skips.)
  if (!connection.hosts.length) await connection.loadHosts();
});

/**
 * A stored default naming a host that is no longer in ~/.ssh/config. The value
 * is deliberately still shown as selected and still stored — the user set it,
 * and silently dropping it would hide the fact that their config changed.
 */
const defaultMissing = computed(
  () => defaultHostStatus(hostList.defaultHostKey, connection.hosts) === 'missing',
);

function onDefaultHostChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  // '' is the "no default" option. The value is the host's identity, written
  // to whichever store owns the default on this platform.
  // A rejected write leaves the owning store's value as it was, and the
  // select re-renders from that value, so the control snaps back on its own.
  void hostList.setDefaultHost(value === '' ? null : value).catch(() => undefined);
}

/* --- Theme ---------------------------------------------------------------
 * The options are read off the THEMES registry, so this control never needs
 * touching when a theme is added: one record in themes.ts and it is listed.
 * `system` is not a theme and is offered separately, first, because it is a
 * different KIND of answer — a rule, not a palette.
 * ---------------------------------------------------------------------- */

function onThemeChange(event: Event): void {
  settings.set('theme', (event.target as HTMLSelectElement).value);
}

/* --- Zoom ----------------------------------------------------------------
 * The stepper writes through the SAME store actions the Ctrl+= / Ctrl+- /
 * Ctrl+0 chords land on (App.vue subscribes; main forwards the intent). There
 * is no local number here on purpose: a copy would be a second source of truth
 * and would go stale the first time the user used the keyboard instead of the
 * mouse, which is precisely the failure this control exists to avoid.
 * ---------------------------------------------------------------------- */

const zoomLabel = computed(() => formatZoomPercent(settings.zoomPercent));
const atMinZoom = computed(() => settings.zoomPercent <= ZOOM_PERCENT_MIN);
const atMaxZoom = computed(() => settings.zoomPercent >= ZOOM_PERCENT_MAX);
const atDefaultZoom = computed(() => settings.zoomPercent === ZOOM_PERCENT_DEFAULT);

/* --- Keyboard ------------------------------------------------------------
 * The whole group — the list, the capture editor, and the refused-keys
 * ledger — is components/ShortcutSettings.vue, with its reasoning. The parent
 * keeps the group chrome, like every other section here.
 * ---------------------------------------------------------------------- */
</script>

<template>
  <div class="settings">
    <SettingsTabs v-model="activeTab" :tabs="TABS" />

    <!-- General: how the app starts and how the composer behaves. -->
    <div
      v-show="activeTab === 'general'"
      id="settings-panel-general"
      class="tab-panel"
      role="tabpanel"
      aria-labelledby="settings-tab-general"
    >
      <section class="group">
        <h3 class="group-title">Startup</h3>
        <div class="row">
          <div class="row-text">
            <label class="row-label" for="default-host">Default host</label>
            <p class="row-hint">
              Connect to this host as soon as PocketShell starts and go straight to its
              sessions. Choose <em>Always show the host list</em> to keep the picker.
            </p>
          </div>
          <select
            id="default-host"
            class="control"
            :value="hostList.defaultHostKey ?? ''"
            @change="onDefaultHostChange"
          >
            <option value="">Always show the host list</option>
            <!-- The stale value keeps its own option so the select can still
                 display it; without this the control would silently snap to
                 "always show", which is not what is stored. -->
            <option v-if="defaultMissing" :value="hostList.defaultHostKey ?? ''">
              {{ hostList.defaultHostKey }} (not in ~/.ssh/config)
            </option>
            <option v-for="host in connection.hosts" :key="hostEntryId(host)" :value="hostEntryId(host)">
              {{ host.name }}
            </option>
          </select>
        </div>
        <p v-if="defaultMissing" class="notice">
          <AppIcon name="alert-triangle" :size="14" />
          <span>
            <strong>{{ hostList.defaultHostKey }}</strong> is not in <code>~/.ssh/config</code> any
            more, so PocketShell starts on the host list until you pick a new default.
          </span>
        </p>
      </section>

      <section class="group">
        <h3 class="group-title">Prompt composer</h3>

        <div class="row">
          <div class="row-text">
            <span class="row-label">Typing opens the composer</span>
            <p class="row-hint">
              Typing in the terminal opens the prompt composer and the keystrokes go into
              it, instead of straight to the shell.
            </p>
          </div>
          <button
            class="switch"
            role="switch"
            :aria-checked="settings.typingOpensComposer"
            :class="{ on: settings.typingOpensComposer }"
            @click="settings.set('typingOpensComposer', !settings.typingOpensComposer)"
          >
            <AppIcon :name="settings.typingOpensComposer ? 'toggle-right' : 'toggle-left'" />
            <span>{{ settings.typingOpensComposer ? 'On' : 'Off' }}</span>
          </button>
        </div>

        <div class="row">
          <div class="row-text">
            <span class="row-label">Close the composer after sending</span>
            <p class="row-hint">
              The composer closes itself once a message is sent, and reopens the next time
              you type.
            </p>
          </div>
          <button
            class="switch"
            role="switch"
            :aria-checked="settings.closeComposerOnSend"
            :class="{ on: settings.closeComposerOnSend }"
            @click="settings.set('closeComposerOnSend', !settings.closeComposerOnSend)"
          >
            <AppIcon :name="settings.closeComposerOnSend ? 'toggle-right' : 'toggle-left'" />
            <span>{{ settings.closeComposerOnSend ? 'On' : 'Off' }}</span>
          </button>
        </div>
      </section>
    </div>

    <!-- Sessions: the session tree's shape — its project roots and folder sort. -->
    <div
      v-show="activeTab === 'sessions'"
      id="settings-panel-sessions"
      class="tab-panel"
      role="tabpanel"
      aria-labelledby="settings-tab-sessions"
    >
      <SettingsSessionsGroup />
    </div>

    <!-- Appearance: the palette and the type — theme, zoom, the mono face. -->
    <div
      v-show="activeTab === 'appearance'"
      id="settings-panel-appearance"
      class="tab-panel"
      role="tabpanel"
      aria-labelledby="settings-tab-appearance"
    >
      <section class="group">
        <h3 class="group-title">Display</h3>

        <div class="row">
          <div class="row-text">
            <label class="row-label" for="theme-choice">Theme</label>
            <p class="row-hint">
              Colours for the whole app — panels, terminal and file editor together, so
              they always read as one surface. <em>Follow Windows</em> switches between
              Dark and Light with the system's own light and dark mode, live.
            </p>
          </div>
          <select
            id="theme-choice"
            class="control"
            :value="settings.theme"
            @change="onThemeChange"
          >
            <option :value="THEME_CHOICE_SYSTEM">Follow Windows</option>
            <option v-for="theme in THEMES" :key="theme.id" :value="theme.id">
              {{ theme.label }}
            </option>
          </select>
        </div>

        <div class="row">
          <div class="row-text">
            <span id="zoom-label" class="row-label">App zoom</span>
            <p class="row-hint">
              Scales the whole window at once — panels, tabs, the composer and the terminal
              together — the way a browser's zoom does. <kbd>Ctrl</kbd> with
              <kbd>+</kbd>, <kbd>-</kbd> or <kbd>0</kbd> moves this same setting, so the
              number here is always what the window is actually at. To change only the
              terminal's text, leave this at 100% and use <em>Terminal text size</em> below.
            </p>
          </div>
          <!-- A stepper, not a number field: zoom moves along a fixed ladder
               (see zoom.ts) so that in-then-out returns to exactly where you
               started, and a free-text percentage would invite values that are
               not on it. The reset sits in the same group as the thing it
               undoes, and is disabled at 100% so it also reads as a state. -->
          <div class="stepper" role="group" aria-labelledby="zoom-label">
            <button
              class="icon-btn"
              :disabled="atMinZoom"
              aria-label="Zoom out"
              title="Zoom out (Ctrl+-)"
              @click="settings.zoomOut()"
            >
              <AppIcon name="minus" :size="14" />
            </button>
            <span class="stepper-value" aria-live="polite">{{ zoomLabel }}</span>
            <button
              class="icon-btn"
              :disabled="atMaxZoom"
              aria-label="Zoom in"
              title="Zoom in (Ctrl+=)"
              @click="settings.zoomIn()"
            >
              <AppIcon name="plus" :size="14" />
            </button>
            <button
              class="icon-btn"
              :disabled="atDefaultZoom"
              aria-label="Reset zoom to 100%"
              title="Reset to 100% (Ctrl+0)"
              @click="settings.resetZoom()"
            >
              <AppIcon name="rotate-ccw" :size="14" />
            </button>
          </div>
        </div>
      </section>

      <SettingsMonospaceGroup />
    </div>

    <!-- Keyboard: the whole group — list, capture, refused keys — is
         components/ShortcutSettings.vue; the reasoning lives there. -->
    <div
      v-show="activeTab === 'keyboard'"
      id="settings-panel-keyboard"
      class="tab-panel"
      role="tabpanel"
      aria-labelledby="settings-tab-keyboard"
    >
      <section class="group">
        <h3 class="group-title">Keyboard</h3>
        <ShortcutSettings />
      </section>
    </div>

    <!-- Advanced: the tuning dials, the platform's own groups and sections,
         diagnostics, about, and the update check. -->
    <div
      v-show="activeTab === 'advanced'"
      id="settings-panel-advanced"
      class="tab-panel"
      role="tabpanel"
      aria-labelledby="settings-tab-advanced"
    >
      <SettingsPlatformGroups />
      <SettingsUpdatesGroup />
    </div>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
/* Each tab's groups; the strip above is full-bleed, so the panels own the
   content inset. `1 1 auto` mirrors OverlayPanel's body child rule. */
.tab-panel {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
  padding: var(--sp-4);
}
.group {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
/* The section header metric from the session panel: small, uppercase, tracked.
   It is the app's existing "this is a group of things" mark. */
.group-title {
  margin: 0;
  font-size: var(--fs-100);
  line-height: var(--lh-100);
  font-weight: var(--fw-semibold);
  color: var(--fg-muted);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
/* Label left, control right, hairline between rows — the shape every settings
   list in every desktop app has, so nothing here needs to be learned. */
.row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-4);
  padding: var(--sp-3) 0;
  border-bottom: 1px solid var(--border-soft);
}
.row:last-child {
  border-bottom: none;
}
.row-text {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  min-width: 0;
}
.row-label {
  font-size: var(--fs-300);
  font-weight: var(--fw-medium);
  color: var(--fg);
}
/* --fg-secondary, not --fg-muted: this is real information at 12px, and
   --fg-muted is 4.12:1; restrict it to >=15px. */
.row-hint {
  margin: 0;
  max-width: 46ch;
  font-size: var(--fs-200);
  line-height: var(--lh-200);
  color: var(--fg-secondary);
}
.control {
  flex: none;
  height: var(--control-h);
  background: var(--surface-2);
  /* WCAG 1.4.11: a control's boundary needs >=3:1; --border is 1.49:1. */
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  color: var(--fg);
  padding: 0 var(--sp-2);
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  max-width: 16rem;
}
/* A labelled two-state control, not a bordered box: the mark itself changes
   shape (toggle-left/toggle-right), so on and off differ without relying on
   the tint. Ghost at rest like the rest of the app's chrome. */
.switch {
  flex: none;
  height: var(--control-h);
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 var(--sp-2);
  background: transparent;
  border: none;
  border-radius: var(--r-md);
  color: var(--fg-secondary);
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-medium);
  line-height: 1;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.switch.on {
  color: var(--accent);
}
.switch:hover {
  background: var(--state-hover);
}
/* The zoom stepper: minus / value / plus / reset, in one bordered group so the
   four controls read as one instrument rather than four loose buttons. */
.stepper {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  padding: 0 var(--sp-1);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
}
/* Tabular figures and a fixed width so stepping 90% -> 100% -> 110% does not
   shuffle the buttons either side of it. */
.stepper-value {
  min-width: 4.5ch;
  text-align: center;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-medium);
  font-variant-numeric: tabular-nums;
  color: var(--fg);
}
/* The default-host notice: a stale stored default named in the error register. */
.notice {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  color: var(--error);
  background: var(--error-soft);
  font-size: var(--fs-200);
  line-height: var(--lh-200);
  overflow-wrap: anywhere;
}
code {
  font-family: var(--font-mono);
  font-size: 0.9em;
}
</style>
