<script setup lang="ts">
// Platform-only settings registered through settingsSections.ts (Android
// dictation, update-install handoff, crash reporting…), rendered as ordinary
// groups after the shared ones.
import { computed } from 'vue';
import { settingsSections } from '../../settingsSections';

const sections = computed(() => settingsSections());
</script>

<template>
  <section
    v-for="section in sections"
    :id="`settings-section-${section.id}`"
    :key="section.id"
    class="group"
    :data-testid="`settings-section-${section.id}`"
  >
    <h3 class="group-title">{{ section.title }}</h3>
    <component :is="section.component" />
  </section>
</template>

<style scoped src="./settingsGroup.css"></style>
