<script setup lang="ts">
// "Add a gateway device" (#3086 slice 4): one flow on every platform that
// provides the `gateway` group; only choosing the key is the platform's own
// (its key store backs `clientKeys`). Three things make a device reachable,
// and the flow asks for each explicitly:
//
//   1. the HOST-KEY PIN, pasted from the host itself — the line
//      `pocketshell gateway show --host-key` prints there, the
//      `pocketshell-link show` line, or a SHA256 fingerprint. The device
//      list's `ssh_host_key` is ADVISORY: it is shown as something to compare
//      against, never copied into the pin and never stored as trust;
//   2. THIS device's public key in the host's ~/.ssh/authorized_keys. No
//      released CLI writes that file, so the flow shows the key line and the
//      exact manual step. It never claims the key IS authorized: only a
//      successful login proves that;
//   3. the SSH user and a name for the saved host.
//
// Saving pairs the device (pin + key, kept by the platform) and saves a host
// carrying the gateway marker. Connecting is the picker's ordinary dial.
import { computed, onMounted, ref, watch } from 'vue';
import {
  GATEWAY_DEFAULT_SERVER_URL,
  classifyGatewayDirectoryFailure,
  gatewayHostPinText,
  isValidGatewayDeviceId,
  normalizeGatewayServerUrl,
  parseGatewayHostPin,
  pinMatchesAdvisory,
  type GatewayDevice,
  type GatewayDirectoryFailure,
} from '@pocketshell/core';
import { api } from '../ipc';
import type { GatewayAddDeviceResult, GatewayClientKey } from '../api';

const props = defineProps<{
  /** The listed device being added, or null to type a device id. */
  device: GatewayDevice | null;
  serverUrl: string;
  /** Prefill for re-pairing a saved host (the picker's "pair again"). */
  prefill?: { deviceId: string; name: string; username: string } | null;
}>();

const emit = defineEmits<{
  saved: [result: GatewayAddDeviceResult];
  connect: [hostName: string];
  'sign-in': [];
  close: [];
}>();

const gateway = api.gateway!;

const deviceId = ref(props.device?.id ?? props.prefill?.deviceId ?? '');
const server = ref(props.serverUrl || gateway.defaultServerUrl || GATEWAY_DEFAULT_SERVER_URL);
const name = ref(props.prefill?.name ?? props.device?.id ?? '');
const username = ref(props.prefill?.username ?? '');
const pinText = ref('');
const keys = ref<GatewayClientKey[]>([]);
const keyId = ref('');
const keysError = ref<string | null>(null);
/** True once the first key read answered (either way). */
const keysLoaded = ref(false);
const creatingKey = ref(false);
const saving = ref(false);
const failure = ref<GatewayDirectoryFailure | null>(null);
const saved = ref<GatewayAddDeviceResult | null>(null);
const copied = ref(false);

// Name follows the device id until the user edits it.
let nameEdited = props.prefill != null;
watch(deviceId, (next, previous) => {
  if (!nameEdited || name.value === previous) name.value = next;
});
function onNameInput(): void {
  nameEdited = true;
}

const pin = computed(() => parseGatewayHostPin(pinText.value));
const pinState = computed(() => (pinText.value.trim() === '' ? 'empty' : pin.value === null ? 'invalid' : 'ok'));
const advisory = computed(() => props.device?.advisoryHostKey ?? null);
const advisoryMatch = computed(() => (pin.value ? pinMatchesAdvisory(pin.value, advisory.value) : null));
const selectedKey = computed(() => keys.value.find((key) => key.id === keyId.value) ?? null);
const canonicalServer = computed(() => normalizeGatewayServerUrl(server.value));

/** The manual authorization step, for the key the user picked. */
const authorizeCommand = computed(() =>
  selectedKey.value ? `echo '${selectedKey.value.publicKey}' >> ~/.ssh/authorized_keys` : '',
);
/** The Windows agent command; only on an unreleased CLI branch, and labelled so. */
const windowsCommand = computed(() =>
  selectedKey.value
    ? `pocketshell gateway agent authorize-key --public-key "${selectedKey.value.publicKey}" --confirmed --json`
    : '',
);

const problem = computed<string | null>(() => {
  if (!isValidGatewayDeviceId(deviceId.value.trim())) return 'Enter the device id the gateway enrolled.';
  if (canonicalServer.value === null) return 'Enter the gateway address as a wss:// origin.';
  if (name.value.trim() === '') return 'Give the host a name.';
  if (username.value.trim() === '') return 'Enter the SSH user on the device.';
  if (pin.value === null) return 'Paste the host key the host printed.';
  if (selectedKey.value === null) return 'Choose the key this device signs in with.';
  return null;
});

async function loadKeys(): Promise<void> {
  keysError.value = null;
  try {
    keys.value = await gateway.clientKeys();
    if (!keys.value.some((key) => key.id === keyId.value)) keyId.value = keys.value[0]?.id ?? '';
  } catch (error) {
    keysError.value = error instanceof Error && error.message ? error.message : 'Your keys could not be read.';
  } finally {
    keysLoaded.value = true;
  }
}

async function createKey(): Promise<void> {
  if (!gateway.createClientKey) return;
  creatingKey.value = true;
  keysError.value = null;
  try {
    const created = await gateway.createClientKey(`PocketShell gateway ${deviceId.value.trim() || 'key'}`);
    await loadKeys();
    keyId.value = created.id;
  } catch (error) {
    keysError.value = error instanceof Error && error.message ? error.message : 'The key could not be created.';
  } finally {
    creatingKey.value = false;
  }
}

async function copyKey(): Promise<void> {
  if (!selectedKey.value) return;
  try {
    await navigator.clipboard.writeText(selectedKey.value.publicKey);
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch {
    // The line stays selectable on screen; nothing else to do.
  }
}

async function shareKey(): Promise<void> {
  if (selectedKey.value && gateway.shareClientKey) await gateway.shareClientKey(selectedKey.value.id).catch(() => undefined);
}

async function save(): Promise<void> {
  if (problem.value !== null || pin.value === null || canonicalServer.value === null) return;
  saving.value = true;
  failure.value = null;
  try {
    saved.value = await gateway.addDevice({
      name: name.value.trim(),
      username: username.value.trim(),
      gateway: { serverUrl: canonicalServer.value, deviceId: deviceId.value.trim() },
      // What the USER pasted, canonicalized — never the advisory key.
      pin: gatewayHostPinText(pin.value),
      keyId: keyId.value,
    });
    emit('saved', saved.value);
  } catch (error) {
    failure.value = classifyGatewayDirectoryFailure(error);
  } finally {
    saving.value = false;
  }
}

onMounted(() => void loadKeys());
</script>

<template>
  <div class="gateway-add" data-testid="gateway-add-device" :data-keys-loaded="keysLoaded">
    <template v-if="saved">
      <p class="saved" data-testid="gateway-add-saved">
        Saved <strong>{{ saved.hostName }}</strong>, pinned to host key
        <code>{{ saved.pairing.fingerprint }}</code>.
      </p>
      <p class="muted">
        Whether the host accepts this device's key is known only when a login succeeds — connect to check.
      </p>
      <div class="actions">
        <button class="primary" data-testid="gateway-add-connect" @click="emit('connect', saved.hostName)">Connect</button>
        <button class="btn-ghost" @click="emit('close')">Done</button>
      </div>
    </template>

    <form v-else @submit.prevent="save">
      <section class="step">
        <h3>Device</h3>
        <label>Device id
          <input
            v-model="deviceId"
            data-testid="gateway-add-device-id"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            :readonly="device !== null || prefill != null"
          />
        </label>
        <label>Name
          <input v-model="name" data-testid="gateway-add-name" autocomplete="off" @input="onNameInput" />
        </label>
        <label>SSH user on the device
          <input v-model="username" data-testid="gateway-add-user" autocomplete="off" autocapitalize="off" spellcheck="false" />
        </label>
        <details class="advanced">
          <summary>Gateway address</summary>
          <label>Gateway
            <input v-model="server" data-testid="gateway-add-server" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="url" />
          </label>
        </details>
      </section>

      <section class="step">
        <h3>Host key</h3>
        <p class="muted">
          On the host, run <code>pocketshell gateway show --host-key</code> and paste the line it prints.
          The <code>pocketshell-link show</code> line or a <code>SHA256:</code> fingerprint also works.
        </p>
        <textarea
          v-model="pinText"
          data-testid="gateway-add-pin"
          rows="3"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder="ssh-ed25519 AAAA…"
          :aria-invalid="pinState === 'invalid'"
        />
        <p v-if="pinState === 'invalid'" class="error" data-testid="gateway-add-pin-error">
          That is not a host key line or a SHA256 fingerprint.
        </p>
        <p v-else-if="pin?.kind === 'host-key'" class="muted" data-testid="gateway-add-pin-ok">
          {{ pin.keyType }} key — PocketShell will refuse the host if it presents any other key.
        </p>
        <p v-else-if="pin?.kind === 'fingerprint'" class="muted" data-testid="gateway-add-pin-ok">
          Fingerprint {{ pin.fingerprint }}
        </p>
        <!-- The gateway's copy is a hint to compare, never the pin. -->
        <div v-if="advisory" class="advisory" data-testid="gateway-add-advisory">
          <p class="muted">The gateway reports this key for the device (for comparison only — it is not used as the pin):</p>
          <code class="line">{{ advisory }}</code>
          <p v-if="advisoryMatch === false" class="warn" data-testid="gateway-add-advisory-mismatch">
            The key you pasted differs from what the gateway reports. Check it on the host before saving.
          </p>
        </div>
      </section>

      <section class="step">
        <h3>This device's key</h3>
        <p v-if="keysError" class="error">{{ keysError }}</p>
        <template v-if="keys.length > 0">
          <label>Sign in with
            <select v-model="keyId" data-testid="gateway-add-key">
              <option v-for="key in keys" :key="key.id" :value="key.id">{{ key.label }} · {{ key.fingerprint }}</option>
            </select>
          </label>
        </template>
        <p v-else-if="!keysError" class="muted">There is no key on this device yet.</p>
        <button
          v-if="gateway.createClientKey"
          type="button"
          class="btn-ghost"
          :disabled="creatingKey"
          data-testid="gateway-add-create-key"
          @click="createKey"
        >
          Create a new key
        </button>
        <template v-if="selectedKey">
          <p class="muted">
            Add this public key to <code>~/.ssh/authorized_keys</code> for the SSH user on the host:
          </p>
          <code class="line" data-testid="gateway-add-public-key">{{ selectedKey.publicKey }}</code>
          <div class="actions">
            <button type="button" class="btn-ghost" data-testid="gateway-add-copy-key" @click="copyKey">
              {{ copied ? 'Copied' : 'Copy key' }}
            </button>
            <button v-if="gateway.shareClientKey" type="button" class="btn-ghost" data-testid="gateway-add-share-key" @click="shareKey">Share key</button>
          </div>
          <p class="muted">On a Linux or macOS host, as that user:</p>
          <code class="line" data-testid="gateway-add-authorize-command">{{ authorizeCommand }}</code>
          <p class="muted">
            On a Windows host — requires PocketShell CLI with gateway agent (upcoming):
          </p>
          <code class="line" data-testid="gateway-add-windows-command">{{ windowsCommand }}</code>
        </template>
      </section>

      <div v-if="failure" class="failure" :data-kind="failure.kind" data-testid="gateway-add-failure">
        <p class="error">{{ failure.message }}</p>
        <button v-if="failure.kind === 'sign_in_required'" type="button" class="btn-ghost" @click="emit('sign-in')">Sign in</button>
      </div>
      <p v-else-if="problem" class="muted hint" data-testid="gateway-add-problem">{{ problem }}</p>
      <div class="actions">
        <button class="primary" type="submit" :disabled="problem !== null || saving" data-testid="gateway-add-save">
          {{ saving ? 'Saving…' : 'Save device' }}
        </button>
        <button class="btn-ghost" type="button" @click="emit('close')">Cancel</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.gateway-add {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4) var(--sp-4);
}
form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.step {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
h3 {
  margin: 0;
  font-size: var(--fs-300);
  font-weight: var(--fw-semibold);
  color: var(--fg);
}
p {
  margin: 0;
  font-size: var(--fs-200);
  line-height: var(--lh-200);
}
label {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  font-size: var(--fs-200);
  color: var(--fg-secondary);
}
input,
select,
textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 44px;
  padding: var(--sp-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  background: var(--surface-2);
  color: var(--fg);
  font: inherit;
  font-size: var(--fs-300);
}
textarea,
input[data-testid='gateway-add-device-id'],
input[data-testid='gateway-add-server'] {
  font-family: var(--font-mono);
}
input:focus,
select:focus,
textarea:focus {
  outline: 2px solid var(--accent-dim);
  outline-offset: 1px;
}
input[readonly] {
  color: var(--fg-secondary);
}
textarea[aria-invalid='true'] {
  border-color: var(--error);
}
code {
  font-family: var(--font-mono);
  font-size: 0.9em;
}
.line {
  display: block;
  padding: var(--sp-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  overflow-wrap: anywhere;
  user-select: all;
  color: var(--fg);
}
.advisory {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.warn {
  color: var(--warning);
}
.advanced summary {
  cursor: pointer;
  color: var(--fg-secondary);
  font-size: var(--fs-200);
  min-height: 44px;
  display: flex;
  align-items: center;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
  align-items: center;
}
.failure {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
  align-items: center;
}
.failure .error {
  flex: 1 1 200px;
  overflow-wrap: anywhere;
}
.primary {
  min-height: 44px;
  padding: 0 var(--sp-4);
  border: 1px solid var(--accent);
  border-radius: var(--r-md);
  background: var(--accent);
  color: var(--on-accent);
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}
.primary:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
.saved {
  font-size: var(--fs-300);
  color: var(--fg);
  overflow-wrap: anywhere;
}
</style>
