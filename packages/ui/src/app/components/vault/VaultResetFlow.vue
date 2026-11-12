<script setup lang="ts">
// Forgot passphrase / reset (design section 5): confirm it is you (a fresh
// account sign-in through the platform's `reauth`, or the `#reauth` slot for a
// sign-in button the platform renders itself), read what a reset loses, type
// RESET, choose a new passphrase. The vault is wiped, the epoch bumped, and a
// new empty vault created. Host bindings and the sync passphrase carry over
// when this device still knows them (unlocked); otherwise the sync passphrase
// is asked for and proved against the host list — or, "I forgot that too",
// the host list is deleted as well and a random sync passphrase replaces it.
// The new vault passphrase must differ from the sync passphrase.
import { computed, onMounted, ref } from 'vue';
import { useKeyVault, vaultWriteMessage } from '../../keyVault';
import VaultPassphraseFields from './VaultPassphraseFields.vue';
import './vault.css';

const props = defineProps<{
  /** The sync passphrase when the client knows it without the vault (e.g. the host list is open). */
  knownSyncPassphrase?: string | null;
}>();
const emit = defineEmits<{ done: []; cancel: [] }>();

const vault = useKeyVault();
const step = ref<'reauth' | 'confirm' | 'done'>(vault?.platform.reauth ? 'reauth' : 'confirm');
const reauthBusy = ref(false);
const reauthError = ref('');
const confirmText = ref('');
const newPassphrase = ref('');
const remember = ref(false);
const busy = ref(false);
const error = ref('');
const hostListExists = ref(false);

const unlockedSync = vault?.store.getSyncPassphrase() ?? null;
const knownSync = unlockedSync ?? props.knownSyncPassphrase ?? null;
const syncMode = ref<'known' | 'enter' | 'forgot'>(knownSync ? 'known' : 'enter');
const syncInput = ref('');
const carriedHosts = computed(() => (vault?.view.state === 'unlocked' ? Object.keys(vault.view.bindings).length : 0));

onMounted(async () => {
  try {
    hostListExists.value = (await vault?.platform.hostList?.exists()) ?? false;
  } catch {
    hostListExists.value = false;
  }
});

async function reauth(): Promise<void> {
  if (!vault?.platform.reauth) return;
  reauthBusy.value = true;
  reauthError.value = '';
  try {
    if (await vault.platform.reauth()) step.value = 'confirm';
    else reauthError.value = 'Sign-in was not completed. Try again.';
  } catch (err) {
    reauthError.value = err instanceof Error ? err.message : String(err);
  } finally {
    reauthBusy.value = false;
  }
}

const needsSyncInput = computed(() => syncMode.value === 'enter' && hostListExists.value);
const ready = computed(
  () => confirmText.value.trim() === 'RESET' && newPassphrase.value !== '' && (!needsSyncInput.value || syncInput.value !== ''),
);

async function runReset(): Promise<void> {
  if (!vault || !ready.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    let syncPassphrase: string | 'generate';
    let deleteHostList = false;
    if (syncMode.value === 'known' && knownSync) {
      syncPassphrase = knownSync;
    } else if (syncMode.value === 'forgot' || !hostListExists.value) {
      // No usable host list: a fresh random sync passphrase seals the next
      // one — never the vault passphrase (decision #7). The platform re-seals
      // its host list with store.getSyncPassphrase() after the reset.
      syncPassphrase = 'generate';
      deleteHostList = hostListExists.value;
    } else {
      if (vault.platform.hostList && !(await vault.platform.hostList.verifyPassphrase(syncInput.value))) {
        error.value = "That sync passphrase doesn't open your host list. Nothing was reset.";
        return;
      }
      syncPassphrase = syncInput.value;
    }
    const result = await vault.reset(newPassphrase.value, { syncPassphrase, remember: remember.value });
    if (result.kind !== 'ok') {
      error.value = vaultWriteMessage(result);
      if (result.kind === 'freshAuthRequired' && vault.platform.reauth) step.value = 'reauth';
      return;
    }
    if (deleteHostList) await vault.platform.hostList?.remove();
    step.value = 'done';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section v-if="vault" class="vault-form" aria-labelledby="vault-reset-title" data-testid="vault-reset">
    <h2 id="vault-reset-title" class="vault-title">Reset your vault</h2>
    <div class="vault-note">
      <p class="para">
        A forgotten vault passphrase cannot be recovered: nobody, PocketShell included, can decrypt your keys without
        it. Resetting <strong>deletes every key and password in your vault</strong> on every device and starts a new,
        empty vault with a new passphrase.
      </p>
      <p class="para">
        After the reset, upload your keys again from their files. Hosts keep their key assignments<template
          v-if="carriedHosts > 0"
        > ({{ carriedHosts }} carried over)</template>, so re-uploading the same key reattaches it.
      </p>
    </div>

    <div v-if="step === 'reauth'" class="vault-form" data-testid="vault-reset-reauth">
      <p class="vault-body">First, confirm it's you: sign in to your account again.</p>
      <slot name="reauth" :confirmed="() => (step = 'confirm')">
        <div class="vault-actions">
          <button class="vault-btn" type="button" @click="emit('cancel')">Cancel</button>
          <button class="vault-btn primary" type="button" data-testid="vault-reset-signin" :disabled="reauthBusy" @click="reauth">
            {{ reauthBusy ? 'Signing in…' : 'Sign in again' }}
          </button>
        </div>
      </slot>
      <p v-if="reauthError" class="error" role="alert">{{ reauthError }}</p>
    </div>

    <form v-else-if="step === 'confirm'" class="vault-form" @submit.prevent="runReset">
      <VaultPassphraseFields id-prefix="vault-reset" @update:valid="newPassphrase = $event" />
      <fieldset v-if="hostListExists && syncMode !== 'known'" class="vault-choice">
        <legend>Your host list is encrypted with your sync passphrase</legend>
        <label class="vault-radio">
          <input v-model="syncMode" type="radio" value="enter" name="vault-reset-sync" />
          <span>I know my sync passphrase</span>
        </label>
        <label v-if="syncMode === 'enter'" class="vault-field">
          Sync passphrase
          <input v-model="syncInput" data-testid="vault-reset-sync" type="password" autocomplete="off" autocapitalize="off" />
        </label>
        <label class="vault-radio">
          <input v-model="syncMode" type="radio" value="forgot" name="vault-reset-sync" data-testid="vault-reset-forgot-sync" />
          <span>I forgot that too: also delete my synced host list</span>
        </label>
      </fieldset>
      <fieldset v-if="vault.canRemember" class="vault-choice">
        <legend>On this device</legend>
        <label class="vault-radio">
          <input v-model="remember" type="radio" :value="false" name="vault-reset-remember" />
          <span>Type it every time</span>
        </label>
        <label class="vault-radio">
          <input v-model="remember" type="radio" :value="true" name="vault-reset-remember" />
          <span>Remember on this device</span>
        </label>
      </fieldset>
      <label class="vault-field">
        Type RESET to delete your vault's keys
        <input
          v-model="confirmText"
          data-testid="vault-reset-confirm"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
        />
      </label>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <div class="vault-actions">
        <button class="vault-btn" type="button" :disabled="busy" @click="emit('cancel')">Cancel</button>
        <button class="vault-btn danger" type="submit" data-testid="vault-reset-submit" :disabled="busy || !ready">
          {{ busy ? 'Resetting…' : 'Delete keys and reset the vault' }}
        </button>
      </div>
    </form>

    <div v-else class="vault-form" role="status" data-testid="vault-reset-done">
      <p class="vault-body">Your vault was reset. Upload your keys again; hosts that used them pick them up automatically.</p>
      <div class="vault-actions">
        <button class="vault-btn primary" type="button" @click="emit('done')">Done</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.para {
  margin: 0 0 var(--sp-2);
}
.para:last-child {
  margin: 0;
}
</style>
