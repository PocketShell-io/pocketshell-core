import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../ipc';
import type { ConnectionId } from '@pocketshell/core';
import type { UsageRow } from '@pocketshell/core';
import { parseProfileRows, type AgentProfile } from '@pocketshell/core';
import { errorMessage } from '@pocketshell/core/shared/errors';

/**
 * Agents store: the provider-usage dashboard rows, and nothing else.
 *
 * It used to also hold the CONVERSATION of the selected session — messages,
 * the transcript the messages came from, and a stale-reply guard keyed on the
 * session name. That whole half is gone, with the feature: the user asked for
 * conversations to be dropped completely, so the tab,
 * the transcript resolver, the `agent-log` client and the IPC behind them were
 * removed rather than left as an unused path.
 *
 * `loading` survived that cut and is worth a note, because it is the one thing
 * the removal could have broken silently. It was written ONLY by the
 * conversation loader, but it is READ by the usage refresh button in
 * UsageView.vue and HostWorkspaceView.vue — so deleting the writer would have
 * left a spinner that never spins and a button that is never disabled, with
 * nothing to say why. `loadUsage` owns it now.
 */
export const useAgentsStore = defineStore('agents', () => {
  const usage = ref<UsageRow[]>([]);
  /** True while `loadUsage` is in flight — drives the refresh spinner. */
  const loading = ref(false);
  /**
   * Set when the usage fetch itself failed, distinguishing "this host reports
   * no usage" from "we could not ask" — the same split `profilesError` below
   * exists for, and for the same reason: an empty table is a normal state the
   * panel explains in a line, whereas a failed fetch (no helper on the host, a
   * dropped link) deserves to be said out loud so the user knows the numbers
   * are missing rather than zero. Before this ref existed, `loadUsage` had a
   * try/finally with no catch, so the rejection escaped to whichever button
   * handler called it and the panel silently kept whatever it had.
   */
  const usageError = ref<string | null>(null);

  /**
   * Never rejects. A failure lands in `usageError` and deliberately does NOT
   * blank `usage`: a refresh that fails mid-session leaves the previous rows in
   * place, because a table that is a few minutes old with a reason attached
   * beats an empty one — the same call the sessions store makes for its poll.
   */
  async function loadUsage(connectionId: ConnectionId): Promise<void> {
    loading.value = true;
    usageError.value = null;
    try {
      usage.value = await api.helper.usage(connectionId);
    } catch (e) {
      usageError.value = errorMessage(e) || 'Could not read this host’s provider usage.';
    } finally {
      loading.value = false;
    }
  }

  /**
   * The host's agent profiles, for the launch dialog's profile picker.
   *
   * Profiles are defined ONCE on the host (the helper auto-discovers `~/.claude`,
   * `~/.zlaude`, `~/.codex` and reads an optional `profiles.yaml`), which is why
   * the client fetches them instead of storing them per-host — the same reason
   * the phone's `ProfilesGateway` exists. `agent:profiles` has been wired end to
   * end since 88cc932 fixed the `{"profiles": […]}` envelope, but nothing in the
   * renderer called it until the launch dialog did.
   */
  const profiles = ref<AgentProfile[]>([]);
  /** True while `loadProfiles` is in flight. */
  const profilesLoading = ref(false);
  /**
   * Set when the fetch itself failed, distinguishing "this host has no profiles"
   * from "we could not ask".
   *
   * The phone collapses both to an empty list and shows nothing — a host with no
   * CLI, a failing probe and a host with one profile all look identical there.
   * The desktop keeps them apart because it has the room to: an empty list is a
   * normal state the dialog explains in a line, whereas a failed fetch is worth
   * saying out loud so the user knows the picker is missing options rather than
   * that the host has none. Neither blocks the launch — a profile is optional,
   * and the engine default is exactly what omitting `--profile` selects.
   */
  const profilesError = ref<string | null>(null);
  /**
   * Which connection `profiles` describes, so a stale response from the host we
   * just left cannot overwrite the one we are on (the phone guards the same race
   * with a generation counter plus an `isCurrentHost` check).
   */
  let profilesFor: ConnectionId | null = null;

  async function loadProfiles(connectionId: ConnectionId): Promise<void> {
    profilesLoading.value = true;
    profilesError.value = null;
    profilesFor = connectionId;
    try {
      const rows = await api.agent.profiles(connectionId);
      if (profilesFor !== connectionId) return;
      profiles.value = parseProfileRows(rows);
    } catch (e) {
      if (profilesFor !== connectionId) return;
      profiles.value = [];
      profilesError.value = errorMessage(e) || 'Could not list this host’s agent profiles.';
    } finally {
      if (profilesFor === connectionId) profilesLoading.value = false;
    }
  }

  /** The available engine IDs from `a engines --json`, or null on failure. */
  const agentKinds = ref<readonly string[] | null>(null);
  /** True after the current open's engine query finishes, including failure. */
  const agentKindsResolved = ref(false);
  /**
   * Names found on the host's PATH (`pocketshell` and offline-fallback
   * executables), or null when the independent path probe failed.
   */
  const agentBinaries = ref<readonly string[] | null>(null);
  /** True while `loadAgentKinds` is in flight — lets "no" be said as "not yet". */
  const agentKindsProbing = ref(false);
  /** @see profilesFor — same stale-response guard, same reason. */
  let agentKindsFor: ConnectionId | null = null;
  /** Each dialog open is a new query, even when it targets the same connection. */
  let agentKindsRequestGeneration = 0;

  /**
   * Ask the host which engines it can launch.
   *
   * The platform API reads `a engines --json` and returns only available
   * engine IDs. Re-asked on every open rather than cached per host, because
   * the host's engine config and installed commands can change while the app
   * is open.
   *
   * Never rejects. A failure leaves `agentKinds` null, which the dialog reads
   * as offline and handles with the small static fallback in
   * shared/agentLaunch.ts.
   */
  async function loadAgentKinds(connectionId: ConnectionId): Promise<void> {
    const requestGeneration = ++agentKindsRequestGeneration;
    agentKindsProbing.value = true;
    agentKindsResolved.value = false;
    agentKinds.value = null;
    agentBinaries.value = null;
    agentKindsFor = connectionId;
    // Keep the catalog result separate from the path probe. A catalog row's
    // `available` field is authoritative online; the binary list is retained
    // for the launcher and offline fallback checks.
    try {
      const [kinds, binaries] = await Promise.all([
        api.agent.kinds(connectionId).catch(() => null),
        api.agent.binaries(connectionId).catch(() => null),
      ]);
      if (agentKindsFor !== connectionId || requestGeneration !== agentKindsRequestGeneration) return;
      // Anything that is not a list is "unknown", which is what null means
      // here. The main process already answers `string[] | null`, so this is
      // the belt to that braces — but the value crosses an IPC boundary and a
      // shape that slipped through would otherwise become an empty list, i.e.
      // a host that claims it can launch nothing.
      agentKinds.value = Array.isArray(kinds) ? kinds : null;
      agentBinaries.value = Array.isArray(binaries) ? binaries : null;
    } finally {
      if (agentKindsFor === connectionId && requestGeneration === agentKindsRequestGeneration) {
        agentKindsProbing.value = false;
        agentKindsResolved.value = true;
      }
    }
  }

  return {
    usage,
    loading,
    usageError,
    loadUsage,
    profiles,
    profilesLoading,
    profilesError,
    loadProfiles,
    agentKinds,
    agentKindsResolved,
    agentBinaries,
    agentKindsProbing,
    loadAgentKinds,
  };
});
