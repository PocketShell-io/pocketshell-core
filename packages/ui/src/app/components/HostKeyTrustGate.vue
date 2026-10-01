<script setup lang="ts">
// HostKeyTrustGate: the app-wide host-key decision, mounted once in the shared
// AppRoot (beside DiagBanner), so every client that advertises the hook gets
// it. It renders nothing unless the platform advertises
// `ssh.onTrustDecision` AND a dial is waiting on a
// first-contact key; then it shows `HostKeyTrustPrompt` over the current view
// and hands the answer back through the connection store. It lives at the root,
// not in the host picker, because a re-dial from the workspace (the store's
// reconnect) can raise the same question with no picker on screen.
import HostKeyTrustPrompt from './HostKeyTrustPrompt.vue';
import { api } from '../ipc';
import { useConnectionStore } from '../stores/connection';

// Only a client that advertises the hook has anything to ask; on the others
// the gate stays inert and does not even create the connection store, so
// mounting it in AppRoot changes nothing for them (desktop, web, a client
// window without an `ssh` group).
const connection = typeof api.ssh?.onTrustDecision === 'function' ? useConnectionStore() : null;
</script>

<template>
  <div v-if="connection?.pendingTrust" class="trust-scrim" data-testid="host-key-trust-gate">
    <HostKeyTrustPrompt
      :key="connection.pendingTrustSeq"
      :request="connection.pendingTrust"
      @decide="connection.answerTrust"
    />
  </div>
</template>

<style scoped>
.trust-scrim {
  /* Sized to the VISIBLE viewport, not `inset: 0`: when a view's content is
     wider than a phone screen the WebView grows its layout viewport to fit,
     and an `inset: 0` layer (and the fingerprint in it) would then run off
     the right edge. `100vw`/`100dvh` stay the device's viewport. */
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100dvh;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-4);
  background: var(--scrim);
}
</style>
