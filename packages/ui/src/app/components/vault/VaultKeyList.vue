<script setup lang="ts">
// The keys and passwords in the vault, where each is used, and their actions:
// copy public key, rename, delete (confirmed), and — where the platform can
// upload (`canUpload`) — add a key or password and rotate a key. Elsewhere the
// list is read-only. Renders nothing while the vault is locked.
import { computed, ref } from 'vue';
import type { VaultKeyEntry } from '@pocketshell/core';
import { useKeyVault, vaultWriteMessage } from '../../keyVault';
import VaultKeyUpload from './VaultKeyUpload.vue';
import './vault.css';

const vault = useKeyVault();
const adding = ref<'none' | 'key' | 'password'>('none');
const rotating = ref<VaultKeyEntry | null>(null);
const renaming = ref<string | null>(null);
const renameDraft = ref('');
const deleting = ref<VaultKeyEntry | null>(null);
const passwordDraft = ref('');
const passwordName = ref('');
const notice = ref('');
const error = ref('');
const copied = ref('');

const entries = computed(() => vault?.view.keys ?? []);
const usedBy = computed(() => {
  const out: Record<string, string[]> = {};
  for (const [host, binding] of Object.entries(vault?.view.bindings ?? {})) (out[binding.keyId] ??= []).push(host);
  return out;
});

function say(message: string): void {
  notice.value = message;
  error.value = '';
}

async function write(run: () => Promise<{ kind: string; message?: string }>, done: () => void): Promise<void> {
  error.value = '';
  const result = await run();
  if (result.kind === 'ok') done();
  else error.value = vaultWriteMessage(result);
}

function onAdded(entry: VaultKeyEntry, deduplicated: boolean): void {
  adding.value = 'none';
  say(deduplicated ? `${entry.name} was already in your vault.` : `${entry.name} added to your vault.`);
}

function onRotated(entry: VaultKeyEntry): void {
  const old = rotating.value;
  rotating.value = null;
  say(`Replaced ${old?.name ?? 'the key'} with ${entry.name}. Every host that used it now uses the new key.`);
}

async function addPassword(): Promise<void> {
  if (!vault || passwordDraft.value === '') return;
  const name = passwordName.value.trim() || 'Password';
  await write(
    () => vault.store.addPassword(passwordDraft.value, name),
    () => {
      passwordDraft.value = '';
      passwordName.value = '';
      adding.value = 'none';
      say(`${name} added to your vault.`);
    },
  );
}

async function saveRename(entry: VaultKeyEntry): Promise<void> {
  if (!vault) return;
  await write(() => vault.store.renameKey(entry.keyId, renameDraft.value.trim() || entry.name), () => (renaming.value = null));
}

async function confirmDelete(): Promise<void> {
  const entry = deleting.value;
  if (!vault || !entry) return;
  await write(
    () => vault.store.removeKey(entry.keyId),
    () => {
      deleting.value = null;
      say(`${entry.name} deleted from your vault.`);
    },
  );
}

async function copyPublic(entry: VaultKeyEntry): Promise<void> {
  if (!vault) return;
  try {
    if (!(await vault.copyPublicKey(entry.keyId))) throw new Error('The public key is not available for this entry.');
    copied.value = entry.keyId;
    setTimeout(() => (copied.value = ''), 2000);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function added(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
}
</script>

<template>
  <section v-if="vault && vault.view.state === 'unlocked'" class="vault-form" aria-label="Keys in your vault" data-testid="vault-key-list">
    <div class="list-head">
      <span class="muted">{{ entries.length === 0 ? 'Your vault is empty.' : `${entries.length} in your vault` }}</span>
      <div v-if="vault.canUpload" class="vault-actions">
        <button class="vault-btn" type="button" data-testid="vault-add-password" @click="adding = 'password'">Add password</button>
        <button class="vault-btn primary" type="button" data-testid="vault-add-key" @click="adding = 'key'">Add key</button>
      </div>
    </div>
    <p v-if="notice" class="muted" role="status">{{ notice }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <div v-if="adding === 'key'" class="panel">
      <p class="vault-body">
        Read on this device and sealed with your vault passphrase before it is uploaded. If the key has its own
        passphrase you'll be asked for it once.
      </p>
      <VaultKeyUpload id-prefix="vault-add" @added="onAdded" @cancel="adding = 'none'" />
    </div>
    <form v-if="adding === 'password'" class="panel vault-form" @submit.prevent="addPassword">
      <label class="vault-field">
        Password
        <input v-model="passwordDraft" data-testid="vault-password-value" type="password" autocomplete="new-password" />
      </label>
      <label class="vault-field">
        Name
        <input v-model="passwordName" data-testid="vault-password-name" autocomplete="off" placeholder="e.g. prod-box password" />
      </label>
      <div class="vault-actions">
        <button class="vault-btn" type="button" @click="adding = 'none'">Cancel</button>
        <button class="vault-btn primary" type="submit" :disabled="passwordDraft === ''">Add to vault</button>
      </div>
    </form>

    <ul class="rows">
      <li v-for="entry in entries" :key="entry.keyId" class="row" :data-testid="`vault-entry-${entry.keyId}`">
        <div class="text">
          <div v-if="renaming !== entry.keyId" class="name">{{ entry.name }}</div>
          <form v-else class="rename" @submit.prevent="saveRename(entry)">
            <label class="vault-sr-only" :for="`vault-rename-${entry.keyId}`">Name</label>
            <input :id="`vault-rename-${entry.keyId}`" v-model="renameDraft" autocomplete="off" />
            <button class="vault-btn primary" type="submit">Save</button>
            <button class="vault-btn" type="button" @click="renaming = null">Cancel</button>
          </form>
          <div class="meta">
            {{ entry.type === 'password' ? 'password' : entry.type }}
            <template v-if="entry.fingerprint"> · <span class="vault-mono">{{ entry.fingerprint }}</span></template>
            <template v-if="added(entry.createdAt)"> · added {{ added(entry.createdAt) }}</template>
          </div>
          <div class="meta">
            {{ usedBy[entry.keyId]?.length ? `Used by ${usedBy[entry.keyId]!.join(', ')}` : 'Not used by any host' }}
          </div>
          <div v-if="deleting?.keyId === entry.keyId" class="panel" role="alertdialog" :aria-labelledby="`vault-del-${entry.keyId}`">
            <p :id="`vault-del-${entry.keyId}`" class="vault-body">
              Delete {{ entry.name }} from your vault on every device?
              <template v-if="usedBy[entry.keyId]?.length">{{ usedBy[entry.keyId]!.join(', ') }} will need another key.</template>
            </p>
            <div class="vault-actions">
              <button class="vault-btn" type="button" @click="deleting = null">Keep it</button>
              <button class="vault-btn danger" type="button" data-testid="vault-delete-confirm" @click="confirmDelete">Delete</button>
            </div>
          </div>
          <div v-if="rotating?.keyId === entry.keyId" class="panel">
            <p class="vault-body">
              Upload the replacement key. Every host using {{ entry.name }} switches to it, and {{ entry.name }} is
              deleted. Add the new public key to those servers first.
            </p>
            <VaultKeyUpload :id-prefix="`vault-rot-${entry.keyId}`" :rotate-from="entry" @added="onRotated" @cancel="rotating = null" />
          </div>
        </div>
        <div class="row-actions">
          <button v-if="entry.type !== 'password'" class="btn-ghost" type="button" @click="copyPublic(entry)">
            {{ copied === entry.keyId ? 'Copied' : 'Copy public key' }}
          </button>
          <button class="btn-ghost" type="button" @click="renaming = entry.keyId; renameDraft = entry.name">Rename</button>
          <button v-if="vault.canUpload && entry.type !== 'password'" class="btn-ghost" type="button" @click="rotating = entry">Rotate</button>
          <button class="btn-ghost" type="button" :data-testid="`vault-delete-${entry.keyId}`" @click="deleting = entry">Delete</button>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.list-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}
.panel {
  padding: var(--sp-3);
  background: var(--surface-2);
  border-radius: var(--r-md);
}
.rows {
  margin: 0;
  padding: 0;
  list-style: none;
}
.row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
  padding: var(--sp-3) 0;
  border-top: 1px solid var(--border);
}
.text {
  flex: 1 1 240px;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  min-width: 0;
}
.name {
  font-weight: var(--fw-semibold);
}
.meta {
  color: var(--fg-secondary);
  font-size: var(--fs-200);
  overflow-wrap: anywhere;
}
.rename {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}
.rename input {
  flex: 1 1 160px;
  min-width: 0;
  min-height: var(--control-h);
  padding: 0 var(--sp-2);
  background: var(--surface-2);
  color: var(--fg);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  font: inherit;
}
.row-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: var(--sp-1);
}
@media (pointer: coarse) {
  .row-actions .btn-ghost {
    min-height: 48px;
  }
}
</style>
