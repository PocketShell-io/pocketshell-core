<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { trustedHostSlot, type HostEntry, type TrustedHostRecord } from '@pocketshell/core';
import { useKeyVault } from '../keyVault';
import { useSyncStore } from '../stores/sync';

defineProps<{ busy?: boolean }>();
const emit = defineEmits<{ connect: [host: HostEntry] }>();
const vault = useKeyVault();
const sync = useSyncStore();
const loading = ref(false);
const error = ref('');
const servers = ref<TrustedHostRecord[]>([]);
const connecting = ref(false);
const authPending = ref(false);
const unlocked = computed(() => vault?.view.state === 'unlocked');
let generation = 0;
let alive = true;
let promptedAccount: string | null = null;

async function load(): Promise<void> {
  const seq = ++generation;
  servers.value = [];
  error.value = '';
  if (!vault?.platform.accountId || !vault.platform.trustedHostRevisions || !vault.platform.installTrustedHost) return;
  loading.value = true;
  try {
    const account = await vault.platform.accountId();
    if (!account || !alive || seq !== generation) return;
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

async function unlock(): Promise<void> {
  if (authPending.value || sync.busy) return;
  authPending.value = true;
  error.value = '';
  try {
    if (!sync.status?.loggedIn) {await sync.login();return;}
    if (!sync.status?.loggedIn) return;
    if (await vault?.requestUnlock('account')) await load();
  } catch(e) { error.value = (e as Error).message; }
  finally {authPending.value = false;}
}

async function connect(server: TrustedHostRecord): Promise<void> {
  if (!vault?.platform.accountId || !vault.platform.installTrustedHost || !vault.platform.trustedHostRevisions) return;
  if (connecting.value) return;
  connecting.value = true;
  const seq = generation;
  error.value = '';
  try {
    const valid = () => alive && generation === seq && unlocked.value && vault.store.vaultId === server.vaultId && vault.store.epoch === server.epoch;
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
  generation++;
  servers.value = [];
  loading.value = false;
  if (!signedIn) promptedAccount = null;
  if (signedIn && !busy) {
    if (unlocked.value) void load();
    else if (email !== promptedAccount) {
      promptedAccount = email ?? '';
      void vault?.requestUnlock('account').then(ok => { if (ok && alive) void load(); }).catch(e=>{error.value=(e as Error).message;});
    }
  }
}, {immediate:true});
watch(unlocked, (isUnlocked) => {generation++;servers.value=[];loading.value=false;if(isUnlocked && !sync.busy) void load();});
onBeforeUnmount(() => {alive = false; generation++;});
</script>

<template>
  <section class="trusted-servers" data-testid="trusted-servers">
    <h2>Your servers</h2>
    <button v-if="!sync.status?.loggedIn" class="btn" :disabled="authPending || sync.busy" data-testid="server-google-login" @click="unlock">Sign in with Google</button>
    <button v-else-if="!unlocked" class="btn" data-testid="server-vault-unlock" @click="unlock">Unlock your vault</button>
    <p v-else-if="loading" class="muted">Loading your servers…</p>
    <template v-else>
      <ul class="server-list">
        <li v-for="server in servers" :key="server.deviceId">
          <button class="server-row" :disabled="busy || connecting" data-testid="trusted-server-connect" @click="connect(server)">{{server.hostAlias}}</button>
        </li>
      </ul>
      <p v-if="!servers.length && !error" class="muted">No servers registered to this vault yet.</p>
      <button class="btn-ghost" @click="load">Refresh servers</button>
    </template>
    <p v-if="error" class="error" role="alert">{{error}}</p>
  </section>
</template>

<style scoped>
.server-list {list-style:none;padding:0;display:grid;gap:var(--space-2,8px)}
.server-row {width:100%;text-align:left;padding:var(--space-3,12px);color:var(--fg);background:var(--surface);border:1px solid var(--border);border-radius:var(--r-sm);cursor:pointer;min-height:48px}
</style>
