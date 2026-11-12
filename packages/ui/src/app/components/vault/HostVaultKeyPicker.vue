<script setup lang="ts">
// Which vault key (or password) a host uses, and how the gateway path signs in
// to it (design section 7: host / managed / both). Presentational: v-model is
// the host's binding, null for "no vault credential". The caller saves it
// (KeyVaultController.bindHost with the ACCOUNT host alias).
import { computed } from 'vue';
import type { GatewayAuthPolicy, HostKeyBinding, VaultKeyEntry } from '@pocketshell/core';
import { GATEWAY_AUTH_CHOICES } from '../../keyVault';
import './vault.css';

const props = withDefaults(
  defineProps<{
    modelValue: HostKeyBinding | null;
    keys: readonly VaultKeyEntry[];
    idPrefix?: string;
    /** Show the gateway policy (hosts reached through the gateway). */
    showGatewayAuth?: boolean;
    disabled?: boolean;
  }>(),
  { idPrefix: 'host-vault-key', showGatewayAuth: true, disabled: false },
);
const emit = defineEmits<{ 'update:modelValue': [binding: HostKeyBinding | null] }>();

const keyId = computed(() => props.modelValue?.keyId ?? '');
const policy = computed<GatewayAuthPolicy>(() => props.modelValue?.gatewayAuth ?? 'both');
const missing = computed(() => keyId.value !== '' && !props.keys.some((entry) => entry.keyId === keyId.value));

function pickKey(next: string): void {
  emit('update:modelValue', next === '' ? null : { keyId: next, gatewayAuth: policy.value });
}

function pickPolicy(next: GatewayAuthPolicy): void {
  if (keyId.value === '') return;
  emit('update:modelValue', { keyId: keyId.value, gatewayAuth: next });
}
</script>

<template>
  <div class="vault-form" data-testid="host-vault-key-picker">
    <label class="vault-field">
      Vault credential
      <select
        :id="`${props.idPrefix}-key`"
        data-testid="host-vault-key-select"
        :value="keyId"
        :disabled="props.disabled"
        @change="pickKey(($event.target as HTMLSelectElement).value)"
      >
        <option value="">No vault credential</option>
        <option v-if="missing" :value="keyId">Missing key (upload it again to reattach)</option>
        <option v-for="entry in props.keys" :key="entry.keyId" :value="entry.keyId">
          {{ entry.name }} — {{ entry.type === 'password' ? 'password' : entry.type }}
        </option>
      </select>
    </label>
    <fieldset v-if="props.showGatewayAuth && keyId !== ''" class="vault-choice" :disabled="props.disabled">
      <legend>Through the gateway</legend>
      <label v-for="choice in GATEWAY_AUTH_CHOICES" :key="choice.value" class="vault-radio">
        <input
          type="radio"
          :name="`${props.idPrefix}-policy`"
          :value="choice.value"
          :checked="policy === choice.value"
          :data-testid="`host-vault-policy-${choice.value}`"
          @change="pickPolicy(choice.value)"
        />
        <span>{{ choice.label }}<small>{{ choice.detail }}</small></span>
      </label>
    </fieldset>
  </div>
</template>
