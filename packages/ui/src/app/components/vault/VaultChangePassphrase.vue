<script setup lang="ts">
// Change the vault passphrase (design section 5): the current one, then the
// new one twice. Keys are untouched; devices that remember the vault keep
// working, and elsewhere the next unlock needs the new passphrase.
import { ref } from 'vue';
import { useKeyVault, vaultWriteMessage } from '../../keyVault';
import VaultPassphraseFields from './VaultPassphraseFields.vue';
import './vault.css';

const emit = defineEmits<{ changed: [verifierPending: boolean]; cancel: [] }>();

const vault = useKeyVault();
const current = ref('');
const next = ref('');
const busy = ref(false);
const error = ref('');
const fields = ref<InstanceType<typeof VaultPassphraseFields> | null>(null);

async function submit(): Promise<void> {
  if (!vault || busy.value || current.value === '' || next.value === '') return;
  busy.value = true;
  error.value = '';
  try {
    const result = await vault.changePassphrase(current.value, next.value);
    current.value = '';
    if (result.kind === 'ok') {
      fields.value?.clear();
      emit('changed', result.verifierPending === true);
      return;
    }
    error.value =
      result.kind === 'backoff'
        ? `That isn't your current vault passphrase. Try again in ${Math.ceil(result.retryAfterMs / 1000)} s.`
        : vaultWriteMessage(result);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form v-if="vault" class="vault-form" data-testid="vault-change-passphrase" @submit.prevent="submit">
    <label class="vault-field">
      Current vault passphrase
      <input v-model="current" data-testid="vault-change-current" type="password" autocomplete="current-password" autocapitalize="off" />
    </label>
    <VaultPassphraseFields ref="fields" id-prefix="vault-change" @update:valid="next = $event" />
    <p class="vault-body">Changing it keeps your keys; other devices need the new one next time they ask.</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="vault-actions">
      <button class="vault-btn" type="button" :disabled="busy" @click="emit('cancel')">Cancel</button>
      <button
        class="vault-btn primary"
        type="submit"
        data-testid="vault-change-submit"
        :disabled="busy || current === '' || next === ''"
      >
        {{ busy ? 'Changing…' : 'Change passphrase' }}
      </button>
    </div>
  </form>
</template>
