<script setup lang="ts">
// HostKeyTrustPrompt: the one host-key card every client shows.
//
// First contact (no `trustedFingerprintSha256`): it names the host, the key
// type and the SHA-256 fingerprint, and offers the three answers of the
// `ssh.onTrustDecision` contract — trust once (this connection only), always
// (pin it), or reject (no connection). `choices` narrows the offered answers
// for a caller that cannot honour all three.
//
// Changed key (`trustedFingerprintSha256` set): a REFUSAL, never a question.
// It says the key changed, shows the trusted and the presented fingerprint
// side by side, warns about interception, and offers no way to trust the new
// key — the only answer is to close it (`reject`). Re-trusting a legitimately
// rotated server is a deliberate "forget host key" action elsewhere, not a
// button on a security warning.
//
// Presentational only: the caller owns what an answer does.
// `HostKeyTrustGate` wires the first-contact card to the shared connection
// store; a platform screen can mount either variant directly.
import { computed, onMounted, ref } from 'vue';
import type { HostKeyTrustChoice, HostKeyTrustRequest } from '@pocketshell/core';

const props = withDefaults(
  defineProps<{
    request: HostKeyTrustRequest;
    /** The fingerprint pinned before; present only when the key CHANGED. */
    trustedFingerprintSha256?: string | null;
    choices?: readonly HostKeyTrustChoice[];
  }>(),
  {
    trustedFingerprintSha256: null,
    choices: () => ['accept-once', 'accept-always', 'reject'] as const,
  },
);
const emit = defineEmits<{ decide: [choice: HostKeyTrustChoice] }>();

const changed = computed(() => !!props.trustedFingerprintSha256);
const address = computed(() => {
  const { user, hostname, port } = props.request;
  const at = user ? `${user}@${hostname}` : hostname;
  return port && port !== 22 ? `${at}:${port}` : at;
});
// A changed key offers no trust answer, whatever the caller asked for.
const offers = (choice: HostKeyTrustChoice) =>
  changed.value ? choice === 'reject' : props.choices.includes(choice);

// One answer per prompt: a double tap must not send a second decision for a
// dial that has already moved on.
const answered = ref(false);
function decide(choice: HostKeyTrustChoice): void {
  if (answered.value) return;
  answered.value = true;
  emit('decide', choice);
}

// Land keyboard focus on the safe answer, never on "always".
const rejectEl = ref<HTMLButtonElement | null>(null);
onMounted(() => rejectEl.value?.focus({ preventScroll: true }));
</script>

<template>
  <section
    :class="['trust-card', { changed }]"
    role="alertdialog"
    aria-labelledby="host-key-trust-title"
    aria-describedby="host-key-trust-body"
    :data-testid="changed ? 'host-key-changed' : 'host-key-decision'"
  >
    <h2 id="host-key-trust-title" class="trust-title">
      {{ changed ? 'Host key changed — connection refused' : 'Verify this host key' }}
    </h2>
    <p v-if="changed" id="host-key-trust-body" class="trust-body">
      <strong data-testid="host-key-host">{{ request.hostLabel }}</strong>
      <span v-if="request.hostLabel !== address" class="muted"> ({{ address }})</span>
      presented a different host key from the one this device trusted. This can mean the server was
      reinstalled or that someone is intercepting the connection. Nothing was sent to the server and no
      connection is open.
    </p>
    <p v-else id="host-key-trust-body" class="trust-body">
      <strong data-testid="host-key-host">{{ request.hostLabel }}</strong>
      <span v-if="request.hostLabel !== address" class="muted"> ({{ address }})</span>
      presented a host key this device has not seen before. Compare the fingerprint with the one the
      server's administrator gave you before trusting it.
    </p>
    <dl class="trust-facts">
      <dt>Key type</dt>
      <dd data-testid="host-key-type">{{ request.keyType }}</dd>
      <template v-if="changed">
        <dt>Trusted</dt>
        <dd><code data-testid="host-key-trusted-fingerprint">{{ trustedFingerprintSha256 }}</code></dd>
        <dt>Presented</dt>
      </template>
      <dt v-else>Fingerprint</dt>
      <dd><code data-testid="host-key-fingerprint">{{ request.fingerprintSha256 }}</code></dd>
    </dl>
    <div class="trust-actions">
      <button
        v-if="offers('accept-always')"
        class="btn-primary"
        type="button"
        data-testid="trust-host-key"
        :disabled="answered"
        @click="decide('accept-always')"
      >
        Trust and remember
      </button>
      <button
        v-if="offers('accept-once')"
        class="btn-secondary"
        type="button"
        data-testid="trust-host-key-once"
        :disabled="answered"
        @click="decide('accept-once')"
      >
        Trust this time only
      </button>
      <button
        v-if="offers('reject')"
        ref="rejectEl"
        class="btn-secondary btn-reject"
        type="button"
        data-testid="reject-host-key"
        :disabled="answered"
        @click="decide('reject')"
      >
        {{ changed ? 'Close' : 'Reject' }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.trust-card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  width: min(480px, 100%);
  padding: var(--sp-4);
  background: var(--surface);
  border: 1px solid var(--warning);
  border-radius: var(--r-lg);
  color: var(--fg);
  box-shadow: var(--shadow-card);
}
.trust-card.changed {
  border-color: var(--error);
}
.trust-card.changed .trust-title {
  color: var(--error);
}
.trust-title {
  margin: 0;
  font-size: var(--fs-500);
  font-weight: var(--fw-semibold);
  color: var(--warning);
}
.trust-body {
  margin: 0;
  font-size: var(--fs-300);
  line-height: 1.5;
}
.trust-facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: var(--sp-1) var(--sp-3);
  margin: 0;
  padding: var(--sp-3);
  background: var(--surface-2);
  border-radius: var(--r-md);
  font-size: var(--fs-300);
}
.trust-facts dt {
  color: var(--fg-secondary);
}
.trust-facts dd {
  margin: 0;
  min-width: 0;
}
.trust-facts code {
  font-family: var(--font-mono);
  overflow-wrap: anywhere;
  word-break: break-all;
}
.trust-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}
.btn-primary,
.btn-secondary {
  min-height: var(--control-h);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 var(--sp-4);
  border-radius: var(--r-md);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-semibold);
}
.btn-primary {
  background: var(--accent);
  color: var(--on-accent);
  border: 1px solid var(--accent);
}
.btn-secondary {
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  color: var(--fg);
  font-weight: var(--fw-medium);
}
.btn-reject {
  color: var(--error);
}
.btn-primary:disabled,
.btn-secondary:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
/* Touch: 48px targets, one answer per row so a thumb cannot hit two. */
@media (pointer: coarse) {
  .trust-actions {
    flex-direction: column;
  }
  .btn-primary,
  .btn-secondary {
    min-height: 48px;
    width: 100%;
    font-size: var(--fs-400);
  }
}
</style>
