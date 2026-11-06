<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { trustedHostSlot, type HostEntry, type TrustedHostRecord } from '@pocketshell/core';
import { useKeyVault } from '../keyVault';
import { useSyncStore } from '../stores/sync';

defineProps<{ busy?: boolean }>();
const emit = defineEmits<{ connect: [host: HostEntry]; local: [] }>();
const vault = useKeyVault();
const sync = useSyncStore();
const loading = ref(false);
const error = ref('');
const servers = ref<TrustedHostRecord[]>([]);
const connecting = ref(false);
const authPending = ref(false);
const localOnly = computed({get:()=>vault?.view.localOnly === true,set:(value:boolean)=>{if(vault) vault.view.localOnly=value;}});
const verifiedAccount = ref<string | null>(null);
const needsSetup = ref(false);
const unlocked = computed(() => vault?.view.state === 'unlocked');
let generation = 0;
let alive = true;
let entryGeneration = 0;
let entryTask: Promise<void> | null = null;
let attemptedAccount: string | null = null;

async function load(): Promise<void> {
  const seq = ++generation;
  servers.value = [];
  error.value = '';
  if (localOnly.value || !verifiedAccount.value || !vault?.platform.accountId || !vault.platform.trustedHostRevisions || !vault.platform.installTrustedHost) return;
  loading.value = true;
  try {
    const account = await vault.platform.accountId();
    if (!account || account !== verifiedAccount.value || !alive || seq !== generation) return;
    const vaultId = vault.store.vaultId;
    if (!vaultId || !unlocked.value) return;
    const floors = await vault.platform.trustedHostRevisions.load(account,vaultId);
    const hosts = await vault.store.listTrustedHosts(account,floors);
    if (!alive || seq !== generation || !unlocked.value || await vault.platform.accountId() !== account) return;
    // Persist every accepted revision, including revocation tombstones.
    for (const host of hosts) {
      await vault.platform.trustedHostRevisions.save(account,vaultId,await trustedHostSlot(host),host.revision);
    }
    if (!alive || seq !== generation || await vault.platform.accountId() !== account) return;
    servers.value = hosts.filter(host => host.status === 'active');
  } catch (e) { if (seq === generation) error.value = (e as Error).message; }
  finally { if (seq === generation) loading.value = false; }
}

function enterAccount(): Promise<void> {
  if (entryTask) return entryTask;
  const seq = entryGeneration;
  const current = () => alive && seq === entryGeneration && !localOnly.value && sync.status?.loggedIn === true;
  authPending.value = true;
  error.value = '';
  const pending = (async () => {
    if (!vault || !current()) return;
    // A remembered email is not authorization. The platform verifies the
    // actual subject before probing, recalling or asking for vault secrets.
    let prepared;
    if (vault.platform.prepareAccount) prepared = await vault.platform.prepareAccount();
    else {
      const accountId = await vault.platform.accountId?.();
      if (!accountId || !current()) return;
      const probe = unlocked.value ? null : await vault.store.probe();
      if (probe?.kind === 'error') throw new Error(probe.message);
      prepared = {accountId, state: unlocked.value ? 'unlocked' : probe?.kind === 'noVault' ? 'absent' : 'locked'};
    }
    if (!current() || !prepared?.accountId) return;
    verifiedAccount.value = prepared.accountId;
    needsSetup.value = prepared.state === 'absent';
    const ready = prepared.state === 'unlocked' || await (needsSetup.value
      ? vault.requestSetup() : vault.requestUnlock('account'));
    if (ready && current() && await vault.platform.accountId?.() === prepared.accountId) await load();
  })().catch(e => {
    if (current()) error.value = (e as Error).message;
  }).finally(() => {
    if (entryTask === pending) {entryTask = null; authPending.value = false;}
  });
  entryTask = pending;
  return pending;
}

async function unlock(): Promise<void> {
  if (authPending.value || sync.busy) return;
  localOnly.value = false;
  if (!sync.status?.loggedIn || !verifiedAccount.value) {
    await sync.login();
    if (!alive || !sync.status?.loggedIn) return;
  }
  await enterAccount();
}

function useLocal(): void {
  localOnly.value = true;
  entryGeneration++;
  generation++;
  entryTask = null;
  authPending.value = false;
  verifiedAccount.value = null;
  servers.value = [];
  loading.value = false;
  error.value = '';
  vault?.cancelUnlock();
  vault?.lock();
  emit('local');
}

async function connect(server: TrustedHostRecord): Promise<void> {
  if (!vault?.platform.accountId || !vault.platform.installTrustedHost || !vault.platform.trustedHostRevisions) return;
  if (connecting.value) return;
  connecting.value = true;
  const seq = generation;
  error.value = '';
  try {
    const valid = () => alive && !localOnly.value && verifiedAccount.value === server.accountId && generation === seq && unlocked.value && vault.store.vaultId === server.vaultId && vault.store.epoch === server.epoch;
    const account = await vault.platform.accountId();
    if (account !== server.accountId || !valid()) throw new Error('Sign in and unlock your vault again.');
    const floors = await vault.platform.trustedHostRevisions.load(account,server.vaultId);
    const latest = await vault.store.getTrustedHost(account,server,floors[await trustedHostSlot(server)] ?? server.revision);
    if (latest.kind !== 'ok' || latest.host.status !== 'active') throw new Error('This server is no longer authorized.');
    if (!valid() || await vault.platform.accountId() !== account) throw new Error('Your account or vault changed. Sign in again.');
    await vault.platform.trustedHostRevisions.save(account,server.vaultId,await trustedHostSlot(server),latest.host.revision);
    await vault.platform.installTrustedHost(latest.host);
    if (await vault.platform.accountId() !== account || !valid()) throw new Error('Your account or vault changed. Sign in again.');
    emit('connect',{name:latest.host.hostAlias,hostname:latest.host.deviceId,user:latest.host.username,port:22,
      gateway:{serverUrl:latest.host.serverUrl,deviceId:latest.host.deviceId},gatewayAuth:'managed',
      identityFile:null,proxyJump:null,forwardAgent:false,localForwards:[],remoteForwards:[],fromConfig:false});
  } catch(e) { error.value = (e as Error).message; }
  finally {connecting.value = false;}
}

watch(() => [sync.status?.loggedIn,sync.status?.email,sync.busy] as const, ([signedIn,email,busy]) => {
  const key = signedIn ? email ?? '' : null;
  if (key !== attemptedAccount) {
    entryGeneration++; generation++;
    servers.value = []; loading.value = false; verifiedAccount.value = null;
    if (attemptedAccount !== null) {vault?.cancelUnlock(); vault?.lock();}
    entryTask = null; authPending.value = false;
    attemptedAccount = null;
  }
  if (signedIn && !busy && !localOnly.value && key !== attemptedAccount) {
    attemptedAccount = key;
    void enterAccount();
  }
}, {immediate:true});
watch(unlocked, (isUnlocked) => {generation++;servers.value=[];loading.value=false;if(isUnlocked && !sync.busy && verifiedAccount.value && !entryTask) void load();});
onBeforeUnmount(() => {alive = false; generation++; entryGeneration++; vault?.cancelUnlock();});
</script>

<template>
  <section class="trusted-servers" data-testid="trusted-servers">
    <h2>{{localOnly ? 'SSH without an account' : 'Your servers'}}</h2>
    <p v-if="authPending" class="muted" role="status">{{verifiedAccount ? 'Open your vault to continue.' : 'Checking your Google account…'}}</p>
    <template v-else-if="!verifiedAccount || localOnly">
      <p class="muted">Sign in to use your encrypted server list, or connect with SSH credentials kept on this device.</p>
      <button class="btn" :disabled="sync.busy" data-testid="server-google-login" @click="unlock">Sign in with Google</button>
    </template>
    <button v-else-if="!unlocked" class="btn" data-testid="server-vault-unlock" @click="enterAccount">{{needsSetup ? 'Create your vault' : 'Unlock your vault'}}</button>
    <p v-else-if="loading" class="muted">Loading your servers…</p>
    <template v-else>
      <ul class="server-list">
        <li v-for="server in servers" :key="server.deviceId">
          <button class="server-row" :disabled="busy || connecting" data-testid="trusted-server-connect" @click="connect(server)">{{server.hostAlias}}</button>
        </li>
      </ul>
      <p v-if="!servers.length && !error" class="muted">No servers registered to this vault yet. Register a server with PocketShell on that machine and enter this vault passphrase. Then refresh here.</p>
      <button class="btn-ghost" @click="load">Refresh servers</button>
    </template>
    <button v-if="!localOnly" class="btn-ghost" data-testid="server-use-local" @click="useLocal">Use SSH without an account</button>
    <p v-if="error" class="error" role="alert">{{error}}</p>
  </section>
</template>

<style scoped>
.server-list {list-style:none;padding:0;display:grid;gap:var(--space-2,8px)}
.server-row {width:100%;text-align:left;padding:var(--space-3,12px);color:var(--fg);background:var(--surface);border:1px solid var(--border);border-radius:var(--r-sm);cursor:pointer;min-height:48px}
</style>
