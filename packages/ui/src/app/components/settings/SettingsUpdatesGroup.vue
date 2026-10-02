<script setup lang="ts">
// Settings → Updates: the once-per-launch GitHub-releases check, re-runnable.
// Desktop-only (the desktop install replaces itself from GitHub releases); the
// whole group hides over a platform without the seam. Extracted from
// SettingsView with the rest of the group components.
import { useUpdateStore } from '../../stores/update';
import { api } from '../../ipc';

const updates = useUpdateStore();
// Update checks are a desktop capability (the desktop install replaces itself
// from GitHub releases); the web deployment is always current, so the whole
// group stays hidden over a platform without the seam.
const updatesSupported = api.update !== undefined;
</script>

<template>
  <section v-if="updatesSupported" class="group" data-testid="settings-group-updates">
    <h3 class="group-title">Updates</h3>

    <div class="row">
      <div class="row-text">
        <label class="row-label">Updates</label>
        <p class="row-hint">
          The app checks this project's GitHub releases once per launch. Nothing
          installs itself: when a newer version exists you get a banner with a
          download link, and updating means replacing this copy the way you first
          put it here. The check runs at launch; this button runs it again now.
        </p>
      </div>
      <div class="control">
        <button class="btn-ghost" :disabled="updates.status === 'checking'" @click="updates.check()">
          {{ updates.status === 'checking' ? 'Checking…' : 'Check now' }}
        </button>
        <p class="row-hint">
          <template v-if="updates.status === 'up-to-date'">
            Up to date ({{ updates.currentVersion }}).
          </template>
          <template v-else-if="updates.status === 'available'">
            {{ updates.tagName }} is available.
          </template>
          <template v-else-if="updates.status === 'failed'">
            Check failed: {{ updates.reason }}
          </template>
          <template v-else-if="updates.status === 'idle'">
            {{ updates.currentVersion ?? '…' }}
          </template>
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped src="./settingsGroup.css"></style>
