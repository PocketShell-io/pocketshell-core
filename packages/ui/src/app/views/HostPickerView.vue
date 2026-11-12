<script lang="ts">
// Admission provenance survives picker remounts; the existing store/platform
// retain lifecycle ownership. Missing metadata can never authorize reuse.
const directAdmissions = new WeakMap<object, {
  accountId: string; vaultId: string; epoch: number; binding: string; connectionId: string;
}>();
</script>

<script setup lang="ts">
// Host picker: reads ~/.ssh/config, lists hosts, and connects on click.
// After a successful connect it navigates to the host workspace, where the
// session tree + terminal live.
//
// It is also the launch screen, so it owns the auto-connect to the user's
// default host. The rules for that decision are in ../autoConnect.ts; what
// lives here is only the dialling and the escape hatches, which are the part
// that matters:
//
//   - THE PICKER IS NEVER REPLACED BY A SPINNER. The host list stays on screen
//     for the whole attempt, with a banner above it. There is no state in which
//     the user is looking at a screen with nothing to press.
//   - CANCEL IS ALWAYS VISIBLE while dialling — for ANY dial, clicked or
//     automatic. A clicked dial hangs exactly as long as an automatic one (the
//     30s backstop below is one layer down from both), and every row is
//     disabled while one is out, so a picker without this strip is a picker
//     with nothing to press for half a minute. Pressing it abandons the
//     attempt immediately from the user's point of view, and hangs up on the
//     connection if it lands afterwards, so a cancelled dial cannot leave a
//     live link the user no longer wants.
//   - NO EXTRA RENDERER-SIDE TIMEOUT. `SshService.connect` already caps the
//     dial at DEFAULT_TIMEOUT_MS (30s) and resolves — never rejects — with a
//     real diagnostic. A second timer here would race it and would usually win,
//     replacing "All configured authentication methods failed" with a useless
//     "timed out". A bounded backstop plus an instant manual escape is what
//     "escapable" needs, and the bound already exists one layer down.
//   - A FAILED AUTO-CONNECT LEAVES THE DEFAULT ALONE. The error is shown on the
//     picker; the setting stays set, because a host being down is not a reason
//     to forget which host the user wants.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useConnectionStore } from '../stores/connection';
import { useHostsStore } from '../stores/hosts';
import { useSyncStore } from '../stores/sync';
import { api } from '../ipc';
import { windowTitle } from '@pocketshell/core/shared/windowTitle';
import {
  autoConnectAttempted,
  decideAutoConnect,
  defaultHostStatus,
  launchDefaultHost,
  markAutoConnectAttempted,
  readLaunchRequest,
} from '../autoConnect';
import AppIcon from '@ui/components/AppIcon.vue';
import OverlayPanel from '../components/OverlayPanel.vue';
import GatewayDevicesSection from '../components/GatewayDevicesSection.vue';
import GatewayAddDevicePanel from '../components/GatewayAddDevicePanel.vue';
import GatewayDialErrorActions from '../components/GatewayDialErrorActions.vue';
import HostRowDetail from '../components/HostRowDetail.vue';
import TrustedServersSection from '../components/TrustedServersSection.vue';
import { useKeyVault } from '../keyVault';
import { openTrustedServerWorkspace } from '../trustedServerWorkspace';
import { useSessionsStore } from '../stores/sessions';
import SettingsView from './SettingsView.vue';
import { readLastFolder } from '../workspaceState';
import { useGatewayPickerSource } from '../useGatewayPickerSource';
import { hostEntryId, normalizeGatewayTarget, type GatewayDialFailureKind, type HostEntry } from '@pocketshell/core';

const router = useRouter();
const connection = useConnectionStore();
const hostList = useHostsStore();
const sync = useSyncStore();
const keyVault = useKeyVault();
const trustedAccountMode = Boolean(keyVault?.platform.accountId && keyVault.platform.installTrustedHost && keyVault.platform.trustedHostRevisions);
const localSetupAllowed = computed(() => !trustedAccountMode || keyVault?.view?.localOnly === true);
const connectError = ref<string | null>(null);
/**
 * Why {@link connectError}'s dial failed, when it was a gateway dial core
 * classified: the error line then carries the matching next step (sign in,
 * pair the device, connect again as the current account) and an offline
 * device reads as offline — never as a failed login.
 */
const connectErrorKind = ref<GatewayDialFailureKind | null>(null);
/** The host whose dial produced {@link connectError}, for its follow-up action. */
const failedHost = shallowRef<HostEntry | null>(null);
/** The dialling host's display name, for the banner. */
const connectingTo = ref<string | null>(null);
/** The dialling host's identity ({@link hostEntryId}), for the row it marks. */
const connectingKey = ref<string | null>(null);
const settingsOpen = ref(false);
const reloadingHosts = ref(false);
const hostReloadError = ref<string | null>(null);

/**
 * What this window's launch asked for, read once off the load URL. A launch
 * that names a host (`?host=`) dials THAT instead of the stored default, and
 * its banner wording drops the "(your default host)" claim; a secondary
 * window (`?window=workspace`) offers no default at all — see
 * {@link readLaunchRequest}.
 */
const launch = readLaunchRequest(window.location.search);
const requestedConnect = launch.requestedHost !== null;

/**
 * A launch-named host that is not in the host list. The stored default's
 * absence has its own banner and its own Clear button; this one has nobody
 * to clear — the name came from a launch argument or a deep link, and the
 * fix is on the side that spelled it.
 */
const requestedMissing = computed(() =>
  launch.requestedHost !== null &&
  defaultHostStatus(launch.requestedHost, connection.hosts) === 'missing',
);

/**
 * Whether the platform can open another workspace window. Probed the
 * platformCapabilities way: only a real method counts, so the button is
 * absent — not disabled — where the concept does not exist.
 */
const canOpenNewWindow = (() => {
  try {
    return typeof api.win?.openNewWindow === 'function';
  } catch {
    return false;
  }
})();

/**
 * The platform's local host source, or null when it declares none. Every
 * config-file sentence here used to be hardcoded to ~/.ssh/config — wrong
 * the moment this view mounted in a browser, whose host list is the synced
 * account and which has no config file to name. Desktop provides the file's
 * name; the web words the same surfaces around its account list.
 */
const hostSource = api.hosts ?? null;
/** The platform's noun for its host source, for load-failure copy. */
const sourceName = hostSource?.sourceName ?? 'the host list';
/** Local provenance belongs to the platform source, not fromConfig or other
 * server-supplied row metadata. Even a local cache cannot bypass managed
 * gateway trust: any transport/policy marker excludes the alternate path. */
const hasManagedMarker = (host: HostEntry) => ['gateway','gatewayAuth','link','trustedVault'].some(key => Object.prototype.hasOwnProperty.call(host,key));
const localDirectHosts = computed(() => hostSource?.provenance === 'local'
  ? connection.hosts.filter(host => !hasManagedMarker(host))
  : []);
function isLocalDirectHost(host: HostEntry): boolean {
  return localDirectHosts.value.some(row => row === host);
}

interface LocalHostAdmission { readonly binding: string }
/** This comparison stays private: identity-file paths are never diagnostics. */
function localDialBinding(host: HostEntry): string {
  const forwards = (rows: HostEntry['localForwards']) => rows.map(row => [row.kind,row.listenHost,row.listenPort,row.destHost,row.destPort]);
  return JSON.stringify([hostEntryId(host),host.name,host.hostname,host.port,host.user,host.identityFile,
    host.proxyJump,host.forwardAgent,host.local ?? false,forwards(host.localForwards),forwards(host.remoteForwards)]);
}
/** Admission must originate in the platform's current local row, not an alias supplied by an account row. */
function admitLocalHost(host: HostEntry): LocalHostAdmission | null {
  return isLocalDirectHost(host) ? {binding:localDialBinding(host)} : null;
}
function currentLocalAdmission(host: HostEntry, admission: LocalHostAdmission): boolean {
  return hostSource?.provenance === 'local' && !hasManagedMarker(host) && localDialBinding(host) === admission.binding
    && localDirectHosts.value.some(row => localDialBinding(row) === admission.binding);
}

/**
 * The empty list's copy, split on the source's name so the name keeps the
 * code-chip treatment the hardcoded desktop template gave it.
 */
const emptyHint = computed(() => {
  const hint = hostSource?.emptyHint ?? 'No hosts yet.';
  const source = hostSource?.sourceName ?? null;
  const at = source === null ? -1 : hint.indexOf(source);
  if (source === null || at < 0) return { before: hint, source: null, after: '' };
  return { before: hint.slice(0, at), source, after: hint.slice(at + source.length) };
});

/** True while the in-flight dial was started by the app, not by a click.
 *  Only the banner's wording reads it now — "(your default host)" is the one
 *  thing an automatic dial says that a clicked one does not. */
const autoConnecting = ref(false);
/**
 * The in-flight dial's cancellation token, flipped by the banner's Cancel.
 *
 * A token per dial rather than the shared boolean this used to be, because a
 * boolean has to be reset by SOMETHING and every choice goes wrong once a
 * second dial can start while the first is still out — which is exactly what
 * Cancel enables, by re-enabling the rows. Reset at the next dial's start, and
 * cancelling A then clicking B un-cancels A the moment B begins, so A's late
 * success navigates after all; reset on resolution, and an abandoned dial's
 * verdict leaks into the next one. Each dial closes over its own token, so a
 * Cancel press can only ever mean the dial whose banner was on screen.
 */
let activeDial: { cancelled: boolean; accountDirect: boolean; finished: Promise<void>; cancel: () => void } | null = null;
interface WorkspaceBootstrap { cancelled: boolean; navigating: boolean; connectionId: string; hostKey: string; request: number }
let activeBootstrap: WorkspaceBootstrap | null = null;
let pendingBootstrapClose: Promise<void> | null = null;
let pickerRequest = 0;
let pickerAlive = true;

function cancelWorkspaceBootstrap(): void {
  const token = activeBootstrap;
  if (!token) return;
  token.cancelled = true;
  activeBootstrap = null;
  if (!token.navigating && connection.connectionId === token.connectionId
    && connection.activeHost && hostEntryId(connection.activeHost) === token.hostKey) {
    // Finish closing this owned connection before a new picker dial starts:
    // disconnect's final state reset must not erase a subsequent connection.
    const closing = connection.disconnect().catch(() => undefined);
    pendingBootstrapClose = closing;
    void closing.finally(() => {if(pendingBootstrapClose === closing) pendingBootstrapClose = null;});
  }
}

const defaultMissing = computed(
  () => defaultHostStatus(hostList.defaultHostKey, connection.hosts) === 'missing',
);

const accountSignedIn = computed(() => sync.status?.loggedIn === true);
const accountEmail = computed(() => sync.status?.email || 'Signed in');
const accountAriaLabel = computed(() =>
  accountSignedIn.value
    ? `Google account: ${accountEmail.value}. Open account and sync`
    : 'Open account and sync',
);

/**
 * Whether the picker may show the account's hosts at all: they exist here
 * only after some window decrypted the account copy this session (the
 * Account window's Check account or Sync now — the picker never sees the
 * passphrase). Until then the group says how to reveal them instead of
 * pretending the account is empty.
 */
const accountUnlocked = computed(() => accountSignedIn.value && sync.accountHosts !== null);

/**
 * The account's hosts this machine's config does not list — the rows the
 * account group exists for. A host in BOTH sources is already connectable
 * from the config group, and showing it twice would invite dialling the
 * same box from two rows that look unrelated.
 */
const accountOnlyHosts = computed<HostEntry[]>(() => {
  const account = accountSignedIn.value ? sync.accountHosts : null;
  if (account === null) return [];
  const configNames = new Set(connection.hosts.map((host) => host.name));
  return account.filter((host) => !configNames.has(host.name));
});

/**
 * The picker's two host sources, signed in: the account first (it is the
 * newer, less visible of the two), the config second. Signed out there is
 * one source and no labels — the list reads exactly as it always did.
 */
interface HostGroup {
  kind: 'account' | 'config';
  label: string;
  hosts: HostEntry[];
}

/**
 * Verified Gateway server aliases the signed-in vault lists (reported by
 * TrustedServersSection). An account settings row may never reuse one: a
 * direct dial would otherwise inherit that alias's vault binding.
 */
const directAccountScope = ref<{ accountId: string; vaultId: string; epoch: number; aliases: string[] } | null>(null);

/**
 * Trusted-account mode: the account's direct SSH rows (settings rows, NOT
 * verified Gateway descriptors) this phone does not already have. Offered only
 * while the signed-in account's vault is unlocked, only for the platform's
 * explicit local source, and never for a row carrying any Gateway/link/policy
 * marker, a local-machine flag, an unusable endpoint, or an alias taken by a
 * local host or a verified server. Their origin stays "account": picking one
 * starts an explicit direct dial, see {@link onAccountDirectConnect}.
 */
const accountDirectHosts = computed<HostEntry[]>(() => {
  if (!trustedAccountMode || hostSource?.provenance !== 'local' || !hostSource.accountDirect || keyVault?.view?.localOnly === true) return [];
  if (keyVault?.view?.state !== 'unlocked' || !accountSignedIn.value) return [];
  const rows = sync.accountHosts;
  const scope = directAccountScope.value;
  if (rows === null || !scope || keyVault.store.vaultId !== scope.vaultId || keyVault.store.epoch !== scope.epoch) return [];
  const taken = new Set([...connection.hosts.map(host => host.name), ...scope.aliases]);
  const seen = new Set<string>();
  return rows.filter((host) => {
    if (hasManagedMarker(host) || host.local === true || taken.has(host.name) || seen.has(host.name)) return false;
    if (!host.name || !host.hostname || !host.user || !Number.isInteger(host.port) || host.port < 1 || host.port > 65535) return false;
    if (connection.hosts.some(local => local.hostname === host.hostname && local.port === host.port)) return false;
    seen.add(host.name);
    return true;
  });
});
function isAccountDirectHost(host: HostEntry): boolean {
  return trustedAccountMode && accountDirectHosts.value.some(row => row === host);
}

const hostGroups = computed<HostGroup[]>(() => {
  if (trustedAccountMode) {
    const groups: HostGroup[] = [];
    if (hostSource?.provenance === 'local') {
      groups.push({kind:'config',label:localDirectHosts.value.length ? hostSource.groupLabel : '',hosts:localDirectHosts.value});
    }
    if (accountDirectHosts.value.length > 0) {
      groups.push({kind:'account',label:'In your account · direct SSH',hosts:accountDirectHosts.value});
    }
    return groups;
  }
  if (!accountSignedIn.value) {
    return [{ kind: 'config', label: '', hosts: connection.hosts }];
  }
  const groups: HostGroup[] = [];
  if (accountOnlyHosts.value.length > 0) {
    groups.push({ kind: 'account', label: 'From your account', hosts: accountOnlyHosts.value });
  }
  groups.push({ kind: 'config', label: hostSource?.groupLabel ?? '', hosts: connection.hosts });
  return groups;
});

function onAccountAction(): void {
  void api.win.openAccount();
}

/**
 * The gateway device source and the add/pair flow (useGatewayPickerSource):
 * both follow the signed-in account; the picker only supplies its hosts and
 * its one dialling path.
 */
const {
  gateway,
  addingDevice,
  listedHosts,
  hostPresence,
  openAddDevice,
  openRepair,
  onDeviceSaved,
  onConnectAdded,
} = useGatewayPickerSource({
  account: computed(() => (accountSignedIn.value ? sync.status?.email ?? '' : null)),
  listedHosts: computed(() => [...connection.hosts, ...accountOnlyHosts.value]),
  reloadHosts: () => connection.loadHosts(),
  connect: (host) => onConnect(host),
  hostByName: (name) => connection.hosts.find((candidate) => candidate.name === name),
});

/** Open another workspace window on this platform (see {@link canOpenNewWindow}). */
function onNewWindow(): void {
  void api.win.openNewWindow?.();
}

function refreshAccountStatus(): void {
  void sync.refreshStatus().catch(() => {
    // A status read failure leaves the safe, signed-out presentation in place.
  });
}

/**
 * The host we are connected to right now, if any. Back from the workspace
 * keeps the link alive, so this list can be looked at WHILE connected — and
 * that row then behaves differently in three ways: its dot is green, clicking
 * it re-enters the workspace instead of dialling a second connection over the
 * first, and it carries the Disconnect button. Disconnect lives here rather
 * than in the workspace because every disconnect already navigated here — the
 * button now sits at its own destination, beside where the connection was
 * opened.
 */
const connectedKey = computed(() =>
  connection.state === 'connected' && connection.connectionId && connection.activeHost
    ? hostEntryId(connection.activeHost)
    : null,
);

onMounted(async () => {
  // Reclaim the OS window title from the workspace, which sets the host's
  // identity on it and deliberately does not reset it on unmount (mount order
  // during a route swap is not something to depend on).
  api.win.setTitle(windowTitle(null));
  // The picker only needs the small account state. Detailed sync controls live
  // in the separate Account window, but the header must know which compact
  // action to show after that window signs in or out.
  refreshAccountStatus();
  window.addEventListener('focus', refreshAccountStatus);
  try {
    await connection.loadHosts();
  } catch (error) {
    // A mount-time failure must not take auto-connect down with it: a
    // rejected read of the host source used to abort this handler before
    // `decideAutoConnect` ran, and the picker then rendered its "no hosts
    // found" empty state for what is really a load failure. Report it in the
    // same slot the reload path uses (with the same detail) and let the
    // decision run on whatever loaded.
    const detail = error instanceof Error && error.message ? `: ${error.message}` : '';
    hostReloadError.value = `Could not read ${sourceName}${detail}`;
  }
  const decision = decideAutoConnect({
    defaultHost: launchDefaultHost(launch, hostList.defaultHostKey),
    hosts: trustedAccountMode ? localDirectHosts.value : connection.hosts,
    attempted: autoConnectAttempted(),
    connected: connection.connectionId !== null,
  });
  if (decision.action === 'connect') await runAutoConnect(decision.host);
});

onBeforeUnmount(() => {
  pickerAlive = false;
  pickerRequest++;
  if (activeDial) activeDial.cancel();
  cancelWorkspaceBootstrap();
  window.removeEventListener('focus', refreshAccountStatus);
});

async function runAutoConnect(host: HostEntry): Promise<void> {
  const localAdmission = trustedAccountMode ? admitLocalHost(host) : null;
  if (trustedAccountMode && !localAdmission) {connectError.value = 'Local host changed. Connect again.';return;}
  // Latch BEFORE dialling: whatever happens next — success, failure, cancel,
  // a hang that the user escapes — this launch has had its one attempt. This
  // is what stops Back from the workspace bouncing straight back in.
  markAutoConnectAttempted();
  autoConnecting.value = true;
  // Cancellation lives inside `dial` now: a cancelled attempt reports false
  // (and has already hung up on a late success), so this stays a plain
  // succeeded-or-not question and a cancelled auto-connect cannot navigate.
  let ok = false;
  try {
    ok = await dial(host);
  } finally {
    // `finally`, not the line after: if the dial ever throws, the latch must
    // still lift or the picker's rows stay disabled until remount.
    autoConnecting.value = false;
  }
  if (ok) await enterWorkspace(host,localAdmission);
}

/** Re-read ~/.ssh/config without disturbing an existing connection or dial. */
async function onReloadHosts(): Promise<void> {
  if (reloadingHosts.value) return;
  reloadingHosts.value = true;
  hostReloadError.value = null;
  try {
    await connection.loadHosts();
    if (gateway.available && accountSignedIn.value) void gateway.load();
  } catch (error) {
    const detail = error instanceof Error && error.message ? `: ${error.message}` : '';
    hostReloadError.value = `Could not reload ${sourceName}${detail}`;
  } finally {
    reloadingHosts.value = false;
  }
}

/**
 * The banner's Cancel, one handler for both kinds of dial. The user's half is
 * instant — the banner goes, the rows re-enable, they can click elsewhere at
 * once — while `dial` is left holding the token, to notice it whenever the
 * attempt finally resolves and clean up whatever it produced.
 */
function onCancelConnect(): void {
  pickerRequest++;
  if (activeDial) {
    const token = activeDial;
    token.cancel();
    if (token.accountDirect) {
      // The store still owns the native attempt until it settles and the
      // cancelled result closes. Queue another selection behind that cleanup
      // instead of letting the old completion overwrite its connection ID.
      pendingBootstrapClose = token.finished;
      void token.finished.finally(() => {
        if (pendingBootstrapClose === token.finished) pendingBootstrapClose = null;
      });
    }
  }
  cancelWorkspaceBootstrap();
  autoConnecting.value = false;
  connectingTo.value = null;
  connectingKey.value = null;
}

async function onConnect(host: HostEntry, trusted = false): Promise<void> {
  if (!trusted && isAccountDirectHost(host)) return onAccountDirectConnect(host);
  const localAdmission = !trusted ? admitLocalHost(host) : null;
  if (trustedAccountMode && (trusted
    ? host.gatewayAuth !== 'managed' || normalizeGatewayTarget(host.gateway) === null
    : !localAdmission)) {
    connectError.value = 'Open this server from the verified account server list.';
    return;
  }
  const request = ++pickerRequest;
  if (pendingBootstrapClose) await pendingBootstrapClose;
  if (!pickerAlive || request !== pickerRequest) return;
  if (localAdmission && !currentLocalAdmission(host,localAdmission)) {connectError.value = 'Local host changed. Connect again.';return;}
  // Already connected to this host: go back in without asking the platform
  // to reconnect. The platform owns its host connection pool and forwards.
  if (hostEntryId(host) === connectedKey.value) {
    await enterWorkspace(host,localAdmission);
    return;
  }
  if (await dial(host) && pickerAlive && request === pickerRequest) await enterWorkspace(host,localAdmission);
}

/**
 * An account-only direct SSH row. The row is an unverified settings record, so
 * nothing about it is trusted here: the platform's own dial decides the
 * credential from the account vault's binding for that alias, and the usual
 * host-key prompt still gates the first contact. The verified account and
 * unlocked vault captured here must still be the same ones when the dial
 * lands, else the connection is closed and nothing opens.
 */
async function onAccountDirectConnect(host: HostEntry): Promise<void> {
  const scope = directAccountScope.value;
  if (!keyVault?.platform.accountId || !scope) return;
  const request = ++pickerRequest;
  const directEndpoint = (row: HostEntry) => JSON.stringify([row.name, row.hostname, row.port, row.user]);
  // Account rows are reactive and may be edited in place while native SSH is
  // pending. The dial and its ownership must retain the admitted endpoint.
  let admitted = { ...host };
  const binding = directEndpoint(admitted);
  const current = () => pickerAlive && request === pickerRequest && directAccountScope.value === scope
    && keyVault.store.state === 'unlocked' && keyVault.store.vaultId === scope.vaultId && keyVault.store.epoch === scope.epoch
    && accountDirectHosts.value.some(row => directEndpoint(row) === binding && !hasManagedMarker(row) && row.local !== true);
  if (pendingBootstrapClose) {
    connectingTo.value = host.name;
    connectingKey.value = hostEntryId(host);
    try {
      await pendingBootstrapClose;
    } finally {
      if (pickerAlive && request === pickerRequest) {
        connectingTo.value = null;
        connectingKey.value = null;
      }
    }
    if (!current()) return;
  }
  const previousHost = connection.activeHost;
  const previousId = connection.connectionId;
  const previousState = connection.state;
  try {
    if (await keyVault.platform.accountId() !== scope.accountId || !current()) return;
  } catch {
    if (pickerAlive && request === pickerRequest) connectError.value = 'Your account could not be verified. Connect again.';
    return;
  }
  // A newer/foreign result arriving during verification belongs to its own
  // request: neither reuse it nor replace it with this request's dial.
  if (connection.activeHost !== previousHost || connection.connectionId !== previousId
    || connection.state !== previousState) return;
  let resumed = false;
  if (previousHost && previousId) {
    const proof = directAdmissions.get(previousHost);
    const sameScope = proof?.connectionId === previousId && proof.accountId === scope.accountId
      && proof.vaultId === scope.vaultId && proof.epoch === scope.epoch;
    const admittedPrevious = sameScope && proof.binding === directEndpoint(previousHost) && previousState === 'connected'
      && !hasManagedMarker(previousHost) && previousHost.local !== true;
    if (admittedPrevious && proof.binding === binding) {
      admitted = previousHost;
      resumed = true;
    }
    // Changed/missing admission takes the normal platform path below. The
    // adapter owns host pooling, reconnect and active forwards; selecting a
    // different row must not close the previously displayed host here.
  } else if (previousId || previousState === 'connecting') {
    return;
  }
  if (!resumed && (!(await dial(admitted, true)) || !pickerAlive || request !== pickerRequest)) return;
  const ownedId = connection.activeHost === admitted ? connection.connectionId : null;
  const ownsConnection = () => ownedId !== null && connection.connectionId === ownedId && connection.activeHost === admitted;
  let sameAccount = false;
  let verificationFailed = false;
  try {
    sameAccount = await keyVault.platform.accountId() === scope.accountId;
  } catch {
    // A native/backend verification failure is failed admission too. The
    // successful dial still belongs to this request and must be cleaned up.
    verificationFailed = true;
  }
  if (!sameAccount || !current() || !ownsConnection()) {
    if (pickerAlive && request === pickerRequest) {
      connectError.value = verificationFailed
        ? 'Your account could not be verified. Connect again.'
        : 'Your account or host changed. Connect again.';
    }
    // An equivalent endpoint is insufficient: another request may now own a
    // newer connection to that same server while the account check awaited.
    if (ownsConnection()) {
      const closing = connection.disconnect().catch(() => undefined);
      pendingBootstrapClose = closing;
      await closing;
      if (pendingBootstrapClose === closing) pendingBootstrapClose = null;
    }
    return;
  }
  directAdmissions.set(admitted, {accountId: scope.accountId, vaultId: scope.vaultId, epoch: scope.epoch,
    binding, connectionId: ownedId!});
  enterPlainWorkspace(admitted);
}

function onTrustedConnect(host: HostEntry): void {
  // TrustedServersSection revalidates the descriptor and installs account-
  // bound native trust before emitting. Cached/manual rows never use this.
  void onConnect(host,true);
}

/** Hang up. Stays on the picker — the row's dot going grey is the feedback. */
async function onDisconnect(): Promise<void> {
  await connection.disconnect();
}

/**
 * The one dialling path, shared by the click and by auto-connect, so the two
 * cannot drift. In particular `connection.connect` is what supplies
 * `privateKeyPath` (it falls back to the host's `identityFile`) and the TOFU
 * decision, and neither has an auto-connect-specific variant — an automatic
 * dial gets exactly the credentials and exactly the host-key treatment a
 * clicked one does.
 *
 * Cancellation lives here too, for the same reason: both kinds of dial hang
 * the same way and must escape the same way. A cancelled attempt reports
 * FALSE whatever the transport eventually said, which is the one bit both
 * callers act on — neither can navigate to a workspace the user walked out of.
 */
async function dial(host: HostEntry, accountDirect = false): Promise<boolean> {
  if (activeBootstrap) {activeBootstrap.cancelled = true;activeBootstrap = null;}
  connectError.value = null;
  connectErrorKind.value = null;
  failedHost.value = null;
  connectingTo.value = host.name;
  connectingKey.value = hostEntryId(host);
  let finish!: () => void;
  const request = pickerRequest;
  const token = { cancelled: false, accountDirect, finished: new Promise<void>(resolve => { finish = resolve; }),
    cancel: () => { token.cancelled = true; rejectOwnedTrust(); } };
  const rejectOwnedTrust = () => {
    const question = connection.pendingTrust;
    if (accountDirect && token.cancelled && activeDial === token && connection.activeHost === host
      && question?.hostLabel === host.name && question.hostname === host.hostname
      && question.port === host.port && question.user === host.user) connection.answerTrust('reject');
  };
  activeDial = token;
  // Also reject this cancelled attempt's question if native KEX finishes after
  // Cancel/unmount. The watcher drains only this token's admitted host, then
  // is explicitly disposed with its native attempt, never a newer question.
  const stopTrustWatch = accountDirect
    ? watch(() => connection.pendingTrust, rejectOwnedTrust, {flush: 'post'})
    : () => undefined;
  try {
    const ok = await connection.connect(host, undefined, undefined, accountDirect);
    // Only put the picker back if a newer dial has not claimed it: after a
    // cancel the rows re-enable, so by the time this resolves `connectingTo`
    // and the error slot may belong to a dial the user started since, and a
    // slow failure here must not wipe that dial's banner or its diagnostic.
    if (activeDial === token) {
      activeDial = null;
      if (request === pickerRequest) {
        connectingTo.value = null;
        connectingKey.value = null;
        if (!ok && !token.cancelled) {
          connectError.value = connection.error ?? 'Connection failed';
          connectErrorKind.value = connection.errorKind;
          failedHost.value = host;
        }
      }
    }
    if (token.cancelled) {
      // The dial won the race with the Cancel click. Hang up rather than leaving
      // a connection the user explicitly abandoned — but only if this is still
      // the connection in hand. `connect()` claims `activeHost` synchronously, so
      // a different host here means the user already started dialling somewhere
      // else in the meantime and tearing "the" connection down would tear down
      // theirs. A different result remains with the platform's host connection
      // lifecycle rather than closing the connection the user selected next.
      // Account rows can share an alias with a newer object. Only this
      // request's admitted snapshot can authorize its cancellation cleanup.
      const stillOwnsHost = accountDirect
        ? connection.activeHost === host
        : connection.activeHost && hostEntryId(connection.activeHost) === hostEntryId(host);
      if (ok && stillOwnsHost) await connection.disconnect();
      return false;
    }
    return ok;
  } finally {
    stopTrustWatch();
    finish();
  }
}

async function enterWorkspace(host: HostEntry, localAdmission: LocalHostAdmission | null): Promise<void> {
  if (trustedAccountMode && localAdmission) {
    // A source refresh replaces objects while native SSH is pending. Preserve
    // the admitted local origin, but recheck the complete current binding.
    // A changed target/source/policy is refused, never reclassified as account.
    if (!currentLocalAdmission(host,localAdmission)) {
      connectError.value = 'Local host changed while connecting. Connect again.';
      if (connection.connectionId && connection.activeHost === host) {
        const closing = connection.disconnect().catch(() => undefined);
        pendingBootstrapClose = closing;
        await closing;
        if (pendingBootstrapClose === closing) pendingBootstrapClose = null;
      }
      return;
    }
    if (!connection.activeHost || hasManagedMarker(connection.activeHost)
      || localDialBinding(connection.activeHost) !== localAdmission.binding) return;
  } else if (trustedAccountMode && keyVault?.platform.accountId) {
    const id = connection.connectionId;
    if (!id) return;
    if (activeBootstrap) activeBootstrap.cancelled = true;
    const token: WorkspaceBootstrap = {cancelled:false,navigating:false,connectionId:id,hostKey:hostEntryId(host),request:pickerRequest};
    activeBootstrap = token;
    connectingTo.value = host.name;
    try {
      const account = await keyVault.platform.accountId();
      const owns = () => pickerAlive && !token.cancelled && activeBootstrap === token && token.request === pickerRequest
        && connection.connectionId === id && connection.activeHost !== null && hostEntryId(connection.activeHost) === token.hostKey
        && keyVault.store.state === 'unlocked';
      const current = async () => {
        if (!owns() || !account) return false;
        const now = await keyVault.platform.accountId!();
        return owns() && now === account;
      };
      if (!await current()) return;
      const sessions = useSessionsStore();
      const route = await openTrustedServerWorkspace({
        current,
        lastFolder:readLastFolder(host.name),
        list:async () => typeof api.helper.sessionsListing === 'function'
          ? api.helper.sessionsListing(id,'activity') : {sessions:await api.helper.sessionsList(id,'activity'),errors:[]},
        home:() => api.sftp.realPath(id,'.'),
        start:folder => api.projects.startSession(id,{folder,namePolicy:'reuse'}),
        pending:(result,folder) => {const summary = sessions.summaryFromStartResult(result,folder); if(summary) sessions.addPending(summary);},
      });
      if (!await current()) return;
      token.navigating = true;
      await router.push({name:'folder',params:{name:host.name,folder:route.folder},
        ...(route.session ? {query:{tab:route.session}} : {})});
    } catch(e) { if(pickerAlive && activeBootstrap === token && !token.cancelled) connectError.value = (e as Error).message; }
    finally { if(activeBootstrap === token) {activeBootstrap = null;connectingTo.value = null;connectingKey.value = null;} }
    return;
  }
  // Land in the folder this host was last open on, when there is one — the
  // whole point of relaunching into the same tabs. The workspace restores the
  // rest of its own state (Files tabs, selection) from the same store, so the
  // folder route alone is the entire handoff. A host never opened, or a
  // record that names nothing, keeps the old landing below.
  enterPlainWorkspace(host);
}

/** Land in the host's last folder, else its session list (no managed bootstrap). */
function enterPlainWorkspace(host: HostEntry): void {
  const folder = readLastFolder(host.name);
  if (folder) {
    void router.push({ name: 'folder', params: { name: host.name, folder } });
    return;
  }
  void router.push({ name: 'host-sessions', params: { name: host.name } });
}

/**
 * The star on a row: make this host the default, or clear it — in the store
 * that owns the default on this platform (the saved-host store when the
 * platform owns its hosts, the renderer settings otherwise).
 */
function onToggleDefault(host: HostEntry): void {
  void hostList.toggleDefault(host).catch((error: unknown) => {
    connectError.value = error instanceof Error && error.message ? error.message : 'Could not change the default host';
  });
}

function onClearDefault(): void {
  void hostList.setDefaultHost(null).catch((error: unknown) => {
    connectError.value = error instanceof Error && error.message ? error.message : 'Could not clear the default host';
  });
}
</script>

<template>
  <div class="picker">
    <header>
      <h1>PocketShell</h1>
      <div class="header-actions">
        <button
          class="icon-btn"
          :disabled="reloadingHosts"
          :aria-busy="reloadingHosts"
          title="Reload hosts"
          aria-label="Reload hosts"
          @click="onReloadHosts"
        >
          <AppIcon name="refresh" :class="{ spin: reloadingHosts }" />
        </button>
        <!-- Another window for another host — the desktop's multi-window
             support. Absent where the platform holds one window. -->
        <button
          v-if="canOpenNewWindow"
          class="icon-btn"
          title="New window"
          aria-label="Open a new window"
          @click="onNewWindow"
        >
          <AppIcon name="plus" />
        </button>
        <button class="icon-btn" title="Settings" @click="settingsOpen = true">
          <AppIcon name="settings" />
        </button>
        <button
          class="account-action"
          :class="{ 'signed-in': accountSignedIn }"
          :aria-label="accountAriaLabel"
          :title="accountAriaLabel"
          @click="onAccountAction"
        >
          <span class="account-status-dot" :class="{ 'signed-in': accountSignedIn }" aria-hidden="true" />
          <span class="account-copy">
            <span class="account-provider">Google</span>
            <span class="account-state">{{ accountSignedIn ? accountEmail : 'Sign in' }}</span>
          </span>
        </button>
      </div>
    </header>
    <main>
      <!-- The escape hatch, for ANY dial — automatic or clicked. It sits
           above the list, and the list stays usable underneath, so a dial is
           something happening ON the picker rather than instead of it. It used
           to render only for auto-connect, which made the header's "cancel is
           always visible" promise false for the commonest case: a clicked row
           disables every row and, on a typo'd Host or a sleeping box, held the
           whole picker for the 30s backstop with nothing to press. Only the
           wording knows which kind of dial it is. -->
      <p v-if="connectingTo !== null" class="auto-banner">
        <!-- "(your default host)" only when it IS the default: a launch that
             named its host explicitly (a command line, a deep link) must not
             borrow the setting's authority for a name nobody stored. -->
        <span v-if="autoConnecting && !requestedConnect">
          Connecting to <strong>{{ connectingTo }}</strong> (your default host)…
        </span>
        <span v-else>Connecting to <strong>{{ connectingTo }}</strong>…</span>
        <button class="btn-ghost" @click="onCancelConnect">Cancel</button>
      </p>
      <!-- `connectingTo`, not `autoConnecting`: any dial's banner displaces
           this one, so the two strips can never stack. -->
      <p v-if="defaultMissing && connectingTo === null" class="auto-banner stale">
        <AppIcon name="alert-triangle" :size="14" />
        <span v-if="hostSource">
          Your default host <strong>{{ hostList.defaultHostKey }}</strong> is not in
          <code>{{ hostSource.sourceName }}</code> any more.
        </span>
        <span v-else>
          Your default host <strong>{{ hostList.defaultHostKey }}</strong> is no longer
          in the host list.
        </span>
        <button class="btn-ghost" @click="onClearDefault">Clear</button>
      </p>
      <!-- Same treatment for a host a LAUNCH named: it is on the picker
           because the name did not resolve, and it deserves to know that is
           why. No Clear — there is no stored setting behind this one. -->
      <p v-if="requestedMissing && connectingTo === null" class="auto-banner stale">
        <AppIcon name="alert-triangle" :size="14" />
        <span v-if="hostSource">
          This window was opened for <strong>{{ launch.requestedHost }}</strong>, which is
          not in <code>{{ hostSource.sourceName }}</code>.
        </span>
        <span v-else>
          This window was opened for <strong>{{ launch.requestedHost }}</strong>, which is not
          in the host list.
        </span>
      </p>
      <p v-if="hostReloadError" class="error">{{ hostReloadError }}</p>
      <!-- Signed in but the account copy is still encrypted to this session:
           say how to reveal it rather than reading as an empty account. -->
      <TrustedServersSection v-if="trustedAccountMode" :busy="connectingTo !== null" @connect="onTrustedConnect" @loaded="directAccountScope = $event" />
      <p v-if="!trustedAccountMode && accountSignedIn && !accountUnlocked" class="muted locked-note">
        Your account's hosts show up here once Account &amp; sync has checked the account.
        <!-- The unlock lives behind the account action; a note alone would
             send a first-run reader hunting through chrome for it. -->
        <button class="btn-ghost" @click="onAccountAction">Open Account &amp; sync</button>
      </p>
      <!-- The two host sources. Each group is a labelled list; the config
           group keeps the empty state, the account group only exists when it
           has something the config group does not. -->
      <template v-for="group in hostGroups" :key="group.kind">
        <h2 v-if="group.label" class="group-label">{{ group.label }}</h2>
        <ul class="host-list">
          <!-- The card is the <li>, not the row button: the "make this the
               default" star is a second control on the same card, and a button
               inside a button is invalid. -->
          <li v-for="host in group.hosts" :key="hostEntryId(host)" class="host-item">
            <button
              class="host-row"
              :disabled="connectingTo !== null"
              @click="onConnect(host)"
            >
              <!-- Mirrors the Android StatusDot: the desktop used to show
                   connection state only as the word "connecting…". -->
              <span
                class="status-dot"
                :class="{
                  // No pulse while the dial waits on the user's host-key
                  // answer: nothing is connecting, and an endless animation
                  // under the prompt's scrim repaints the whole screen.
                  connecting: connectingKey === hostEntryId(host) && !connection.pendingTrust,
                  connected: connectedKey === hostEntryId(host),
                }"
              />
              <span class="host-name">{{ host.name }}</span>
              <!-- local / gateway / plain detail, then a gateway host's
                   presence chip — one chain, in its own component. -->
              <HostRowDetail :host="host" :presence="host.gateway ? hostPresence(host) : null" />
              <span v-if="connectingKey === hostEntryId(host)" class="muted">connecting…</span>
              <!-- A list row that goes somewhere gets a chevron, not an arrow
                   (VS Code / macOS convention). Kept on the connected row too:
                   it still goes somewhere — back into the workspace. -->
              <AppIcon v-else name="chevron-right" class="chevron" />
            </button>
            <button
              v-if="connectedKey === hostEntryId(host)"
              class="btn-ghost disconnect"
              @click="onDisconnect"
            >
              Disconnect
            </button>
            <!-- The default-host star lives in the config group only: a
                 default must survive a relaunch, and auto-connect reads
                 ~/.ssh/config, which an account-only host is not in yet. -->
            <button
              v-if="group.kind === 'config'"
              class="icon-btn star"
              :class="{ on: hostList.isDefault(host) }"
              :title="
                hostList.isDefault(host)
                  ? 'Stop connecting to this host on startup'
                  : 'Connect to this host on startup'
              "
              :aria-pressed="hostList.isDefault(host)"
              @click="onToggleDefault(host)"
            >
              <AppIcon :name="hostList.isDefault(host) ? 'star-filled' : 'star'" />
            </button>
          </li>
        </ul>
        <p
          v-if="localSetupAllowed && group.kind === 'config' && !group.hosts.length && !connection.error && !hostReloadError"
          class="muted"
        >
          <span>{{ emptyHint.before }}</span><code v-if="emptyHint.source">{{ emptyHint.source }}</code><span>{{ emptyHint.after }}</span>
          <!-- The explicit space survives: Vue's whitespace condensing drops
               the newline between these elements, and the action would butt
               against the sentence. -->
          {{ ' ' }}
          <!-- The platform's way out of an empty list — the web routes to its
               add/import surface, which nothing else links to since this view
               became the home. A plain button, not router-link: the route is
               platform data, and this view navigates by router.push anyway. -->
          <button
            v-if="hostSource?.emptyAction"
            class="btn-ghost"
            @click="router.push(hostSource.emptyAction.route)"
          >
            {{ hostSource.emptyAction.label }}
          </button>
        </p>
      </template>
      <!-- The gateway device source: only where the platform provides it,
           and only for a signed-in account (the list is the account's). -->
      <GatewayDevicesSection
        v-if="!trustedAccountMode && gateway.available && accountSignedIn"
        :hosts="listedHosts"
        :busy="connectingTo !== null"
        @add="openAddDevice"
        @sign-in="onAccountAction"
      />
      <p v-if="connectError" class="error" :data-kind="connectErrorKind ?? undefined">{{ connectError }}</p>
      <!-- The next step for a classified gateway refusal, beside (not inside)
           the message: an offline host is offline, a missing pairing asks to
           pair, a sign-in problem asks to sign in. -->
      <GatewayDialErrorActions
        v-if="!trustedAccountMode && connectError && connectErrorKind"
        :kind="connectErrorKind"
        :host="failedHost"
        :gateway-available="gateway.available"
        @sign-in="onAccountAction"
        @repair="openRepair"
        @connect-again="onConnect"
        @reload-devices="gateway.load()"
      />
    </main>

    <!-- Settings remains reachable here with no connection: default-host is
         about startup, and the project-root section lets the user choose an
         SSH alias before editing its instance-specific roots. -->
    <OverlayPanel v-if="settingsOpen" title="Settings" size="md" @close="settingsOpen = false">
      <SettingsView />
    </OverlayPanel>
    <OverlayPanel
      v-if="addingDevice"
      :title="addingDevice.prefill ? 'Pair a gateway device' : 'Add a gateway device'"
      size="md"
      @close="addingDevice = null"
    >
      <GatewayAddDevicePanel
        :device="addingDevice.device"
        :prefill="addingDevice.prefill"
        :account="addingDevice.account"
        :server-url="gateway.serverUrl"
        @saved="onDeviceSaved"
        @connect="onConnectAdded"
        @sign-in="onAccountAction"
        @close="addingDevice = null"
      />
    </OverlayPanel>
  </div>
</template>

<style scoped>
.picker {
  max-width: 720px;
  margin: 0 auto;
  padding: var(--sp-6) var(--sp-5);
}
header {
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
  border-bottom: 1px solid var(--border);
  padding-bottom: var(--sp-4);
  margin-bottom: var(--sp-5);
}
h1 {
  margin: 0;
  font-size: var(--fs-600);
  line-height: var(--lh-600);
  font-weight: var(--fw-bold);
  color: var(--fg);
}
/* Keeps the config reload and settings actions together at the trailing edge
   of the wordmark. The shared icon button supplies the square geometry. */
.header-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  align-self: center;
}
/* The account action is the landing screen's one high-discoverability CTA.
   It opens the separate Account & sync window; the chip only mirrors the
   signed-in identity so the destination remains obvious. */
.account-action {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: 220px;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  background: transparent;
  color: var(--fg-secondary);
  font-family: var(--font-ui);
  font-size: var(--fs-200);
  line-height: var(--lh-200);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.account-action:not(.signed-in) {
  border-color: var(--border-strong);
  background: var(--accent-soft);
  color: var(--accent);
}
.account-action:hover:not(:disabled) {
  border-color: var(--border-strong);
  background: var(--state-hover);
  color: var(--fg);
}
.account-action:not(.signed-in):hover:not(:disabled) {
  background: var(--accent-soft);
  color: var(--accent);
}
.account-action:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
.account-status-dot {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: currentColor;
}
.account-status-dot.signed-in {
  background: var(--success);
}
.account-copy {
  display: flex;
  align-items: baseline;
  min-width: 0;
  gap: var(--sp-1);
}
.account-provider {
  font-weight: var(--fw-semibold);
}
.account-state {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Status strip above the list: the app is doing something, the list is still
   there, and the way out is in the same line as the message. */
.auto-banner {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: 0 0 var(--sp-3);
  padding: var(--sp-2) var(--sp-2) var(--sp-2) var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface);
  font-size: var(--fs-200);
  line-height: var(--lh-200);
  color: var(--fg-secondary);
}
.auto-banner button {
  margin-left: auto;
}
.auto-banner.stale {
  color: var(--warning);
  background: var(--warning-soft);
  border-color: transparent;
}
/* Section eyebrows over the two host groups (account / config), matched to
   the Account window's .account-eyebrow treatment. */
.group-label {
  margin: var(--sp-5) 0 var(--sp-2);
  color: var(--fg-muted);
  font-size: var(--fs-200);
  font-weight: var(--fw-semibold);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.group-label:first-child {
  margin-top: 0;
}
.locked-note {
  margin: 0 0 var(--sp-3);
}
.host-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
/* The one place a taller, card-like row is right: this is a landing screen,
   not a dense list. Matches the Android HostCard's 14dp/44dp geometry. */
.host-item {
  display: flex;
  align-items: center;
  min-height: 44px;
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-lg);
  margin-bottom: var(--sp-2);
  padding-right: var(--sp-2);
  transition:
    background var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease);
}
/* Hover is a neutral lift + a stronger edge. Accent is reserved for
   *selected*, never for hover. Keyed off the ROW so that hovering the star
   alone does not light up the whole card — they are two different actions. */
.host-item:has(.host-row:hover:not(:disabled)) {
  background: var(--state-hover);
  border-color: var(--border-strong);
}
.host-row {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  align-self: stretch;
  text-align: left;
  background: transparent;
  color: var(--fg);
  border: none;
  border-radius: var(--r-lg);
  padding: var(--sp-2) var(--sp-3) var(--sp-2) var(--sp-4);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
}
.host-row:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
/* Quiet until it means something: an unset star is a decorative mark, a set
   one is the accent because it IS a selection — this host, on startup. */
.star {
  color: var(--fg-muted);
}
.star.on,
.star.on:hover {
  color: var(--accent);
}
.status-dot {
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--fg-muted);
}
.status-dot.connecting {
  background: var(--warning);
  animation: pulse 1.2s var(--ease) infinite;
}
.status-dot.connected {
  background: var(--success);
}
/* Destructive: neutral at rest, error-tinted only on hover — the same
   treatment the workspace's disconnect button had before it moved here. No
   border-color line: the button is a ghost and has no border to tint. */
.btn-ghost.disconnect:hover:not(:disabled) {
  background: var(--error-soft);
  color: var(--error);
}
@keyframes pulse {
  50% {
    opacity: 0.3;
  }
}
/* No local prefers-reduced-motion block: App.vue carries one global guard
   that covers this pulse along with every other animation. */
.host-name {
  font-size: var(--fs-400);
  line-height: var(--lh-400);
  font-weight: var(--fw-semibold);
}
/* A 2px nudge on row hover — the smallest possible "this row goes somewhere"
   cue. Colour and transform only; the row's own tint does the rest. */
.chevron {
  color: var(--fg-muted);
  transition:
    color var(--dur-fast) var(--ease),
    transform var(--dur-fast) var(--ease);
}
.host-row:hover:not(:disabled) .chevron {
  color: var(--fg-secondary);
  transform: translateX(2px);
}
.error {
  font-size: var(--fs-300);
  /* A refusal can carry long unbroken tokens (SHA256 fingerprints, paths):
     wrap them inside a phone-width screen instead of running off the edge. */
  overflow-wrap: anywhere;
  /* And never wider than the visible screen: on a phone this view's layout
     can exceed the device width (stage A3), which would carry the wrapped
     text off-screen with it. */
  max-width: calc(100vw - 2 * var(--sp-5));
}
code {
  background: var(--surface-2);
  border: 1px solid var(--border);
  padding: 0 var(--sp-1);
  border-radius: var(--r-sm);
  font-family: var(--font-mono);
  font-size: 0.9em;
}
</style>
