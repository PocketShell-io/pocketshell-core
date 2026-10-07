import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import { api } from '../ipc';
import type { ConnectionStateEvent } from '../api';
import type {
  BootstrapResult,
  ConnectionId,
  ConnectionState,
  HostEntry,
  HostKeyTrustChoice,
  HostKeyTrustRequest,
} from '@pocketshell/core';
import { MAX_ATTEMPTS } from '@pocketshell/core/shared/reconnectBackoff';
import { ReconnectLoop } from '../reconnectLoop';
import { useFilesStore } from './files';
import { useSessionsStore } from './sessions';
import { useProjectsStore } from './projects';
import { useComposerStore } from './composer';
import { useHostsStore } from './hosts';
import { errorMessage } from '@pocketshell/core/shared/errors';

/**
 * Connection store: owns the active connection to a host and its bootstrap
 * result. View state only — no keys or ssh2 objects ever live here.
 *
 * ## The automatic reconnect FSM
 *
 * A transport drop used to dead-end in this store: `state` flipped to 'lost'
 * and the user was handed a button. The store now answers the drop itself,
 * with the schedule the port-forward work already chose (shared/
 * reconnectBackoff.ts — 5→10→20→40→60s, capped at MAX_ATTEMPTS so a host that
 * is actually gone is not hammered forever). The FSM lives HERE — in the
 * renderer, not in main — for the same reason the old supervisor was cut:
 * this app keeps ONE dialler per connection, and everything a reconnect has
 * to revive — bootstrap, session list, forwards — is already orchestrated
 * from this file's `connect()`. Main only reports the drop; it never redials.
 * The curve-and-timer machinery itself is {@link ReconnectLoop}, a plain
 * module this store drives; the decisions (when to begin, what a manual
 * retry means) stay here.
 *
 * A manual `reconnect()` supersedes a pending schedule without discarding its
 * attempt budget, and an explicit `disconnect()` cancels the whole thing —
 * nobody wants the app re-dialling a host they just left.
 *
 * ## When the transport owns recovery (#2954, D28/D42)
 *
 * A platform whose `ssh` group has `reconnect` (Android: core's
 * `ConnectionController`) re-dials by itself and keeps the connection id
 * stable. Running the loop above beside it is two ladders racing — a second,
 * slower re-dial after the controller already recovered or gave up. So with
 * that capability this store makes no reconnect decision at all: the
 * `ReconnectLoop` never starts, the resume probe is the transport's, the
 * banner reads the transport's `reconnecting` state and attempt count
 * ({@link transportRetry}), and Retry is `api.ssh.reconnect(id)`.
 */
export const useConnectionStore = defineStore('connection', () => {
  const hosts = ref<HostEntry[]>([]);
  const connectionId = ref<ConnectionId | null>(null);
  const state = ref<ConnectionState>('idle');
  const error = ref<string | null>(null);
  const bootstrap = ref<BootstrapResult | null>(null);
  /** The host we are currently connected to (for the workspace header). */
  const activeHost = shallowRef<HostEntry | null>(null);

  /**
   * The key last used to dial {@link activeHost}, kept so a dropped link can be
   * re-dialled without asking the user to re-pick it.
   */
  const lastKeyPath = ref<string | undefined>(undefined);

  /**
   * The first-contact host key a dial is waiting on, when the platform asks
   * (`ssh.onTrustDecision`). `HostKeyTrustGate` renders it; `answerTrust`
   * resolves it. `pendingTrustSeq` changes with every new question so the
   * prompt remounts even when the same host asks twice in a row.
   */
  const pendingTrust = shallowRef<HostKeyTrustRequest | null>(null);
  const pendingTrustSeq = ref(0);
  let resolvePendingTrust: ((choice: HostKeyTrustChoice) => void) | null = null;

  /**
   * Whether the platform asks the user about unknown host keys. Optional by
   * presence: without the hook the platform keeps its own policy and this
   * store dials with the historical trust-on-first-use answer, unchanged.
   */
  const asksTrust = typeof api.ssh.onTrustDecision === 'function';
  if (asksTrust) {
    api.ssh.onTrustDecision!((request) =>
      new Promise<HostKeyTrustChoice>((resolve) => {
        // One question at a time: a newer dial's question supersedes an
        // unanswered older one, which is refused (fail closed).
        resolvePendingTrust?.('reject');
        pendingTrustSeq.value += 1;
        pendingTrust.value = { ...request };
        resolvePendingTrust = (choice) => {
          resolvePendingTrust = null;
          pendingTrust.value = null;
          resolve(choice);
        };
      }),
    );
  }

  /** The user's answer to {@link pendingTrust}; a no-op when nothing waits. */
  function answerTrust(choice: HostKeyTrustChoice): void {
    resolvePendingTrust?.(choice);
  }

  /**
   * The old id while a reconnect is replacing it. The explicit close emits an
   * `idle` state asynchronously; ignore that stale event while the workspace
   * is still mounted on the old id, or it can hide the reconnect banner.
   */
  let replacingConnectionId: ConnectionId | null = null;

  /**
   * Whether the transport owns recovery — see the header. Read once: a
   * platform provides its API before any store exists and never swaps it.
   */
  const transportOwnsRecovery = typeof api.ssh.reconnect === 'function';

  /**
   * The transport's ladder while it re-dials: the dial in progress and its
   * budget (`maxAttempts` null when the transport does not say). Null when
   * no transport-owned recovery is running.
   */
  const transportRetry = ref<{ attempt: number; maxAttempts: number | null } | null>(null);

  const loop = new ReconnectLoop({
    hasTarget: () => activeHost.value != null,
    dial: reconnect,
    onDialFailed: () => {
      // connect() lands a failed dial on 'idle' — the same value a fresh app
      // has. The link is still gone, so put the state back where the banner
      // and the next curve step expect it.
      state.value = 'lost';
    },
    onGiveUp: () => {
      state.value = 'lost';
      error.value = `Could not reconnect after ${MAX_ATTEMPTS} attempts.`;
    },
  });

  /**
   * Learn when the transport drops.
   *
   * The main process has always emitted this (ipc.ts, `ssh:event:state`) and
   * the preload has always bridged it, but nothing in the renderer subscribed —
   * so a link that died left the store reporting `connected` with a
   * connectionId whose record main had already torn down. Every subsequent call
   * on it failed, and the two surfaces that matter both failed silently: the
   * terminal pane stayed blank and the Files tab rendered an empty directory.
   * The only cure was a manual disconnect/reconnect, which is exactly the
   * symptom that says the UI never learned.
   *
   * `connectionId` is deliberately NOT cleared here. It gates `v-if` on the
   * terminal and Files panes, so nulling it would unmount them and throw away
   * the user's scrollback at the precise moment they want to read it. The
   * state flag is enough for the UI to say the link is gone; calls made
   * against the dead id now report their own failure rather than vanishing.
   *
   * Since F12 the drop also STARTS something: the automatic reconnect below.
   *
   * Subscribed for the store's lifetime — a Pinia setup store is created once,
   * and this must outlive any individual view.
   */
  api.ssh.onState((payload) => {
    if (
      payload.connectionId !== connectionId.value ||
      payload.connectionId === replacingConnectionId
    ) {
      return;
    }
    if (transportOwnsRecovery) {
      followTransportRecovery(payload);
      return;
    }
    state.value = payload.state;
    if (payload.state === 'lost') {
      error.value = 'Connection lost';
      loop.begin();
    }
  });

  /**
   * Mirror a recovery-owning transport's state; decide nothing. A link that
   * comes back re-reads the surfaces a dead link left stale — the id did not
   * change, but a poll that ran mid-recovery may have left its failure on
   * screen.
   */
  function followTransportRecovery(payload: ConnectionStateEvent): void {
    const previous = state.value;
    state.value = payload.state;
    if (payload.state === 'reconnecting') {
      transportRetry.value = { attempt: payload.attempt ?? 0, maxAttempts: payload.maxAttempts ?? null };
      error.value = payload.error ?? 'Connection lost';
      return;
    }
    transportRetry.value = null;
    if (payload.state === 'lost') {
      error.value = payload.error ?? 'Connection lost';
      return;
    }
    if (payload.state === 'connected' && (previous === 'reconnecting' || previous === 'lost')) {
      error.value = null;
      void recoverSurfaces(payload.connectionId);
    }
  }

  // Sleep/wake (F12). A machine that slept is the classic SILENT drop: the
  // peer is gone (NAT entry expired, network changed) but the local TCP stack
  // will not say so until a write fails, and ssh2's keepalive can sit on that
  // for ~45s of silence. Main announces the resume — the SUBSCRIPTION lives
  // in renderer/main.ts, not here, so a component test that creates this
  // store under a partial ipc mock (they all do) is not required to provide
  // the channel. This action answers the announcement with a one-byte probe —
  // `true` is the cheapest thing a shell executes — and a probe that does not
  // exit 0 is treated as the drop it almost always is. Main's own keepalive
  // will confirm shortly after; `startAutoReconnect` is idempotent, so
  // whichever notice lands first wins.
  async function onOsResume(): Promise<void> {
    // A recovery-owning transport reconciles resume itself (Android drives
    // the controller's background grace from its own lifecycle).
    if (transportOwnsRecovery) return;
    if (state.value !== 'connected' || !connectionId.value) return;
    const probe = await api.ssh.exec(connectionId.value, 'true').catch(() => null);
    if (probe && probe.exitCode === 0) return;
    if (state.value !== 'connected') return; // main's event beat us to it
    state.value = 'lost';
    error.value = 'Connection lost';
    loop.begin();
    // No reason to make the user wait out the first 5s: the resume IS the
    // likely recovery moment (laptop opened, network back), so dial now.
    await retryNow();
  }

  /**
   * Fill {@link hosts} from the platform's host source: the platform-owned
   * saved-host store when it provides one (the hosts store mirrors it into
   * this list), otherwise the host list it reads (`~/.ssh/config`, the
   * synced account).
   */
  async function loadHosts(): Promise<void> {
    if (api.hosts?.store) {
      await useHostsStore().load();
      return;
    }
    hosts.value = await api.ssh.listConfigHosts();
  }

  /**
   * Re-dial the host we were last connected to, after a drop — the one dial
   * both the banner button and the automatic loop go through.
   *
   * On success this also wakes the surfaces that went stale with the dead id
   * ({@link recoverSurfaces}); that recovery belongs HERE, because a reconnect
   * mints a NEW connectionId and everything keyed by the old one needs to
   * re-read against it, no matter which of the two entry points dialled.
   *
   * Returns false when there is nothing to re-dial — this is for recovering a
   * link that died, not for opening the first one.
   */
  async function reconnect(): Promise<boolean> {
    const host = activeHost.value;
    if (!host) return false;
    if (transportOwnsRecovery) return reconnectThroughTransport();
    // A manual dial supersedes a pending automatic one. The backoff keeps its
    // attempt position: a user pressing the button 4s into a 5s wait is saying
    // "now", not "start the curve over" — the schedule only resets on success.
    loop.clearPendingStep();
    const previousConnectionId = connectionId.value;
    if (previousConnectionId) {
      replacingConnectionId = previousConnectionId;
      // Best-effort: main has usually torn the record down already, and a
      // close on an unknown id must not stop the re-dial.
      await api.ssh.close(previousConnectionId).catch(() => undefined);
    }
    const ok = await connect(host, lastKeyPath.value, previousConnectionId ?? undefined);
    if (ok && connectionId.value) {
      replacingConnectionId = null;
      loop.succeeded();
      await recoverSurfaces(connectionId.value);
    }
    return ok;
  }

  /**
   * Retry on a recovery-owning transport: ask IT to recover the same logical
   * connection. It joins a ladder already running rather than starting a
   * second one, and the id does not change, so nothing is re-keyed.
   */
  async function reconnectThroughTransport(): Promise<boolean> {
    const id = connectionId.value;
    const reconnectTransport = api.ssh.reconnect;
    if (!id || !reconnectTransport) return false;
    let ok: boolean;
    try {
      ok = await reconnectTransport(id);
    } catch (e) {
      error.value = errorMessage(e);
      ok = false;
    }
    if (connectionId.value !== id) return false; // disconnected meanwhile
    if (!ok) {
      if (state.value !== 'reconnecting') state.value = 'lost';
      return false;
    }
    transportRetry.value = null;
    state.value = 'connected';
    error.value = null;
    await recoverSurfaces(id);
    return true;
  }

  /**
   * Skip the wait: dial now, under the running curve's budget.
   *
   * With no curve running this is a plain `reconnect()` — the button's old
   * behaviour, which is what the banner falls back to once the budget is
   * spent.
   */
  async function retryNow(): Promise<void> {
    if (transportOwnsRecovery || !loop.running) {
      await reconnect();
      return;
    }
    await loop.skipWait();
  }

  /**
   * Re-read everything that was keyed by the dead connection id.
   *
   * The sessions refresh is not a courtesy: the panel's last poll against the
   * old id is what left a raw "Unknown connection" rejection on screen, and
   * refreshing against the new id replaces both the stale list and that
   * message in one move. Forwarding is restored by `connect()` before it
   * exposes the new connection id, so a drop does not silently turn off
   * forwarding for everyone who had it on.
   *
   * Bootstrap needs no line here: `connect()` already fires it in the
   * background, and the UI surfaces the result when it lands.
   */
  async function recoverSurfaces(id: ConnectionId): Promise<void> {
    await useSessionsStore()
      .refresh(id, { quiet: true })
      .catch(() => undefined);
  }

  /**
   * Restore the host's remembered auto-forward setting before a new
   * connection becomes visible to the workspace.
   *
   * The ports overlay used to be the only caller of `forwards.init`, so the
   * header could truthfully read the persisted ON flag while no local tunnel
   * existed. Keep the check here, at the connection boundary: it covers both
   * the first connection after an app restart and a reconnect, without making
   * opening an otherwise unrelated overlay a side effect.
   *
   * Forward specs are copied field by field because a host selected from the
   * Pinia `hosts` ref may be a reactive proxy, which Electron's structured
   * clone cannot carry through `ipcRenderer.invoke`.
   */
  async function restoreAutoForward(id: ConnectionId, host: HostEntry): Promise<void> {
    try {
      if (!(await api.forwards.isAutoEnabled(id))) return;
      const configForwards = host.localForwards.map((forward) => ({
        kind: forward.kind,
        listenHost: forward.listenHost,
        listenPort: forward.listenPort,
        destHost: forward.destHost,
        destPort: forward.destPort,
      }));
      await api.forwards.startAuto(id, configForwards);
    } catch {
      // A successful SSH connection must not be reported as failed because a
      // best-effort forwarding restore could not be queried or started.
    }
  }

  async function connect(
    host: HostEntry,
    privateKeyPath?: string,
    preserveComposerFrom?: ConnectionId,
  ): Promise<boolean> {
    // Remote homes and SFTP browser paths belong to the connection, not to the
    // host-picker singleton. Clear them before a new dial so a workspace or
    // dialog cannot briefly render the previous host while this one connects.
    useProjectsStore().clear();
    state.value = 'connecting';
    error.value = null;
    activeHost.value = host;
    lastKeyPath.value = privateKeyPath;
    let result: Awaited<ReturnType<typeof api.ssh.connect>>;
    try {
      result = await api.ssh.connect({
        host: host.hostname,
        port: host.port,
        user: host.user || '',
        privateKeyPath: privateKeyPath ?? host.identityFile ?? undefined,
        // Transport intent rides to the platform boundary verbatim (issue
        // #3059): the store decides nothing about support, it only refuses to
        // drop the marker. A malformed value stays malformed — normalizing it
        // here is how a gateway host would quietly become an ordinary SSH
        // dial. A platform without gateway support refuses a present marker
        // at its boundary, before credentials or sockets.
        ...transportMarkers(host),
        // A platform that asks (`ssh.onTrustDecision`) gets NO standing
        // decision: an unknown key must reach the user, never pin silently.
        ...(asksTrust ? {} : { tofuDecision: 'accept-always' as const }),
      });
    } catch (e) {
      // A rejected invoke is a failed dial, not an exception to bubble: leave
      // `state` at 'connecting' and this store would hold the picker's rows
      // disabled forever with no message anywhere.
      state.value = 'idle';
      error.value = errorMessage(e);
      return false;
    }
    if (result.ok && result.connectionId) {
      // Do this while the picker still owns the connection attempt. Once the
      // new id is exposed, HostWorkspaceView can render the persisted ON
      // indicator knowing the engine has already been asked to resume.
      await restoreAutoForward(result.connectionId, host);
      if (preserveComposerFrom && preserveComposerFrom !== result.connectionId) {
        useComposerStore().rekeyConnection(preserveComposerFrom, result.connectionId);
      }
      connectionId.value = result.connectionId;
      state.value = 'connected';
      // Fire bootstrap in the background; the UI surfaces it when it lands.
      // A rejection (the link dropped right after connect) is swallowed:
      // `bootstrap` staying null keeps the missing-tools strip quiet, which
      // beats an unhandled rejection paging the diag banner for a connection
      // that is already gone.
      void api.helper
        .bootstrap(result.connectionId)
        .then((b) => {
          bootstrap.value = b;
        })
        .catch(() => undefined);
      return true;
    }
    state.value = 'idle';
    error.value = result.error ?? 'Connection failed';
    return false;
  }

  /**
   * The host entry's transport markers for the connect payload: `link` and
   * `gateway`, copied with their RAW values when (and only when) the entry
   * carries them. Hosts reach this store as parsed JSON, so a marker's value
   * may be anything at all; presence, not shape, is what the platform guard
   * needs, and an ordinary host's payload must carry neither key.
   */
  function transportMarkers(host: HostEntry): { link?: unknown; gateway?: unknown } {
    const raw = host as unknown as Record<string, unknown>;
    const markers: { link?: unknown; gateway?: unknown } = {};
    if (Object.prototype.hasOwnProperty.call(host, 'link')) markers['link'] = raw['link'];
    if (Object.prototype.hasOwnProperty.call(host, 'gateway')) markers['gateway'] = raw['gateway'];
    return markers;
  }

  async function disconnect(): Promise<void> {
    // First, not last: it must also orphan a recovery dial already on the
    // wire, whose success would otherwise undo the disconnect.
    loop.cancel();
    // A dial still waiting on the user's host-key answer is abandoned too.
    answerTrust('reject');
    if (connectionId.value) {
      // Drop this host's browsing state BEFORE the id is forgotten. The files
      // store is a singleton keyed by connection, and this is the guarantee
      // that one host's listing can never be shown for another — the reason
      // `clear()` exists. It used to be triggered by the Files tab
      // unmounting, which fired on every tab switch and cost the user their
      // place; disconnect is the event that actually invalidates the state.
      useFilesStore().clear(connectionId.value);
      useProjectsStore().clear();
      await api.ssh.close(connectionId.value);
    }
    connectionId.value = null;
    replacingConnectionId = null;
    transportRetry.value = null;
    state.value = 'idle';
    bootstrap.value = null;
    activeHost.value = null;
    lastKeyPath.value = undefined;
  }

  return {
    hosts,
    connectionId,
    state,
    error,
    bootstrap,
    activeHost,
    pendingTrust,
    pendingTrustSeq,
    answerTrust,
    autoRetry: loop.autoRetry,
    retryIn: loop.retryIn,
    recovering: computed(() => loop.recovering.value || transportRetry.value !== null),
    transportOwnsRecovery,
    transportRetry,
    loadHosts,
    connect,
    reconnect,
    retryNow,
    onOsResume,
    disconnect,
  };
});
