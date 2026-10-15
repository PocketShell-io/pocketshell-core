<script setup lang="ts">
// Upload one private key into the vault (platforms with `canUpload`): a file
// or pasted text, a name, and — only when the key turns out to be encrypted —
// that key's own passphrase, asked once. The vault stores the key decrypted,
// so every other device needs only the vault passphrase. With `rotateFrom`
// the upload replaces that key on every host bound to it.
import { ref } from 'vue';
import type { VaultKeyEntry } from '@pocketshell/core';
import { useKeyVault, vaultWriteMessage } from '../../keyVault';
import './vault.css';

const props = defineProps<{ idPrefix: string; rotateFrom?: VaultKeyEntry | null }>();
const emit = defineEmits<{ added: [entry: VaultKeyEntry, deduplicated: boolean]; cancel: [] }>();

const vault = useKeyVault();
const pem = ref('');
const fileName = ref('');
const name = ref(props.rotateFrom?.name ?? '');
const keyPassphrase = ref('');
const needsPassphrase = ref(false);
const busy = ref(false);
const error = ref('');

async function onFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  pem.value = await file.text();
  fileName.value = file.name;
  if (name.value === '') name.value = file.name.replace(/\.(pem|key)$/i, '');
  needsPassphrase.value = false;
  keyPassphrase.value = '';
  input.value = '';
}

async function submit(): Promise<void> {
  if (!vault || busy.value || pem.value.trim() === '') return;
  busy.value = true;
  error.value = '';
  try {
    const label = name.value.trim() || 'SSH key';
    const pass = needsPassphrase.value && keyPassphrase.value !== '' ? keyPassphrase.value : undefined;
    const result = props.rotateFrom
      ? await vault.rotateKey(props.rotateFrom.keyId, pem.value, label, pass)
      : await vault.addKey(pem.value, label, pass);
    if (result.kind === 'ok') {
      pem.value = '';
      fileName.value = '';
      keyPassphrase.value = '';
      needsPassphrase.value = false;
      emit('added', result.entry, result.deduplicated);
      return;
    }
    if (result.kind === 'needsPassphrase') {
      needsPassphrase.value = true;
      error.value = 'This key is encrypted. Enter its passphrase once; the vault keeps the key decrypted, sealed under your vault passphrase.';
      return;
    }
    error.value =
      result.kind === 'wrongPassphrase' ? "That passphrase doesn't open this key. Check it and try again." : vaultWriteMessage(result);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form v-if="vault?.canUpload" class="vault-form" data-testid="vault-key-upload" @submit.prevent="submit">
    <label class="vault-field">
      Key file
      <input :id="`${props.idPrefix}-file`" type="file" data-testid="vault-key-file" @change="onFile" />
    </label>
    <label class="vault-field">
      Or paste the private key
      <textarea
        v-model="pem"
        class="pem"
        data-testid="vault-key-pem"
        rows="4"
        spellcheck="false"
        autocomplete="off"
        placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
      />
    </label>
    <label class="vault-field">
      Name
      <input v-model="name" data-testid="vault-key-name" autocomplete="off" placeholder="e.g. laptop key" />
    </label>
    <label v-if="needsPassphrase" class="vault-field">
      This key's own passphrase
      <input v-model="keyPassphrase" data-testid="vault-key-passphrase" type="password" autocomplete="off" autocapitalize="off" />
    </label>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="vault-actions">
      <button class="vault-btn" type="button" :disabled="busy" @click="emit('cancel')">Cancel</button>
      <button class="vault-btn primary" type="submit" data-testid="vault-key-add" :disabled="busy || pem.trim() === ''">
        {{ busy ? 'Adding…' : props.rotateFrom ? 'Replace key' : 'Add to vault' }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.pem {
  min-height: 96px;
  padding: var(--sp-2);
  background: var(--surface-2);
  color: var(--fg);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  font-family: var(--font-mono);
  font-size: var(--fs-200);
  resize: vertical;
}
</style>
