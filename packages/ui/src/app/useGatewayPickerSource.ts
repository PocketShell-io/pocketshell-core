/**
 * The host picker's gateway half (#3086 slice 4), kept out of
 * HostPickerView.vue: the device source follows the signed-in account, the
 * add/pair flow is bound to the account it was opened for, and a saved
 * gateway host's presence comes from the gateway's last list (never a probe).
 *
 * The picker supplies its account state, its host lists and its one dialling
 * path; this composable decides nothing about connecting.
 */
import { computed, shallowRef, watch, type ComputedRef, type Ref } from 'vue';
import {
  describeGatewayDeviceStatus,
  gatewayDeviceStatus,
  type GatewayDevice,
  type HostEntry,
} from '@pocketshell/core';
import { useGatewayStore } from './stores/gateway';
import type { GatewayAddDeviceResult } from './api';

export interface GatewayAddFlow {
  device: GatewayDevice | null;
  /** Re-pairing a saved host: its fields INCLUDING its own saved gateway origin. */
  prefill: { deviceId: string; name: string; username: string; serverUrl: string } | null;
  /** The signed-in account the flow was opened for; a switch closes it. */
  account: string | null;
}

export interface GatewayPickerSourceDeps {
  /** The signed-in account's email ('' when unknown), or null when signed out. */
  account: ComputedRef<string | null>;
  /** Every host the picker lists (config + account-only). */
  listedHosts: Ref<HostEntry[]> | ComputedRef<HostEntry[]>;
  /** Re-read the platform's hosts after a device is added. */
  reloadHosts: () => Promise<void>;
  /** The picker's one dialling path. */
  connect: (host: HostEntry) => Promise<void>;
  hostByName: (name: string) => HostEntry | undefined;
}

export function useGatewayPickerSource(deps: GatewayPickerSourceDeps) {
  const gateway = useGatewayStore();
  const addingDevice = shallowRef<GatewayAddFlow | null>(null);

  // The device list is the account's: reload it on sign-in or switch, forget
  // it on sign-out; an open add/pair flow for another account closes (the
  // panel drops anything still in flight).
  watch(
    deps.account,
    (account) => {
      if (addingDevice.value && addingDevice.value.account !== account) addingDevice.value = null;
      if (!gateway.available) return;
      gateway.reset();
      if (account !== null) void gateway.load();
    },
    { immediate: true },
  );

  function hostPresence(host: HostEntry): { status: string; text: string } | null {
    const device = gateway.deviceFor(host.gateway);
    if (!device) return null;
    return { status: gatewayDeviceStatus(device), text: describeGatewayDeviceStatus(device, gateway.loadedAt ?? Date.now()) };
  }

  function openAddDevice(device: GatewayDevice | null): void {
    addingDevice.value = { device, prefill: null, account: deps.account.value };
  }

  /** "Pair again" for a saved gateway host; its own origin rides along, never the list's. */
  function openRepair(host: HostEntry): void {
    if (!host.gateway) return;
    addingDevice.value = {
      device: gateway.deviceFor(host.gateway),
      prefill: { deviceId: host.gateway.deviceId, name: host.name, username: host.user ?? '', serverUrl: host.gateway.serverUrl },
      account: deps.account.value,
    };
  }

  const flowIsCurrent = (): boolean => addingDevice.value !== null && addingDevice.value.account === deps.account.value;

  async function onDeviceSaved(_result: GatewayAddDeviceResult): Promise<void> {
    if (!flowIsCurrent()) return;
    // The new host is the platform's to list; re-read it and the device list
    // (it now leaves the device source for the host list).
    await Promise.allSettled([deps.reloadHosts(), gateway.load()]);
  }

  async function onConnectAdded(hostName: string): Promise<void> {
    if (!flowIsCurrent()) return;
    addingDevice.value = null;
    const host = deps.hostByName(hostName);
    if (host) await deps.connect(host);
  }

  return {
    gateway,
    addingDevice,
    listedHosts: computed(() => deps.listedHosts.value),
    hostPresence,
    openAddDevice,
    openRepair,
    onDeviceSaved,
    onConnectAdded,
  };
}
