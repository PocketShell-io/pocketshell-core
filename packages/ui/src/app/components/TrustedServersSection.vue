<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { trustedHostSlot, type HostEntry, type TrustedHostRecord } from '@pocketshell/core';
import { useKeyVault } from '../keyVault';
import { useSyncStore } from '../stores/sync';
import { clearCachedServers, readCachedServers, writeCachedServers, type CachedServer } from '../trustedServersCache';

defineProps<{ busy?: boolean }>();
const emit = defineEmits<{ connect: [host: HostEntry]; local: []; loaded: [scope: { accountId: string; vaultId: string; epoch: number; aliases: string[] } | null] }>();
const vault = useKeyVault();
const sync = useSyncStore();
const loading = ref(false);
const error = ref('');
const servers = ref<Array<TrustedHostRecord | CachedServer>>([]);
// True while `servers` is the cached last-known list, not yet confirmed by the vault.
const stale = ref(false);
let cachedAccount: string | null = null;
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

function clearServers(): void {
  servers.value = [];
  stale.value = false;
  cachedAccount = null;
}

/** Paint the last-known list for the remembered email; the refresh confirms or replaces it. */
function seedFromCache(): void {
  if (localOnly.value || !sync.status?.loggedIn) return;
  const cached = readCachedServers(sync.status.email);
  if (!cached) return;
  servers.value = cached.servers;
  cachedAccount = cached.accountId;
  stale.value = true;
}

async function load(): Promise<void> {
  const seq = ++generation;
  emit('loaded', null);
  error.value = '';
  if (localOnly.value || !verifiedAccount.value || !vault?.platform.accountId || !vault.platform.trustedHostRevisions || !vault.platform.installTrustedHost) { clearServers(); return; }
  // Keep showing the cached rows (marked stale) while refreshing.
  if (!stale.value) servers.value = [];
  loading.value = true;
  try {
    const account = await vault.platform.accountId();
    if (!alive || seq !== generation) return;
    if (!account || account !== verifiedAccount.value) { clearServers(); return; }
    const vaultId = vault.store.vaultId;
    const epoch = vault.store.epoch;
    if (!vaultId || epoch === null || !unlocked.value) return;
    const floors = await vault.platform.trustedHostRevisions.load(account,vaultId);
    const hosts = await vault.store.listTrustedHosts(account,floors);
    if (!alive || seq !== generation || !unlocked.value) return;
    // Persist every accepted revision, including revocation tombstones.
    for (const host of hosts) {
      await vault.platform.trustedHostRevisions.save(account,vaultId,await trustedHostSlot(host),host.revision);
    }
    const currentAccount = await vault.platform.accountId();
    if (!alive || seq !== generation || currentAccount !== account || !unlocked.value
      || vault.store.vaultId !== vaultId || vault.store.epoch !== epoch) return;
    servers.value = hosts.filter(host => host.status === 'active');
    stale.value = false;
    cachedAccount = account;
    writeCachedServers(sync.status?.email,account,hosts);
    emit('loaded', { accountId: account, vaultId, epoch, aliases: hosts.map(host => host.hostAlias) });
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
      if (!current()) return;
      if (!accountId) { clearServers(); clearCachedServers(); return; }
      const probe = unlocked.value ? null : await vault.store.probe();
      if (probe?.kind === 'error') throw new Error(probe.message);
      prepared = {accountId, state: unlocked.value ? 'unlocked' : probe?.kind === 'noVault' ? 'absent' : 'locked'};
    }
    if (!current()) return;
    if (!prepared?.accountId) { clearServers(); clearCachedServers(); return; }
    // The cached rows belong to the account that was signed in last time; if
    // the verified subject differs they must not survive a single frame more.
    if (cachedAccount !== null && cachedAccount !== prepared.accountId) { clearServers(); clearCachedServers(); }
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
  clearServers();
  clearCachedServers();
  emit('loaded', null);
  loading.value = false;
  error.value = '';
  vault?.cancelUnlock();
  vault?.lock();
  emit('local');
}

async function connect(server: TrustedHostRecord | CachedServer): Promise<void> {
  if (!vault?.platform.accountId || !vault.platform.installTrustedHost || !vault.platform.trustedHostRevisions) return;
  if (connecting.value) return;
  connecting.value = true;
  error.value = '';
  try {
    // A cached row can be tapped before the background refresh has verified
    // the account/unlocked the vault: wait for that one operation, then
    // continue only if it really verified.
    if (stale.value && entryTask) await entryTask;
    if (!verifiedAccount.value || !unlocked.value) throw new Error('Sign in and unlock your vault again.');
    const seq = generation;
    const valid = () => alive && !localOnly.value && verifiedAccount.value === server.accountId && generation === seq && unlocked.value && vault.store.vaultId === server.vaultId && vault.store.epoch === server.epoch;
    // No identity round trip up front: the vault reads below only use the
    // row's own account as a lookup key and persist nothing; the pre-install
    // fence verifies the live account before anything is saved or installed.
    const account = server.accountId;
    const floors = await vault.platform.trustedHostRevisions.load(account,server.vaultId);
    const latest = await vault.store.getTrustedHost(account,server,floors[await trustedHostSlot(server)] ?? server.revision);
    if (latest.kind !== 'ok' || latest.host.status !== 'active') throw new Error('This server is no longer authorized.');
    // Fence immediately before anything is persisted or installed: valid() is
    // local state only, so an account change during the vault reads is caught
    // here, before account A's host reaches the native trust store.
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
    clearServers(); emit('loaded', null); loading.value = false; verifiedAccount.value = null;
    if (signedIn) seedFromCache(); else clearCachedServers();
    if (attemptedAccount !== null) {vault?.cancelUnlock(); vault?.lock();}
    entryTask = null; authPending.value = false;
    attemptedAccount = null;
  }
  if (signedIn && !busy && !localOnly.value && key !== attemptedAccount) {
    attemptedAccount = key;
    void enterAccount();
  }
}, {immediate:true});
watch(unlocked, (isUnlocked) => {generation++;if(!stale.value) servers.value=[];emit('loaded', null);loading.value=false;if(isUnlocked && !sync.busy && verifiedAccount.value && !entryTask) void load();});
onBeforeUnmount(() => {alive = false; generation++; entryGeneration++; vault?.cancelUnlock();});
</script>

<template>
  <section class="trusted-servers" data-testid="trusted-servers">
    <h2>{{localOnly ? 'SSH without an account' : 'Your servers'}}</h2>
    <template v-if="stale && servers.length">
      <!-- Last-known list, painted before the vault refresh finishes (#3137). -->
      <ul class="server-list" data-testid="trusted-servers-stale">
        <li v-for="server in servers" :key="server.deviceId">
          <button class="server-row" :disabled="busy || connecting" data-testid="trusted-server-connect" @click="connect(server)">{{server.hostAlias}}</button>
        </li>
      </ul>
      <p v-if="authPending || loading" class="muted refreshing" role="status" data-testid="servers-refreshing">{{verifiedAccount ? 'Refreshing…' : 'Checking your Google account…'}}</p>
      <button v-else-if="verifiedAccount && !unlocked" class="btn" data-testid="server-vault-unlock" @click="enterAccount">{{needsSetup ? 'Create your vault' : 'Unlock your vault'}}</button>
    </template>
    <p v-else-if="authPending" class="muted" role="status">{{verifiedAccount ? 'Unlocking your vault…' : 'Checking your Google account…'}}</p>
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
.refreshing {font-size:var(--fs-sm,12px);opacity:.7}
.server-list {list-style:none;padding:0;display:grid;gap:var(--space-2,8px)}
.server-row {width:100%;text-align:left;padding:var(--space-3,12px);color:var(--fg);background:var(--surface);border:1px solid var(--border);border-radius:var(--r-sm);cursor:pointer;min-height:48px}
</style>
