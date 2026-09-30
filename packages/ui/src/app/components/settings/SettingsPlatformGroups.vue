<script setup lang="ts">
// The Settings groups carried over from the 0.5.x phone app — Connections,
// Advanced, platform-registered sections, Diagnostics and About — kept out of
// SettingsView so it stays under the component size gate. Connections only
// changes behaviour where the platform suspends in the background, probed
// defensively because a transport double may omit or fake `api.app`.
import SettingsConnectionsGroup from './SettingsConnectionsGroup.vue';
import SettingsAdvancedGroup from './SettingsAdvancedGroup.vue';
import SettingsPlatformSections from './SettingsPlatformSections.vue';
import SettingsDiagnosticsGroup from './SettingsDiagnosticsGroup.vue';
import SettingsAboutGroup from './SettingsAboutGroup.vue';
import { backgroundGraceSupported } from '../../platformCapabilities';

const lifecycleSupported = backgroundGraceSupported();
</script>

<template>
  <SettingsConnectionsGroup v-if="lifecycleSupported" />
  <SettingsAdvancedGroup />
  <SettingsPlatformSections />
  <SettingsDiagnosticsGroup />
  <SettingsAboutGroup />
</template>
