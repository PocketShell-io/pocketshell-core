<script setup lang="ts">
// The host picker's gateway device source (#3086 slice 4): the account's
// devices enrolled on the PocketShell gateway that this device has not added
// yet, each with the gateway's LAST AUTHORITATIVE presence — online, offline,
// unknown (the gateway said nothing) — and revoked devices marked. Nothing
// here dials or probes a device; "offline" is the gateway's own word, shown
// before anyone taps anything, and is a different thing from a failed login.
//
// An added device is a saved host carrying the gateway marker: it moves to
// the host list (where its row shows the same presence chip), so a device is
// never listed twice. Devices are added through the add flow the parent
// owns; this section only lists and asks.
import { computed } from 'vue';
import {
  describeGatewayDeviceStatus,
  gatewayDeviceStatus,
  type GatewayDevice,
  type HostEntry,
} from '@pocketshell/core';
import AppIcon from '@ui/components/AppIcon.vue';
import { useGatewayStore } from '../stores/gateway';

const props = defineProps<{
  /** Every host already in the picker; a device one of them names is not listed again. */
  hosts: readonly HostEntry[];
  /** True while a dial is out: adding is still allowed, the list just waits. */
  busy?: boolean;
}>();

const emit = defineEmits<{
  /** Add this listed device (null: the user types a device id). */
  add: [device: GatewayDevice | null];
  /** The list needs a sign-in. */
  'sign-in': [];
}>();

const gateway = useGatewayStore();

/** Listed devices no host in the picker already names. */
const unadded = computed<GatewayDevice[]>(() => {
  const listed = gateway.devices ?? [];
  return listed.filter((device) => !props.hosts.some((host) => gateway.deviceFor(host.gateway)?.id === device.id));
});

const failure = computed(() => gateway.failure);
</script>

<template>
  <section class="gateway-devices" data-testid="gateway-devices" aria-labelledby="gateway-devices-label">
    <div class="gateway-head">
      <!-- Its own class, not the picker's `.group-label`: the host groups and
           this device source are different things (and are counted apart). -->
      <h2 id="gateway-devices-label" class="gateway-label">PocketShell gateway</h2>
      <button
        class="icon-btn sm"
        :disabled="gateway.loading"
        :aria-busy="gateway.loading"
        title="Reload gateway devices"
        aria-label="Reload gateway devices"
        data-testid="gateway-devices-reload"
        @click="gateway.load()"
      >
        <AppIcon name="refresh" :size="14" :class="{ spin: gateway.loading }" />
      </button>
    </div>

    <!-- A refusal says what to do next, by kind — never a generic error,
         and never the previous list as if it were this account's. -->
    <div v-if="failure" class="gateway-failure" :data-kind="failure.kind" data-testid="gateway-devices-failure">
      <p class="gateway-error">{{ failure.message }}</p>
      <button v-if="failure.kind === 'sign_in_required'" class="btn-ghost" @click="emit('sign-in')">Sign in</button>
      <button v-else class="btn-ghost" @click="gateway.load()">Reload</button>
    </div>
    <p v-else-if="gateway.devices === null && gateway.loading" class="muted">Loading your gateway devices…</p>

    <ul v-if="gateway.devices !== null" class="device-list">
      <li
        v-for="device in unadded"
        :key="device.id"
        class="device-item"
        :class="gatewayDeviceStatus(device)"
        :data-device-id="device.id"
        :data-status="gatewayDeviceStatus(device)"
        data-testid="gateway-device"
      >
        <span class="presence-dot" :class="gatewayDeviceStatus(device)" aria-hidden="true" />
        <span class="device-copy">
          <span class="device-id">{{ device.id }}</span>
          <span class="device-status" data-testid="gateway-device-status">
            {{ describeGatewayDeviceStatus(device, gateway.loadedAt ?? Date.now()) }}
          </span>
        </span>
        <button
          v-if="!device.revoked"
          class="btn-ghost add"
          :disabled="busy"
          data-testid="gateway-device-add"
          @click="emit('add', device)"
        >
          <AppIcon name="plus" :size="14" />
          Add
        </button>
      </li>
    </ul>
    <p v-if="gateway.devices !== null && unadded.length === 0" class="muted" data-testid="gateway-devices-empty">
      {{ gateway.devices.length === 0 ? 'No devices are enrolled on the gateway for this account.' : 'Every device on the gateway is already in your hosts.' }}
    </p>
    <button class="btn-ghost add-manual" data-testid="gateway-add-manual" @click="emit('add', null)">
      <AppIcon name="plus" :size="14" />
      Add a device by id
    </button>
  </section>
</template>

<style scoped>
.gateway-devices {
  margin-top: var(--sp-5);
}
.gateway-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: 0 0 var(--sp-2);
}
.gateway-head .gateway-label {
  margin: 0;
  color: var(--fg-muted);
  font-size: var(--fs-200);
  font-weight: var(--fw-semibold);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.gateway-failure {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-2);
  margin-bottom: var(--sp-2);
}
.gateway-failure .gateway-error {
  /* Not the shared `.error` class: the picker's own dial error is the one
     `.picker p.error`, and a device-list problem must never read as it. */
  color: var(--error);
  font-size: var(--fs-200);
  margin: 0;
  flex: 1 1 200px;
  overflow-wrap: anywhere;
}
.device-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.device-item {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-height: 48px;
  padding: var(--sp-2) var(--sp-2) var(--sp-2) var(--sp-4);
  margin-bottom: var(--sp-2);
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-lg);
}
.device-item.revoked {
  opacity: var(--disabled-opacity);
}
.presence-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: var(--fg-muted);
}
.presence-dot.online {
  background: var(--success);
}
.presence-dot.offline {
  background: transparent;
  border: 1px solid var(--fg-muted);
}
.presence-dot.revoked {
  background: var(--error);
}
.device-copy {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.device-id {
  font-family: var(--font-mono);
  font-size: var(--fs-300);
  color: var(--fg);
  overflow-wrap: anywhere;
}
.device-status {
  font-size: var(--fs-200);
  color: var(--fg-secondary);
}
.device-item.revoked .device-status {
  color: var(--error);
}
.add {
  flex: none;
  min-height: 44px;
}
.add-manual {
  margin-top: var(--sp-1);
  min-height: 44px;
}
</style>
