<script setup lang="ts">
// The key-vault unlock sheet, mounted once in the shared AppRoot. A dial of a
// host whose credential is in the locked vault waits here (requestVaultUnlock)
// — never on a "pick a key" prompt — and so does "Unlock" from Settings or the
// keys list. Concurrent dials share one sheet. Inert on a client that has not
// provided a vault. Back / Esc cancels it (the shared dismiss layer).
import { computed, defineComponent } from 'vue';
import { keyVaultRef } from '../../keyVault';
import { useDismissLayer } from '../../extensions';
import VaultUnlockForm from './VaultUnlockForm.vue';
import VaultSetupCard from './VaultSetupCard.vue';
import './vault.css';

const vault = computed(() => keyVaultRef.value);
const title = computed(() => {
  const sheet = vault.value?.sheet;
  if (!sheet || sheet.reason !== 'connect') return 'Unlock your key vault';
  return sheet.hostLabel ? `Unlock your key vault to connect to ${sheet.hostLabel}` : 'Unlock your key vault to connect';
});

/** Registers the open sheet as the topmost dismiss layer. */
const DismissLayer = defineComponent({
  emits: ['close'],
  setup(_, { emit }) {
    useDismissLayer(() => emit('close'));
    return () => null;
  },
});
</script>

<template>
  <div v-if="vault?.sheet.open" :key="vault.sheet.seq" class="vault-scrim" data-testid="vault-unlock-gate">
    <DismissLayer @close="vault.cancelUnlock()" />
    <section v-if="vault.sheet.mode === 'create'" class="vault-setup-dialog" role="dialog" aria-modal="true" aria-labelledby="vault-setup-title">
      <VaultSetupCard />
      <button v-if="!vault.setup.offer" class="vault-btn" type="button" data-testid="vault-setup-cancel" @click="vault.cancelUnlock()">Cancel</button>
    </section>
    <section v-else class="vault-card" role="dialog" aria-modal="true" aria-labelledby="vault-unlock-title">
      <h2 id="vault-unlock-title" class="vault-title">{{ title }}</h2>
      <p class="vault-body">
        Your SSH keys are kept encrypted in your PocketShell account. Enter your vault passphrase to use them here.
      </p>
      <VaultUnlockForm id-prefix="vault-sheet">
        <template #actions>
          <button class="vault-btn" type="button" data-testid="vault-unlock-cancel" @click="vault.cancelUnlock()">
            Cancel
          </button>
        </template>
      </VaultUnlockForm>
    </section>
  </div>
</template>

<style scoped>
.vault-setup-dialog {width:min(480px,100%);max-height:100%;overflow-y:auto;}
.vault-scrim {
  /* The visible viewport, as HostKeyTrustGate: inset:0 would follow a widened layout viewport. */
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100dvh;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: calc(var(--sp-4) + var(--ps-inset-top)) calc(var(--sp-4) + var(--ps-inset-right))
    calc(var(--sp-4) + var(--ps-inset-bottom) + var(--ps-inset-keyboard)) calc(var(--sp-4) + var(--ps-inset-left));
  background: var(--scrim);
}
</style>
