import { computed, ref } from 'vue';
import { hostEntryId } from '@pocketshell/core';
import { useConnectionStore } from './stores/connection';
import { useHostsStore } from './stores/hosts';
import { useProjectsStore } from './stores/projects';
import { useSessionsStore } from './stores/sessions';
import { useSettingsStore } from './stores/settings';
import { useWorkspaceRootsStore } from './stores/workspaceRoots';
import { canonicalisePath } from './sessionGrouping';
import { inferHome, normaliseRootPath, OTHER_ROOT, rootForPath, SESSION_ROOTS_MAX } from './sessionRoots';

/**
 * Settings' "Project roots" section: which host it edits, the rows it lists,
 * the suggestions it offers and the add / remove / move it performs — over
 * whichever root source is in force (stores/workspaceRoots.ts: the host's own
 * registrations when the platform provides them, else the per-host Settings
 * list). Split out of SettingsView so the view keeps only the markup.
 */
export function useProjectRoots() {
  const connection = useConnectionStore();
  const projects = useProjectsStore();
  const sessions = useSessionsStore();
  const settings = useSettingsStore();
  const workspaceRoots = useWorkspaceRootsStore();
  const hostList = useHostsStore();

  /**
   * The host whose project roots this section edits.
   *
   * A connected workspace supplies its active alias, so opening Settings there
   * cannot accidentally edit another instance. When Settings is opened from
   * the disconnected host picker, the user chooses an alias explicitly before
   * the root controls become active.
   */
  const selectedRootHost = ref('');
  const rootHost = computed(() => connection.activeHost?.name ?? selectedRootHost.value);
  /**
   * Host-registered roots (the platform provides `api.workspaces`) live on the
   * host, so they can be listed and changed only for the host this workspace is
   * connected to; the Settings list is per alias and editable from anywhere.
   */
  const rootsOnHost = computed(() => workspaceRoots.hostManaged);
  const rootsEditable = computed(
    () => !!rootHost.value && (!rootsOnHost.value || rootHost.value === connection.activeHost?.name),
  );
  /** One row per registered root: `path` is what remove/move take, `label` what is shown. */
  const rootRows = computed<{ path: string; label: string }[]>(() => {
    if (!rootsOnHost.value) {
      return settings.sessionRootsFor(rootHost.value).map((root) => ({ path: root, label: root }));
    }
    return workspaceRoots
      .membershipsFor(rootHost.value, projects.home)
      .map((workspace) => ({ path: workspace.path, label: workspace.displayPath }));
  });
  const scopedSessionRoots = computed(() => rootRows.value.map((row) => row.label));

  /**
   * With no active connection, preselect the stored default host so the
   * picker-opened panel lands on the host the user starts on. Session roots
   * are keyed by the host's alias; the default is keyed by its identity
   * (`hostEntryId`: the alias for a config host, the stable id for a saved
   * one), so resolve the row and take its name.
   */
  function selectDefaultRootHost(): void {
    const defaultHostRow = hostList.defaultHostKey
      ? connection.hosts.find((host) => hostEntryId(host) === hostList.defaultHostKey)
      : undefined;
    if (!connection.activeHost && defaultHostRow) {
      selectedRootHost.value = defaultHostRow.name;
    }
  }

  /* --- Session roots -------------------------------------------------------
   * The session panel's top level for the selected host. An empty host entry
   * means "derive roots from $HOME", which is what the panel did before this
   * control existed, so this section is additive: a user who never opens it
   * sees no change.
   * ---------------------------------------------------------------------- */

  const rootDraft = ref('');
  const rootError = ref<string | null>(null);

  /**
   * Roots offered as suggestions: the ones the CURRENT host's sessions are
   * actually running under, minus what is already registered.
   *
   * This exists because a text field alone asks the user to remember paths on a
   * machine they are not looking at. Their real roots are, by definition, where
   * their sessions already are — so the app can just read them off the session
   * list it already has when that host is connected. There is no remote
   * directory scan behind this: the panel can open with no connection at all
   * from the host picker, and a suggestion list that is sometimes empty is
   * better than one that sometimes blocks on SSH. The phone solves it the other
   * way, with a remote directory scan over three guessed parents
   * (WatchedFoldersViewModel.kt:397).
   */
  const rootSuggestions = computed<string[]>(() => {
    // Sessions are only associated with an alias while that host is connected.
    // Do not offer stale rows from a previous connection for a host selected in
    // the disconnected picker.
    if (!rootHost.value || rootHost.value !== connection.activeHost?.name) return [];
    const paths = sessions.sessions.map((session) => session.path);
    const home = projects.home ?? inferHome(paths);
    const out: string[] = [];
    for (const path of paths) {
      const { key } = rootForPath(canonicalisePath(path), home);
      if (key === OTHER_ROOT) continue;
      if (scopedSessionRoots.value.includes(key)) continue;
      if (!out.includes(key)) out.push(key);
    }
    return out.sort();
  });

  const rootsFull = computed(() => scopedSessionRoots.value.length >= SESSION_ROOTS_MAX);

  /**
   * Add whatever is in the field. The store owns normalisation and dedupe, so
   * the only work here is turning its `false` into a sentence — and the two
   * reasons it can refuse a *well-formed* path need telling apart, because
   * "already registered" and "list is full" call for different next actions.
   */
  async function onAddRoot(): Promise<void> {
    const value = rootDraft.value;
    if (!rootHost.value || !value.trim()) return;
    if (normaliseRootPath(value) === null) {
      rootError.value = 'Use an absolute path, or one under ~ — for example ~/git.';
      return;
    }
    if (rootsOnHost.value) {
      // The host registers it; the store keeps the host's refusal (or its
      // unreadable answer) as the section's message.
      rootError.value = null;
      if (await workspaceRoots.add(rootHost.value, value, projects.home)) rootDraft.value = '';
      return;
    }
    if (!settings.addSessionRoot(rootHost.value, value)) {
      rootError.value = rootsFull.value
        ? `That is the limit of ${SESSION_ROOTS_MAX} roots. Remove one first.`
        : 'That root is registered already.';
      return;
    }
    rootDraft.value = '';
    rootError.value = null;
  }

  async function onRemoveRoot(path: string): Promise<void> {
    if (!rootHost.value) return;
    rootError.value = null;
    // Host mode: `workspaces remove` only unregisters the root. The folder, its
    // files and its sessions stay on the host.
    await workspaceRoots.remove(rootHost.value, path);
  }

  function onMoveRoot(path: string, direction: -1 | 1): void {
    if (rootHost.value) workspaceRoots.move(rootHost.value, path, direction, projects.home);
  }

  /** The section's one message: a local refusal, else the host's answer. */
  const rootMessage = computed(() => {
    if (rootError.value) return { tone: 'error', text: rootError.value };
    if (!rootsOnHost.value) return null;
    const state = workspaceRoots.state;
    if (state.mutationError) return { tone: 'error', text: state.mutationError };
    if (state.error) return { tone: 'error', text: state.error };
    if (workspaceRoots.orderLoadError) return { tone: 'error', text: workspaceRoots.orderLoadError };
    if (state.notice) return { tone: 'info', text: state.notice };
    return null;
  });

  return {
    selectedRootHost,
    rootHost,
    rootsOnHost,
    rootsEditable,
    rootRows,
    rootDraft,
    rootSuggestions,
    rootsFull,
    rootMessage,
    selectDefaultRootHost,
    onAddRoot,
    onRemoveRoot,
    onMoveRoot,
  };
}
