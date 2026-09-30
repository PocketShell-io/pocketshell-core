<script setup lang="ts">
// HostKeyTrustGate: the app-wide host-key decision, mounted once in each
// platform's app root (beside DiagBanner). It renders nothing unless the
// platform advertises `ssh.onTrustDecision` AND a dial is waiting on a
// first-contact key; then it shows `HostKeyTrustPrompt` over the current view
// and hands the answer back through the connection store. It lives at the root,
// not in the host picker, because a re-dial from the workspace (the store's
// reconnect) can raise the same question with no picker on screen.
import HostKeyTrustPrompt from './HostKeyTrustPrompt.vue';
import { useConnectionStore } from '../stores/connection';

const connection = useConnectionStore();
</script>

<template>
  <div v-if="connection.pendingTrust" class="trust-scrim" data-testid="host-key-trust-gate">
    <HostKeyTrustPrompt
      :key="connection.pendingTrustSeq"
      :request="connection.pendingTrust"
      @decide="connection.answerTrust"
    />
  </div>
</template>

<style scoped>
.trust-scrim {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-4);
  background: var(--scrim);
}
</style>
