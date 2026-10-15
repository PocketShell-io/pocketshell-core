<script setup lang="ts">
// First setup (design section 5, web): create the account's vault passphrase,
// entered twice with a strength meter, behind the plain "cannot be recovered"
// warning. One passphrase from then on: the vault also carries the sync
// passphrase (`syncPassphrase`, or a fresh random one for an account with no
// host list). The vault passphrase must differ from the sync passphrase
// (decision #7); one that equals it or opens the host list is refused.
import { ref } from 'vue';
import { useKeyVault, VAULT_TEXT, vaultWriteMessage } from '../../keyVault';
import VaultPassphraseFields from './VaultPassphraseFields.vue';
import './vault.css';

const props = defineProps<{
  /** The account's existing sync passphrase (when it has a host list), stored in the vault index. */
  syncPassphrase?: string | null;
}>();
const emit = defineEmits<{ created: [] }>();

const vault = useKeyVault();
const fresh = ref('');
const remember = ref(false);
const understood = ref(false);
const busy = ref(false);
const error = ref('');

async function create(): Promise<void> {
  if (!vault || fresh.value === '' || !understood.value) return;
  busy.value = true;
  error.value = '';
  try {
    const result = await vault.create(fresh.value, remember.value, props.syncPassphrase ?? null);
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
      <VaultPassphraseFields id-prefix="vault-setup" @update:valid="fresh = $event" />
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
          :disabled="busy || fresh === '' || !understood"
        >
          {{ busy ? 'Creating the vault…' : 'Create vault' }}
        </button>
      </div>
    </form>
  </section>
</template>
