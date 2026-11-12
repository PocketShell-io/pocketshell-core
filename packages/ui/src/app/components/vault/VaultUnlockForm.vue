<script setup lang="ts">
// The vault unlock (design section 5): passphrase, the per-device choice
// (default: type it every time), Unlock. A wrong passphrase says so and keeps
// the form; from the fourth failure the button waits out the backoff with a
// countdown, and a server lockout (rateLimited) counts down the same way.
// "Forgot it?" explains that the passphrase cannot be recovered and leads to
// the reset — in-app or on the web, whichever the platform provides.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { VaultUnlockResult } from '@pocketshell/core';
import { useKeyVault, VAULT_TEXT, vaultUnlockMessage } from '../../keyVault';
import './vault.css';

const props = defineProps<{ idPrefix?: string }>();
const emit = defineEmits<{ unlocked: [] }>();

const vault = useKeyVault();
const passphrase = ref('');
const remember = ref(false);
const busy = ref(false);
const failure = ref<Exclude<VaultUnlockResult, { kind: 'ok' }> | null>(null);
const blockedUntil = ref(0);
const showForgot = ref(false);
const field = ref<HTMLInputElement | null>(null);
const now = ref(vault?.now() ?? Date.now());
const timer = setInterval(() => (now.value = vault?.now() ?? Date.now()), 500);
onBeforeUnmount(() => clearInterval(timer));
onMounted(() => field.value?.focus({ preventScroll: true }));

const prefix = computed(() => props.idPrefix ?? 'vault-unlock');
const waitSec = computed(() => {
  const until = Math.max(blockedUntil.value, vault?.view.retryAt ?? 0);
  return Math.max(0, Math.ceil((until - now.value) / 1000));
});
const message = computed(() => (failure.value ? vaultUnlockMessage(failure.value, waitSec.value) : ''));

async function submit(): Promise<void> {
  if (!vault || busy.value || passphrase.value === '' || waitSec.value > 0) return;
  busy.value = true;
  failure.value = null;
  try {
    const result = await vault.unlock(passphrase.value, remember.value);
    passphrase.value = '';
    if (result.kind === 'ok') {
      emit('unlocked');
      return;
    }
    failure.value = result;
    blockedUntil.value = 'retryAfterMs' in result && result.retryAfterMs > 0 ? vault.now() + result.retryAfterMs : 0;
    now.value = vault.now();
    field.value?.focus();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form v-if="vault" class="vault-form" data-testid="vault-unlock-form" @submit.prevent="submit">
    <label class="vault-field">
      Vault passphrase
      <input
        :id="`${prefix}-pass`"
        ref="field"
        v-model="passphrase"
        data-testid="vault-unlock-passphrase"
        type="password"
        autocomplete="current-password"
        autocapitalize="off"
        :disabled="busy"
      />
    </label>
    <fieldset v-if="vault.canRemember" class="vault-choice">
      <legend>On this device</legend>
      <label class="vault-radio">
        <input v-model="remember" type="radio" :value="false" :name="`${prefix}-remember`" data-testid="vault-unlock-type-every-time" />
        <span>Type it every time</span>
      </label>
      <label class="vault-radio">
        <input v-model="remember" type="radio" :value="true" :name="`${prefix}-remember`" data-testid="vault-unlock-remember" />
        <span>Remember on this device<small>{{ VAULT_TEXT.rememberHint }}</small></span>
      </label>
    </fieldset>
    <p v-if="message" class="error" role="alert" data-testid="vault-unlock-error">{{ message }}</p>
    <div v-if="showForgot" class="vault-form" data-testid="vault-unlock-forgot-text">
      <p class="vault-body">{{ VAULT_TEXT.forgot }}</p>
      <div v-if="vault.canForgot" class="vault-actions">
        <button class="vault-btn" type="button" data-testid="vault-unlock-reset" @click="vault.forgot()">
          {{ vault.platform.onForgot ? 'Reset the vault…' : 'Reset on the web…' }}
        </button>
      </div>
    </div>
    <div class="vault-actions">
      <button
        v-if="!showForgot"
        class="vault-link vault-start"
        type="button"
        data-testid="vault-unlock-forgot"
        @click="showForgot = true"
      >
        Forgot it?
      </button>
      <slot name="actions" />
      <button
        class="vault-btn primary"
        type="submit"
        data-testid="vault-unlock-submit"
        :disabled="busy || passphrase === '' || waitSec > 0"
      >
        {{ busy ? 'Unlocking…' : waitSec > 0 ? `Wait ${waitSec}s` : 'Unlock' }}
      </button>
    </div>
  </form>
</template>
