<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue';
import { trustedHostSlot, type HostEntry, type TrustedHostRecord } from '@pocketshell/core';
import { useKeyVault } from '../keyVault';
import { useSyncStore } from '../stores/sync';
import { accountSyncState, describeSyncProblem, syncRetryDelay, type SyncProblem } from '../accountSyncState';
import {
  clearCachedServers, orderServers, readCachedServers, readCachedServersAnyAccount, writeCachedServers, type CachedServer,
} from '../trustedServersCache';

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
/** The row whose open is in progress (#3189): marked at once, whatever the background sync is doing. */
const pendingConnect = ref<string | null>(null);
const connectProblem = ref<{ deviceId: string; message: string; action: 'Unlock' | 'Sign in' | 'Retry' } | null>(null);
let connectSeq = 0;
const authPending = ref(false);
const localOnly = computed({get:()=>vault?.view.localOnly === true,set:(value:boolean)=>{if(vault) vault.view.localOnly=value;}});
const verifiedAccount = ref<string | null>(null);
const needsSetup = ref(false);
const unlocked = computed(() => vault?.view.state === 'unlocked');
/** The background sync failed quietly; the cached rows stay and it retries on its own (#3189). */
const syncIssue = ref<SyncProblem | null>(null);
/** The sign-in was lost (revoked, deleted, expired): the rows stay, a re-sign-in is offered (#3189). */
const reauth = ref(false);
const detailsCopied = ref(false);
let retryTimer: ReturnType<typeof setTimeout> | undefined;
/** The background identity check could not reach the backend; a vault load alone does not settle it. */
let identityUnchecked = false;
let retryAttempt = 0;
let generation = 0;
let alive = true;
let entryGeneration = 0;
let entryTask: Promise<void> | null = null;
let attemptedAccount: string | null = null;
/** The sign-in key the watcher last acted on; undefined until the status is known. */
let lastKey: string | null | undefined;

const showRows = computed(() => !localOnly.value && servers.value.length > 0
  && (stale.value || reauth.value || verifiedAccount.value !== null));

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

/**
 * The sign-in is gone but nobody chose to sign out (an explicit sign-out
 * clears the cache first): keep the saved rows on screen and offer to sign in
 * again. Nothing is deleted.
 */
function keepForReauth(): void {
  const cached = localOnly.value ? null : readCachedServersAnyAccount();
  if (!cached) { clearServers(); reauth.value = false; return; }
  if (!servers.value.length || cachedAccount !== cached.accountId) servers.value = cached.servers;
  cachedAccount = cached.accountId;
  stale.value = true;
  reauth.value = true;
}

function clearRetry(): void {
  if (retryTimer !== undefined) clearTimeout(retryTimer);
  retryTimer = undefined;
}

function resetSyncProblem(): void {
  clearRetry();
  retryAttempt = 0;
  syncIssue.value = null;
}

/**
 * A background failure never blocks: offline/timeout keeps the rows quietly and
 * retries with backoff; a lost sign-in keeps them behind the signed-out banner;
 * anything else (a server or account that failed verification) is an alert.
 */
function reportBackgroundProblem(e: unknown): void {
  const problem = describeSyncProblem(e);
  if (problem.kind === 'signedOut') {
    syncIssue.value = null;
    clearRetry();
    keepForReauth();
    return;
  }
  if (problem.kind === 'failed') {
    // Not a transient: the account or the servers could not be verified. Say
    // so where it can't be missed, and never keep rows that failed it.
    clearRetry();
    syncIssue.value = null;
    clearServers();
    error.value = problem.message;
    return;
  }
  syncIssue.value = problem;
  clearRetry();
  const delay = syncRetryDelay(retryAttempt++);
  retryTimer = setTimeout(() => { retryTimer = undefined; void retrySync(false); }, delay);
}

/**
 * Retry the background sync now. `prompt` is true only for the user's own tap
 * (Retry, the chip, a row): a timer, the network coming back or the app
 * returning to the front never opens a sheet by itself (#3189).
 */
function retrySync(prompt = true): Promise<void> {
  clearRetry();
  if (!alive || localOnly.value || !sync.status?.loggedIn || reauth.value) return Promise.resolve();
  if (entryTask) return entryTask;
  if (verifiedAccount.value && unlocked.value) { refreshIdentity(verifiedAccount.value); return load(); }
  attemptedAccount = sync.status.email ?? '';
  return enterAccount(prompt);
}

async function load(): Promise<void> {
  const seq = ++generation;
  emit('loaded', null);
  error.value = '';
  if (localOnly.value || !verifiedAccount.value || !vault?.platform.accountId || !vault.platform.trustedHostRevisions || !vault.platform.installTrustedHost) { clearServers(); return; }
  // Keep the rows the user already sees (cached or last loaded) while refreshing.
  const previousOrder = servers.value.map(server => server.deviceId);
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
    const ordered = orderServers(previousOrder, hosts.filter(host => host.status === 'active'));
    servers.value = ordered;
    stale.value = false;
    cachedAccount = account;
    if (!identityUnchecked) resetSyncProblem();
    writeCachedServers(sync.status?.email,account,ordered);
    emit('loaded', { accountId: account, vaultId, epoch, aliases: hosts.map(host => host.hostAlias) });
  } catch (e) { if (seq === generation && alive) reportBackgroundProblem(e); }
  finally { if (seq === generation) loading.value = false; }
}

/**
 * The backend's view of the signed-in account (GET /me), refreshed behind the rows (#3189): never awaited
 * by an open. A refused credential ends in the signed-out state; offline is the quiet retrying note.
 */
function refreshIdentity(account: string): void {
  const verify = vault?.platform.verifyAccount;
  if (!verify) return;
  const seq = entryGeneration;
  const current = () => alive && seq === entryGeneration && verifiedAccount.value === account;
  void verify().then((verified) => {
    if (!current()) return;
    if (verified === account) {
      if (identityUnchecked) { identityUnchecked = false; if (!loading.value) resetSyncProblem(); }
      return;
    }
    // No account, or a different subject than the credential claims: never open as it.
    if (verified !== null) { clearServers(); clearCachedServers(); }
    verifiedAccount.value = null;
    keepForReauth();
  }, (e: unknown) => {
    if (!current()) return;
    if (describeSyncProblem(e).kind === 'offline') identityUnchecked = true;
    reportBackgroundProblem(e);
  });
}

/** The user's Refresh: the list and, behind it, the backend's view of the account. */
function refreshNow(): Promise<void> {
  if (verifiedAccount.value) refreshIdentity(verifiedAccount.value);
  return load();
}

function enterAccount(prompt = true): Promise<void> {
  if (entryTask) return entryTask;
  const seq = entryGeneration;
  const current = () => alive && seq === entryGeneration && !localOnly.value && sync.status?.loggedIn === true;
  authPending.value = true;
  error.value = '';
  const pending = (async () => {
    if (!vault || !current()) return;
    // A remembered email is not authorization: the platform reads the
    // signed-in credential's own subject (locally, #3189). Every vault and
    // gateway request carries that credential, and a refused one (401) ends
    // the session; the backend's identity check runs behind, never before.
    let prepared;
    if (vault.platform.prepareAccount) prepared = await vault.platform.prepareAccount();
    else {
      const accountId = await vault.platform.accountId?.();
      if (!current()) return;
      if (!accountId) { keepForReauth(); return; }
      const probe = unlocked.value ? null : await vault.store.probe();
      if (probe?.kind === 'error') throw new Error(probe.message);
      prepared = {accountId, state: unlocked.value ? 'unlocked' : probe?.kind === 'noVault' ? 'absent' : 'locked'};
    }
    if (!current()) return;
    // No verified account behind a remembered sign-in: it was lost, not given up.
    if (!prepared?.accountId) { keepForReauth(); return; }
    // The cached rows belong to the account that was signed in last time; if
    // the verified subject differs they must not survive a single frame more.
    if (cachedAccount !== null && cachedAccount !== prepared.accountId) { clearServers(); clearCachedServers(); }
    verifiedAccount.value = prepared.accountId;
    reauth.value = false;
    refreshIdentity(prepared.accountId);
    needsSetup.value = prepared.state === 'absent';
    // A row tapped during preparation owns the prompt for its connection.
    // Let connect() check the prepared account before asking for that unlock.
    const ready = prepared.state === 'unlocked' || prompt && pendingConnect.value === null && await (needsSetup.value
      ? vault.requestSetup() : vault.requestUnlock('account'));
    if (ready && current() && await vault.platform.accountId?.() === prepared.accountId) await load();
  })().catch(e => {
    if (current()) reportBackgroundProblem(e);
  }).finally(() => {
    if (entryTask === pending) {entryTask = null; authPending.value = false;}
  });
  entryTask = pending;
  return pending;
}

async function unlock(): Promise<void> {
  if (authPending.value || sync.busy) return;
  localOnly.value = false;
  if (!sync.status?.loggedIn || reauth.value) {
    await sync.login();
    if (!alive || !sync.status?.loggedIn) return;
  }
  await enterAccount();
}

function useLocal(): void {
  localOnly.value = true;
  entryGeneration++;
  generation++;
  connectSeq++;
  pendingConnect.value = null;
  connectProblem.value = null;
  entryTask = null;
  authPending.value = false;
  verifiedAccount.value = null;
  reauth.value = false;
  identityUnchecked = false;
  resetSyncProblem();
  clearServers();
  clearCachedServers();
  emit('loaded', null);
  loading.value = false;
  error.value = '';
  vault?.cancelUnlock();
  vault?.lock();
  emit('local');
}

/** Keep the reason and the recovery action at the server that was tapped. */
function setConnectProblem(server: TrustedHostRecord | CachedServer, action: 'Unlock' | 'Sign in' | 'Retry', message: string): void {
  connectProblem.value = { deviceId: server.deviceId, action, message };
}

function reportConnectProblem(e: unknown, server: TrustedHostRecord | CachedServer): void {
  const problem = describeSyncProblem(e);
  if (problem.kind === 'signedOut') {
    keepForReauth();
    setConnectProblem(server, 'Sign in', problem.message);
    return;
  }
  setConnectProblem(server, 'Retry', problem.kind === 'offline'
    ? `Couldn't open ${server.hostAlias}: PocketShell sync can't be reached right now. Try again in a moment.`
    : problem.message);
}

function cancelConnect(): void {
  connectSeq++;
  pendingConnect.value = null;
}

async function connect(server: TrustedHostRecord | CachedServer): Promise<void> {
  if (!vault?.platform.accountId || !vault.platform.installTrustedHost || !vault.platform.trustedHostRevisions) return;
  if (pendingConnect.value !== null) return;
  // The row shows it is opening on this tap (#3189); the account check, the
  // vault and the descriptor re-read happen behind it, never before it.
  const attempt = ++connectSeq;
  pendingConnect.value = server.deviceId;
  connectProblem.value = null;
  error.value = '';
  const abandoned = () => !alive || attempt !== connectSeq;
  try {
    if (reauth.value || !sync.status?.loggedIn) {
      // A lost sign-in: the tap is the user's go-ahead to sign in again.
      await unlock();
    } else if (!entryTask && !verifiedAccount.value) {
      await retrySync(false);
    }
    // A cached row tapped before the background check finished joins that
    // one operation (and any restart of it), then continues only if it really verified.
    while (entryTask && !abandoned()) await entryTask;
    if (abandoned()) return;
    if (reauth.value || !sync.status?.loggedIn) {
      setConnectProblem(server, 'Sign in', "You're signed out.");
      return;
    }
    if (verifiedAccount.value !== server.accountId) {
      if (syncIssue.value) reportConnectProblem({code:'SYNC_NETWORK_FAILED',message:syncIssue.value.detail}, server);
      else setConnectProblem(server, 'Retry', `Couldn't verify the account for ${server.hostAlias}.`);
      return;
    }
    if (!unlocked.value && !await (needsSetup.value ? vault.requestSetup() : vault.requestUnlock('connect', server.hostAlias))) {
      if (!abandoned()) {
        if (reauth.value || !sync.status?.loggedIn) setConnectProblem(server, 'Sign in', "You're signed out.");
        else setConnectProblem(server, 'Unlock', 'Keys locked.');
      }
      return;
    }
    if (abandoned()) return;
    const seq = generation;
    const valid = () => !abandoned() && !localOnly.value && verifiedAccount.value === server.accountId && generation === seq && unlocked.value && vault.store.vaultId === server.vaultId && vault.store.epoch === server.epoch;
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
    if (abandoned()) return;
    emit('connect',{name:latest.host.hostAlias,hostname:latest.host.deviceId,user:latest.host.username,port:22,
      gateway:{serverUrl:latest.host.serverUrl,deviceId:latest.host.deviceId},gatewayAuth:'managed',
      identityFile:null,proxyJump:null,forwardAgent:false,localForwards:[],remoteForwards:[],fromConfig:false});
  } catch(e) { if (!abandoned()) reportConnectProblem(e, server); }
  finally { if (attempt === connectSeq) pendingConnect.value = null; }
}

async function copyDetails(): Promise<void> {
  const text = syncIssue.value?.detail ?? '';
  if (!text) return;
  try {
    await (globalThis as { navigator?: { clipboard?: { writeText(t: string): Promise<void> } } }).navigator?.clipboard?.writeText(text);
    detailsCopied.value = true;
  } catch { detailsCopied.value = false; }
}

watch(() => [sync.status?.loggedIn,sync.status?.email,sync.busy] as const, ([signedIn,email,busy]) => {
  if (!sync.status) {
    // The sign-in state is not known yet: paint the last-known rows anyway.
    if (lastKey === undefined && !servers.value.length && !localOnly.value) {
      const cached = readCachedServersAnyAccount();
      if (cached) { servers.value = cached.servers; cachedAccount = cached.accountId; stale.value = true; }
    }
    return;
  }
  const key = signedIn ? email ?? '' : null;
  if (key !== attemptedAccount || key !== lastKey) {
    entryGeneration++; generation++;
    emit('loaded', null); loading.value = false; verifiedAccount.value = null;
    identityUnchecked = false;
    resetSyncProblem();
    // Signed out without choosing to (an explicit sign-out clears the cache
    // first): the saved rows stay and a re-sign-in is offered (#3189).
    if (signedIn) { clearServers(); reauth.value = false; seedFromCache(); } else keepForReauth();
    if (attemptedAccount !== null) {vault?.cancelUnlock(); vault?.lock();}
    entryTask = null; authPending.value = false;
    attemptedAccount = null;
  }
  lastKey = key;
  if (signedIn && !busy && !localOnly.value && key !== attemptedAccount) {
    attemptedAccount = key;
    void enterAccount();
  }
}, {immediate:true});
watch(unlocked, (isUnlocked) => {generation++;emit('loaded', null);loading.value=false;if(isUnlocked && !sync.busy && verifiedAccount.value && !entryTask) void load();});
watchEffect(() => {
  accountSyncState.phase = localOnly.value || !sync.status?.loggedIn && !reauth.value ? 'idle'
    : reauth.value ? 'reauth'
      : syncIssue.value ? 'offline'
        : authPending.value || loading.value ? 'syncing'
          : verifiedAccount.value && unlocked.value ? 'synced' : 'idle';
  accountSyncState.detail = syncIssue.value?.detail ?? '';
});
/** Network back or the app in front again: retry a failed sync at once instead of waiting out the backoff. */
function onNetworkBack(): void { if (syncIssue.value) void retrySync(false); }
function onVisible(): void { if (globalThis.document?.visibilityState === 'visible') onNetworkBack(); }
onMounted(() => {
  accountSyncState.retry = () => { void retrySync(); };
  globalThis.addEventListener?.('online', onNetworkBack);
  globalThis.document?.addEventListener('visibilitychange', onVisible);
});
onBeforeUnmount(() => {
  alive = false; generation++; entryGeneration++; connectSeq++; clearRetry(); vault?.cancelUnlock();
  globalThis.removeEventListener?.('online', onNetworkBack);
  globalThis.document?.removeEventListener('visibilitychange', onVisible);
  accountSyncState.retry = null; accountSyncState.phase = 'idle'; accountSyncState.detail = '';
});
</script>

<template>
  <section class="trusted-servers" data-testid="trusted-servers" :data-sync-phase="accountSyncState.phase">
    <h2>{{localOnly ? 'SSH without an account' : 'Your servers'}}</h2>
    <!-- One list for cached, re-sign-in and verified rows (#3137, #3189): a
         background refresh never swaps it out or reorders it, and a tap opens
         the row at once whatever the account check is still doing. -->
    <ul v-if="showRows" class="server-list" :data-testid="stale ? 'trusted-servers-stale' : 'trusted-servers-list'">
      <li v-for="server in servers" :key="server.deviceId">
        <button
          class="server-row"
          :disabled="busy || (pendingConnect !== null && pendingConnect !== server.deviceId)"
          :aria-busy="pendingConnect === server.deviceId"
          :data-state="pendingConnect === server.deviceId ? 'connecting' : undefined"
          data-testid="trusted-server-connect"
          @click="connect(server)"
        >
          <span class="server-name">{{server.hostAlias}}</span>
          <span v-if="pendingConnect === server.deviceId" class="muted server-connecting" data-testid="trusted-server-connecting">connecting…</span>
        </button>
        <div v-if="connectProblem?.deviceId === server.deviceId" class="server-problem">
          <p class="error" role="alert" data-testid="trusted-server-error">{{connectProblem.message}}</p>
          <button
            class="btn-ghost"
            :disabled="busy || pendingConnect !== null"
            data-testid="trusted-server-action"
            @click="connect(server)"
          >{{connectProblem.action}}</button>
        </div>
      </li>
    </ul>
    <p v-if="error && showRows" class="error" role="alert">{{error}}</p>
    <p v-if="showRows && pendingConnect !== null" class="muted server-pending">
      <button class="btn-ghost" data-testid="trusted-server-cancel" @click="cancelConnect">Cancel</button>
    </p>
    <!-- A lost sign-in (#3189) is shown, never acted on: one non-blocking
         banner, and Google's sheet only opens from this tap. -->
    <p v-if="showRows && reauth" class="reauth-note" role="status" data-testid="server-reauth">
      <span>You're signed out —</span>
      <button class="btn" :disabled="sync.busy" data-testid="server-reauth-sign-in" @click="unlock">Sign in</button>
    </p>
    <template v-else-if="showRows">
      <button v-if="verifiedAccount && !unlocked && !authPending" class="btn" data-testid="server-vault-unlock" @click="enterAccount()">{{needsSetup ? 'Create your vault' : 'Unlock your vault'}}</button>
    </template>
    <template v-else>
      <p v-if="authPending" class="muted" role="status">{{verifiedAccount ? 'Unlocking your vault…' : 'Loading your servers…'}}</p>
      <template v-else-if="localOnly || (!verifiedAccount && !syncIssue)">
        <p class="muted">Sign in to use your encrypted server list, or connect with SSH credentials kept on this device.</p>
        <button class="btn" :disabled="sync.busy" data-testid="server-google-login" @click="unlock">Sign in with Google</button>
      </template>
      <button v-else-if="verifiedAccount && !unlocked" class="btn" data-testid="server-vault-unlock" @click="enterAccount()">{{needsSetup ? 'Create your vault' : 'Unlock your vault'}}</button>
      <p v-else-if="loading" class="muted">Loading your servers…</p>
      <p v-else-if="verifiedAccount && !servers.length && !error && !syncIssue" class="muted">No servers registered to this vault yet. Register a server with PocketShell on that machine and enter this vault passphrase. Then refresh here.</p>
    </template>
    <!-- Quiet and recoverable (#3189): plain words, retrying on its own; the
         raw failure is only behind Copy details. -->
    <p v-if="syncIssue && !localOnly" class="muted sync-issue" role="status" data-testid="servers-sync-issue">
      <span>{{syncIssue.message}}</span>
      <button class="btn-ghost" data-testid="servers-sync-retry" @click="retrySync()">Retry</button>
      <button class="btn-ghost" data-testid="servers-sync-copy" @click="copyDetails">{{detailsCopied ? 'Copied' : 'Copy details'}}</button>
    </p>
    <button v-if="verifiedAccount && unlocked && !localOnly && !syncIssue" class="btn-ghost" @click="refreshNow">Refresh servers</button>
    <button v-if="!localOnly" class="btn-ghost" data-testid="server-use-local" @click="useLocal">Use SSH without an account</button>
    <p v-if="error && !showRows" class="error" role="alert">{{error}}</p>
  </section>
</template>

<style scoped>
.server-list {list-style:none;padding:0;display:grid;gap:var(--space-2,8px)}
.server-row {width:100%;display:flex;align-items:center;justify-content:space-between;gap:var(--space-2,8px);text-align:left;padding:var(--space-3,12px);color:var(--fg);background:var(--surface);border:1px solid var(--border);border-radius:var(--r-sm);cursor:pointer;min-height:48px}
.server-row:active:not(:disabled) {background:var(--surface-2)}
.server-connecting {font-size:var(--fs-sm,12px)}
.sync-issue,.reauth-note,.server-pending,.server-problem {display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2,8px);font-size:var(--fs-sm,12px)}
.server-problem p {margin:0}
</style>
