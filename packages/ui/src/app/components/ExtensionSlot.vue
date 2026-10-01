<script setup lang="ts">
// Renders one component-carrying extension slot (app/extensions.ts). With no
// contributions it renders NOTHING — no wrapper element, no spacing — so a
// client that contributes nothing keeps the exact layout it had without the
// slot. With contributions, they sit in one wrapper the host view can place
// and style: `.ps-extension-slot` plus `data-extension-slot="<name>"`.
import { computed } from 'vue';
import { extensionsFor, type ComponentSlotName } from '../extensions';

const props = defineProps<{
  name: ComponentSlotName;
  /** Handed to every contributed component as its `context` prop. */
  context: unknown;
}>();

const entries = computed(() => extensionsFor(props.name));
</script>

<template>
  <div v-if="entries.length" class="ps-extension-slot" :data-extension-slot="name">
    <component :is="entry.component" v-for="entry in entries" :key="entry.id" :context="context" />
  </div>
</template>
