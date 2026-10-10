<script setup lang="ts">
// The next step for a classified gateway dial refusal, shown beside (never
// inside) the picker's error line: sign in, pair the device again (with the
// host's own saved gateway), connect again as the current account, or — for
// an offline host — say so and offer to reload the device list. Unknown or
// non-gateway failures get no actions.
import type { GatewayDialFailureKind, HostEntry } from '@pocketshell/core';

defineProps<{
  kind: GatewayDialFailureKind;
  /** The host whose dial failed. */
  host: HostEntry | null;
  /** Whether the platform provides the gateway device source. */
  gatewayAvailable: boolean;
}>();

const emit = defineEmits<{
  'sign-in': [];
  repair: [host: HostEntry];
  'connect-again': [host: HostEntry];
  'reload-devices': [];
}>();
</script>

<template>
  <div class="error-actions" :data-kind="kind" data-testid="picker-error-actions">
    <button v-if="kind === 'sign_in_required' || kind === 'unauthorized'" class="btn-ghost" @click="emit('sign-in')">
      Sign in
    </button>
    <button
      v-else-if="(kind === 'pairing_required' || kind === 'not_found') && host?.gateway && gatewayAvailable"
      class="btn-ghost"
      @click="emit('repair', host!)"
    >
      Pair this device
    </button>
    <button v-else-if="kind === 'account_changed' && host" class="btn-ghost" @click="emit('connect-again', host!)">
      Connect again
    </button>
    <template v-else-if="kind === 'host_offline'">
      <span class="offline-chip">Offline</span>
      <button v-if="gatewayAvailable" class="btn-ghost" @click="emit('reload-devices')">Reload devices</button>
    </template>
  </div>
</template>

<style scoped>
.error-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-top: calc(-1 * var(--sp-2));
}
.offline-chip {
  display: inline-block;
  padding: 0 var(--sp-1);
  border-radius: var(--r-sm);
  font-size: var(--fs-100);
  line-height: var(--lh-200);
  background: var(--warning-soft);
  color: var(--warning);
}
</style>
