<script setup lang="ts">
// The vault's own settings, for a platform's `settings.sections`
// contribution: lock/unlock, this device (remember / forget), change
// passphrase, and reset. Renders nothing on a client without a vault.
import { ref } from 'vue';
import { useKeyVault } from '../../keyVault';
import VaultChangePassphrase from './VaultChangePassphrase.vue';
import VaultResetFlow from './VaultResetFlow.vue';
import './vault.css';

const vault = useKeyVault();
const panel = ref<'none' | 'change' | 'reset'>('none');
const notice = ref('');
const error = ref('');

async function guard(run: () => Promise<void>, message: string): Promise<void> {
  error.value = '';
  try {
    await run();
    notice.value = message;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}
</script>

<template>
  <div v-if="vault" class="vault-form" data-testid="vault-settings">
    <p v-if="notice" class="muted" role="status">{{ notice }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="setting">
      <div>
        <div class="name">Key vault</div>
        <div class="meta">{{ vault.view.state === 'unlocked' ? 'Unlocked on this device.' : 'Locked.' }}</div>
      </div>
      <button
        v-if="vault.view.state === 'unlocked'"
        class="vault-btn"
        type="button"
        data-testid="vault-lock"
        @click="vault.lock(); notice = 'Vault locked. Your keys are no longer in memory here.'"
      >
        Lock vault
      </button>
      <button v-else class="vault-btn primary" type="button" data-testid="vault-unlock" @click="vault.requestUnlock('account')">
        Unlock
      </button>
    </div>
    <div v-if="vault.canRemember" class="setting">
      <div>
        <div class="name">This device</div>
        <div class="meta">
          {{ vault.view.remembered ? 'Remembers your vault: unlocks without the passphrase.' : 'Asks for the passphrase every time.' }}
        </div>
      </div>
      <button
        v-if="vault.view.remembered"
        class="vault-btn"
        type="button"
        data-testid="vault-forget-device"
        @click="guard(() => vault!.forgetDevice(), 'This device no longer remembers your vault.')"
      >
        Forget on this device
      </button>
      <button
        v-else-if="vault.view.state === 'unlocked'"
        class="vault-btn"
        type="button"
        data-testid="vault-remember-device"
        @click="guard(() => vault!.rememberNow(), 'This device now remembers your vault.')"
      >
        Remember on this device
      </button>
    </div>
    <div v-if="vault.view.state === 'unlocked'" class="setting">
      <div>
        <div class="name">Passphrase</div>
        <div class="meta">Changing it keeps your keys.</div>
      </div>
      <button v-if="panel !== 'change'" class="vault-btn" type="button" data-testid="vault-change-open" @click="panel = 'change'">
        Change passphrase
      </button>
    </div>
    <VaultChangePassphrase
      v-if="panel === 'change'"
      @changed="(pending: boolean) => { panel = 'none'; notice = pending ? 'Vault passphrase changed. The server will be updated the next time you unlock.' : 'Vault passphrase changed.'; }"
      @cancel="panel = 'none'"
    />
    <div v-if="vault.platform.reauth || vault.platform.onForgot" class="setting">
      <div>
        <div class="name">Reset</div>
        <div class="meta">Forgot the passphrase? Start a new, empty vault.</div>
      </div>
      <button v-if="panel !== 'reset'" class="vault-btn" type="button" data-testid="vault-reset-open" @click="vault.platform.reauth ? (panel = 'reset') : vault.forgot()">
        Reset vault…
      </button>
    </div>
    <VaultResetFlow v-if="panel === 'reset'" @done="panel = 'none'" @cancel="panel = 'none'" />
  </div>
</template>

<style scoped>
.setting {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}
.name {
  font-weight: var(--fw-semibold);
}
.meta {
  color: var(--fg-secondary);
  font-size: var(--fs-200);
}
</style>
