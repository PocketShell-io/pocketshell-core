<script setup lang="ts">
// Settings → Diagnostics, shown only where the platform keeps local reports
// AND answers with a real report list (a catch-all transport double does not).
import { onMounted, ref } from 'vue';
import DiagnosticsPanel from '../DiagnosticsPanel.vue';
import { diagnosticsCapability, listDiagnosticReports } from '../../platformCapabilities';

const supported = ref(false);

onMounted(async () => {
  const group = diagnosticsCapability();
  if (!group) return;
  try {
    supported.value = (await listDiagnosticReports(group)) !== null;
  } catch {
    // A platform that fails its first list still gets the panel's own error.
    supported.value = true;
  }
});
</script>

<template>
  <section v-if="supported" class="group" data-testid="settings-group-diagnostics">
    <h3 class="group-title">Diagnostics</h3>
    <DiagnosticsPanel />
  </section>
</template>

<style scoped src="./settingsGroup.css"></style>
