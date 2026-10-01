<script setup lang="ts">
// Platform-only settings (Android dictation, update-install handoff, crash
// reporting…), contributed through the `settings.sections` extension slot
// (../../extensions.ts) and rendered as ordinary groups after the shared ones.
// Nothing contributed renders nothing.
import { computed } from 'vue';
import { extensionsFor } from '../../extensions';

const sections = computed(() => extensionsFor('settings.sections'));
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
