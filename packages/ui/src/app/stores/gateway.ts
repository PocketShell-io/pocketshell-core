import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import {
  classifyGatewayDirectoryFailure,
  normalizeGatewayServerUrl,
  type GatewayDevice,
  type GatewayDirectoryFailure,
  type GatewayTransportTarget,
} from '@pocketshell/core';
import { gatewayCapability } from '../platformCapabilities';
import type { GatewayPairingSummary } from '../api';

/**
 * The host picker's gateway device source (#3086 slice 4): the account's
 * enrolled devices as the gateway lists them, and this device's pairings.
 *
 * Presence is the gateway's LAST AUTHORITATIVE observation, read only when
 * the list is (re)loaded — on the picker's mount, its Reload, and after a
 * device is added. Nothing here dials or probes a device: a device whose
 * agent is offline reads "offline" from the gateway's own word, which is a
 * different thing from a login failure (that is a dial outcome, reported by
 * the connection store).
 *
 * A refusal keeps its kind (`sign_in_required`, `account_changed`, …) so the
 * picker can prompt for the right next step, and it never leaves a stale
 * list on screen as if it were the current account's.
 */
export const useGatewayStore = defineStore('gateway', () => {
  const capability = gatewayCapability();
  /**
   * The gateway whose devices are listed: the one the PLATFORM names (on
   * Android, its native allowlist). Nothing in this tree can widen it — no
   * stored override, no user-typed origin — because the platform sends its
   * gateway credential only there (#3086 review B1).
   */
  const serverUrl = ref<string>(capability?.defaultServerUrl ?? '');
  const devices = shallowRef<GatewayDevice[] | null>(null);
  const pairings = shallowRef<GatewayPairingSummary[]>([]);
  const loading = ref(false);
  const failure = shallowRef<GatewayDirectoryFailure | null>(null);
  /** The reader's clock when the list arrived (for "n min ago"). */
  const loadedAt = ref<number | null>(null);
  let sequence = 0;

  const available = computed(() => capability !== null);

  /** (Re)load the device list and pairings; a newer load supersedes an older one. */
  async function load(): Promise<void> {
    if (!capability) return;
    const mine = ++sequence;
    loading.value = true;
    try {
      const [listed, paired] = await Promise.all([capability.devices(serverUrl.value), capability.pairings()]);
      if (mine !== sequence) return;
      devices.value = listed;
      pairings.value = paired;
      failure.value = null;
      loadedAt.value = Date.now();
    } catch (error) {
      if (mine !== sequence) return;
      // A refused list is never shown as the current account's: drop it.
      devices.value = null;
      failure.value = classifyGatewayDirectoryFailure(error);
    } finally {
      if (mine === sequence) loading.value = false;
    }
  }

  /** Forget everything (sign-out, account switch). */
  function reset(): void {
    sequence += 1;
    devices.value = null;
    pairings.value = [];
    failure.value = null;
    loading.value = false;
    loadedAt.value = null;
  }

  function sameRoute(target: GatewayTransportTarget, deviceId: string, server: string): boolean {
    return target.deviceId === deviceId && normalizeGatewayServerUrl(target.serverUrl) === normalizeGatewayServerUrl(server);
  }

  /** The listed device a saved host's gateway marker names, if this list is for its gateway. */
  function deviceFor(target: GatewayTransportTarget | undefined | null): GatewayDevice | null {
    if (!target || devices.value === null) return null;
    return devices.value.find((device) => sameRoute(target, device.id, serverUrl.value)) ?? null;
  }

  /** This device's pairing for a gateway route, if any. */
  function pairingFor(target: GatewayTransportTarget): GatewayPairingSummary | null {
    return pairings.value.find((row) => sameRoute(target, row.deviceId, row.serverUrl)) ?? null;
  }

  return { available, serverUrl, devices, pairings, loading, failure, loadedAt, load, reset, deviceFor, pairingFor };
});
