<script setup lang="ts">
// A new vault passphrase, entered twice, with a strength meter (setup, change,
// reset). Emits the passphrase once it is long enough and both entries match,
// else ''. The meter only guides; the length floor is the one hard rule.
import { computed, ref, watch } from 'vue';
import { passphraseStrength, VAULT_PASSPHRASE_MIN_LENGTH } from '../../keyVault';
import './vault.css';

const props = defineProps<{ idPrefix: string; label?: string }>();
const emit = defineEmits<{ 'update:valid': [passphrase: string] }>();

const first = ref('');
const second = ref('');
const strength = computed(() => passphraseStrength(first.value));
const mismatch = computed(() => second.value !== '' && first.value !== second.value);
watch([first, second], () => {
  emit('update:valid', first.value.length >= VAULT_PASSPHRASE_MIN_LENGTH && first.value === second.value ? first.value : '');
});
defineExpose({
  clear() {
    first.value = '';
    second.value = '';
  },
});
</script>

<template>
  <div class="vault-form newpass">
    <label class="vault-field">
      {{ props.label ?? 'New vault passphrase' }}
      <input
        v-model="first"
        :data-testid="`${props.idPrefix}-new`"
        type="password"
        autocomplete="new-password"
        autocapitalize="off"
        :aria-describedby="`${props.idPrefix}-meter`"
      />
    </label>
    <div :id="`${props.idPrefix}-meter`" class="meter" aria-live="polite" data-testid="vault-strength">
      <span class="bars" aria-hidden="true">
        <span v-for="n in 4" :key="n" :class="['bar', strength.score >= n ? `on s${strength.score}` : '']" />
      </span>
      <span>
        {{
          first === ''
            ? `At least ${VAULT_PASSPHRASE_MIN_LENGTH} characters. A few unrelated words work well.`
            : `Strength: ${strength.label}`
        }}
      </span>
    </div>
    <label class="vault-field">
      Type it again
      <input
        v-model="second"
        :data-testid="`${props.idPrefix}-again`"
        type="password"
        autocomplete="new-password"
        autocapitalize="off"
        :aria-invalid="mismatch ? 'true' : undefined"
      />
    </label>
    <p v-if="mismatch" class="error" role="alert">The two passphrases don't match.</p>
  </div>
</template>

<style scoped>
.newpass {
  gap: var(--sp-2);
}
.meter {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  color: var(--fg-secondary);
  font-size: var(--fs-200);
}
.bars {
  display: inline-flex;
  gap: 3px;
}
.bar {
  width: 22px;
  height: 4px;
  border-radius: 2px;
  background: var(--border);
}
.bar.on.s1 {
  background: var(--error);
}
.bar.on.s2 {
  background: var(--warning);
}
.bar.on.s3,
.bar.on.s4 {
  background: var(--success);
}
</style>
