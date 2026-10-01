<script setup lang="ts">
// Settings → Connections: how long a live connection rides through an app
// switch, and whether returning after that window reconnects by itself. Only
// rendered where the platform suspends in the background (Android); see
// platformCapabilities.backgroundGraceSupported.
import AppIcon from '@ui/components/AppIcon.vue';
import { BACKGROUND_GRACE_OPTIONS, parseBackgroundGraceMs } from '@pocketshell/core';
import { useSettingsStore } from '../../stores/settings';

withDefaults(defineProps<{
  /**
   * Show the group's own "Connections" title. A screen that already titles
   * itself Connections (the phone's Settings → Connections page) turns it off
   * so the page does not say the same word twice; the group stays labelled.
   */
  showTitle?: boolean;
}>(), { showTitle: true });

const settings = useSettingsStore();

function onGraceChange(event: Event): void {
  const parsed = parseBackgroundGraceMs((event.target as HTMLSelectElement).value);
  if (parsed !== undefined) settings.set('backgroundGraceMs', parsed);
}
</script>

<template>
  <section class="group" data-testid="settings-group-connections" :aria-label="showTitle ? undefined : 'Connections'">
    <h3 v-if="showTitle" class="group-title">Connections</h3>
    <div class="row">
      <div class="row-text">
        <label class="row-label" for="background-grace">Keep connection after leaving</label>
        <p class="row-hint">
          How long a live terminal stays connected while PocketShell is in the background.
          When it ends, the phone's connection closes; the remote session keeps running on
          the host.
        </p>
      </div>
      <select
        id="background-grace"
        class="control"
        data-testid="setting-background-grace"
        :value="settings.backgroundGraceMs"
        @change="onGraceChange"
      >
        <option v-for="option in BACKGROUND_GRACE_OPTIONS" :key="option.milliseconds" :value="option.milliseconds">
          {{ option.label }} · {{ option.detail }}
        </option>
      </select>
    </div>
    <div class="row">
      <div class="row-text">
        <span class="row-label">Reconnect when I return</span>
        <p class="row-hint">
          Reconnect and reopen the session automatically when PocketShell comes back after
          the connection closed. Off leaves it waiting for you to tap Reconnect.
        </p>
      </div>
      <button
        class="switch"
        role="switch"
        data-testid="setting-reconnect-on-return"
        :aria-checked="settings.reconnectOnReturn"
        :class="{ on: settings.reconnectOnReturn }"
        @click="settings.set('reconnectOnReturn', !settings.reconnectOnReturn)"
      >
        <AppIcon :name="settings.reconnectOnReturn ? 'toggle-right' : 'toggle-left'" />
        <span>{{ settings.reconnectOnReturn ? 'On' : 'Off' }}</span>
      </button>
    </div>
  </section>
</template>

<style scoped src="./settingsGroup.css"></style>
