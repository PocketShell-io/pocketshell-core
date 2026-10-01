<script setup lang="ts">
// Settings → About: the installed build, where the platform reports one
// (api.app.info). Update checks keep their own group in SettingsView.
import { computed, onMounted, ref } from 'vue';
import type { InstalledAppInfo } from '../../api';
import { formatInstalledVersion, readInstalledAppInfo } from '../../platformCapabilities';

const info = ref<InstalledAppInfo | null>(null);
const version = computed(() => (info.value ? formatInstalledVersion(info.value) : null));

onMounted(async () => {
  info.value = await readInstalledAppInfo();
});
</script>

<template>
  <section v-if="version" class="group" data-testid="settings-group-about">
    <h3 class="group-title">About</h3>
    <div class="row">
      <div class="row-text">
        <span class="row-label">Installed version</span>
        <p class="row-hint">The build this device reports for PocketShell.</p>
      </div>
      <span class="control installed-version" data-testid="settings-installed-version">{{ version }}</span>
    </div>
  </section>
</template>

<style scoped src="./settingsGroup.css"></style>
<style scoped>
.installed-version {
  display: inline-flex;
  align-items: center;
  font-family: var(--font-mono);
}
</style>
