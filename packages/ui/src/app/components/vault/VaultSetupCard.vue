<script setup lang="ts">
// First setup (design section 5, web): create the account's vault passphrase,
// entered twice with a strength meter, behind the plain "cannot be recovered"
// warning. One passphrase from then on: the vault also carries the sync
// passphrase (`syncPassphrase`), and an account that already has one may keep
// using it as the vault passphrase (`reusablePassphrase`).
import { computed, ref } from 'vue';
import { useKeyVault, VAULT_TEXT, vaultWriteMessage } from '../../keyVault';
import VaultPassphraseFields from './VaultPassphraseFields.vue';
import './vault.css';

const props = defineProps<{
  /** The account's sync passphrase, stored in the vault index so one unlock opens the host list. */
  syncPassphrase?: string | null;
  /** Offer "keep using my sync passphrase" when the client knows it. */
  reusablePassphrase?: string | null;
}>();
const emit = defineEmits<{ created: [] }>();

const vault = useKeyVault();
const reuse = ref<'new' | 'sync'>('new');
const fresh = ref('');
const remember = ref(false);
const understood = ref(false);
const busy = ref(false);
const error = ref('');
const canReuse = computed(() => !!props.reusablePassphrase);
const chosen = computed(() => (canReuse.value && reuse.value === 'sync' ? (props.reusablePassphrase as string) : fresh.value));

async function create(): Promise<void> {
  if (!vault || chosen.value === '' || !understood.value) return;
  busy.value = true;
  error.value = '';
  try {
    const result = await vault.create(chosen.value, remember.value, props.syncPassphrase ?? null);
    if (result.kind === 'ok') emit('created');
    else error.value = vaultWriteMessage(result);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section v-if="vault" class="vault-card" aria-labelledby="vault-setup-title" data-testid="vault-setup">
    <h2 id="vault-setup-title" class="vault-title">Create your vault passphrase</h2>
    <p class="vault-body">
      Your SSH keys and host passwords are encrypted on this device with this passphrase before they reach your
      account. One passphrase unlocks your keys and your host list on every device.
    </p>
    <form class="vault-form" @submit.prevent="create">
      <fieldset v-if="canReuse" class="vault-choice">
        <legend>Passphrase</legend>
        <label class="vault-radio">
          <input v-model="reuse" type="radio" value="new" name="vault-setup-reuse" />
          <span>Choose a new vault passphrase</span>
        </label>
        <label class="vault-radio">
          <input v-model="reuse" type="radio" value="sync" name="vault-setup-reuse" data-testid="vault-setup-reuse" />
          <span>Keep using my sync passphrase</span>
        </label>
      </fieldset>
      <VaultPassphraseFields v-if="!canReuse || reuse === 'new'" id-prefix="vault-setup" @update:valid="fresh = $event" />
      <p class="vault-note" data-testid="vault-setup-warning">
        <strong>{{ VAULT_TEXT.unrecoverable }}</strong>
        PocketShell never sees this passphrase and cannot reset it for you.
      </p>
      <label class="vault-radio">
        <input v-model="understood" type="checkbox" data-testid="vault-setup-understood" />
        <span>I understand that a forgotten passphrase means uploading my keys again</span>
      </label>
      <fieldset v-if="vault.canRemember" class="vault-choice">
        <legend>On this device</legend>
        <label class="vault-radio">
          <input v-model="remember" type="radio" :value="false" name="vault-setup-remember" />
          <span>Type it every time</span>
        </label>
        <label class="vault-radio">
          <input v-model="remember" type="radio" :value="true" name="vault-setup-remember" />
          <span>Remember on this device</span>
        </label>
      </fieldset>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <div class="vault-actions">
        <button
          class="vault-btn primary"
          type="submit"
          data-testid="vault-setup-create"
          :disabled="busy || chosen === '' || !understood"
        >
          {{ busy ? 'Creating the vault…' : 'Create vault' }}
        </button>
      </div>
    </form>
  </section>
</template>
