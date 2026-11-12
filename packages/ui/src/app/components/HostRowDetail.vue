<script setup lang="ts">
// The detail half of a host-picker row: what the row dials, in one honest
// line, then — for a gateway host only — the gateway's last word on its
// presence. Its own component so the three detail shapes stay ONE v-if
// chain: a local host (dials nothing), a gateway host (hostname/port are
// labels the gateway transport never dials), and an ordinary host's
// user@host:port. The presence chip sits OUTSIDE that chain, so it can never
// capture the chain's `v-else` (core#50 review B2: it did, and printed
// `self@self:0` for a local host and a fake address for a gateway host).
import type { HostEntry } from '@pocketshell/core';

defineProps<{
  host: HostEntry;
  /** The gateway's last presence for a gateway host, or null (never a probe). */
  presence: { status: string; text: string } | null;
}>();

const CHIP_LABEL: Record<string, string> = { online: 'Online', offline: 'Offline', unknown: 'Unknown', revoked: 'Revoked' };
</script>

<template>
  <span v-if="host.local" class="host-detail" data-testid="host-detail">This computer — local, no SSH</span>
  <span
    v-else-if="host.gateway"
    class="host-detail"
    data-testid="host-detail"
    :title="`${host.user} via gateway device ${host.gateway.deviceId}`"
  >{{ host.user || '(default user)' }} · via gateway</span>
  <span v-else class="host-detail" data-testid="host-detail">{{ host.user || '(default user)' }}@{{ host.hostname }}:{{ host.port }}</span>
  <span
    v-if="host.gateway && presence"
    class="presence-chip"
    :class="presence.status"
    :title="presence.text"
    data-testid="host-gateway-presence"
  >{{ CHIP_LABEL[presence.status] ?? presence.status }}</span>
</template>

<style scoped>
.host-detail {
  color: var(--fg-secondary);
  font-family: var(--font-mono);
  font-size: var(--fs-200);
  flex: 1;
}
/* A gateway host's presence, as the gateway last reported it. */
.presence-chip {
  display: inline-block;
  flex: none;
  padding: 0 var(--sp-1);
  border-radius: var(--r-sm);
  font-family: var(--font-ui);
  font-size: var(--fs-100);
  line-height: var(--lh-200);
  background: var(--surface-2);
  color: var(--fg-secondary);
}
.presence-chip.online {
  background: var(--success-soft);
  color: var(--success);
}
.presence-chip.offline {
  background: var(--warning-soft);
  color: var(--warning);
}
.presence-chip.revoked {
  background: var(--error-soft);
  color: var(--error);
}
</style>
