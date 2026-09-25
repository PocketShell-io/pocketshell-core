/**
 * The session panel's tree, derived once and read by everything that needs it.
 *
 * `SessionTree.vue` computed this privately, and that was fine while it was the
 * only reader. It is not any more: `Ctrl+↑` / `Ctrl+↓` move to the previous or
 * next FOLDER WORKSPACE, and the chord is owned by `HostWorkspaceView` because
 * that is where the route lives — so two components now need the same list, in
 * the same order, keyed the same way.
 *
 * Deriving it twice would be the exact failure this codebase has already paid
 * for once. `$HOME` decides whether a folder is keyed `~/git/foo` or
 * `/home/me/git/foo`, and two spellings of one key is a panel row that opens a
 * workspace with no tabs in it — the bug `sessionGrouping`'s `rootHostPath`
 * exists to prevent on the other side of the same conversion. A chord that
 * navigated by a key the panel spells differently would put the user in an
 * empty workspace and highlight no row, which reads as the folder having
 * vanished.
 *
 * So the derivation moves HERE, and both call sites read it. Everything in it
 * is the code that used to sit in `SessionTree`, unchanged in behaviour: the
 * store reads are the same, the `$HOME` fallback is the same, and
 * `groupSessionsIntoRoots` is the same pure function it always was.
 *
 * ## The user's manual arrangement is applied HERE, for the same reason
 *
 * A dragged folder row changes the order the panel
 * draws, and `Ctrl+↑`/`Ctrl+↓` must walk the order the panel draws — the chord
 * exists to move between the rows the user can see, and a chord that skipped a
 * row or visited them in a second order would be a different feature wearing
 * the same keys. So the ranking is applied in this file, on top of the
 * projection and below both readers, exactly as `$HOME` is: one derivation, two
 * consumers, no chance of disagreement.
 *
 * ## The pipeline, and the quick search at its end
 *
 * The full derivation is four pure stages: the host's order
 * (`groupSessionsIntoRoots`), the user's picked sort (`applyFolderSort`),
 * the user's dragged arrangement (`applyFolderOrder`), and the quick search
 * (`filterFolderRoots`) — the only stage that REMOVES rows rather than
 * ordering them. It runs last so that everything downstream — the rows, the
 * chord, the collapsed rail's switcher — sees exactly the tree the panel
 * draws: a `Ctrl+↓` that opened a workspace whose row the filter is hiding
 * would be this file's two-derivations bug, one level up. The one reader that
 * must NOT see the filter is a count that describes the host, which is why
 * `allFolders` is published beside `folders`.
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { filterFolderRoots } from './folderFilter';
import { applyFolderOrder } from './folderOrder';
import { applyFolderSort } from './folderSort';
import { inferHome } from './sessionRoots';
import { groupSessionsIntoRoots, type SessionDirectory, type SessionRootFolder } from './sessionTree';
import { useConnectionStore } from './stores/connection';
import { useProjectsStore } from './stores/projects';
import { useSessionsStore } from './stores/sessions';
import { useSettingsStore } from './stores/settings';

export interface FolderTree {
  /**
   * The host's `$HOME`, resolved or inferred. Null only when it could not be
   * had either way, which is the case the panel's `+` renders disabled for.
   */
  home: ComputedRef<string | null>;
  /**
   * The `~/.ssh/config` alias of the host these folders are on, or `''` when
   * nothing is connected.
   *
   * Published because it is the key the manual arrangement is stored under, and
   * the component that WRITES a drag has to spell that key exactly as the code
   * that reads it does. One definition, handed out, rather than two call sites
   * both reaching into the connection store and one of them eventually reaching
   * for `hostname` or `connectionId` instead.
   */
  host: ComputedRef<string>;
  /** Root sections, in panel order — sorted, arranged, then quick-searched. */
  roots: ComputedRef<SessionRootFolder[]>;
  /**
   * Every folder row, flattened in the order they are DRAWN — root by root,
   * folders inside each, the quick search's survivors included. This is the
   * list an arrow key walks, and it is
   * flattened rather than nested because a `Ctrl+↓` at the last folder of `git`
   * means the first folder of the next root: the user is stepping down the
   * PANEL, and the root headers they pass are not stops, they are labels.
   */
  folders: ComputedRef<SessionDirectory[]>;
  /**
   * The same walk over the tree BEFORE the quick search cut it — what the
   * panel would draw with an empty query. The one honest source for counts
   * that describe the HOST ("how much is running") rather than the view: a
   * number that shrinks because a filter is active is a number about the
   * filter, and the collapsed rail's tooltip is not the place to learn that.
   */
  allFolders: ComputedRef<SessionDirectory[]>;
  /**
   * The quick search's text, shared by every reader of the derivation.
   *
   * Module state rather than component state because the panel's input WRITES
   * it and two other readers consume the result: the rows that draw it, and
   * `Ctrl+↑`/`Ctrl+↓`, which must walk the rows the panel DRAWS — a chord that
   * opened a workspace whose row the filter is hiding would be the exact
   * two-derivations bug this file exists to prevent, one level up.
   *
   * Not persisted on purpose: a filter is where the user is looking right now,
   * not a preference (folderSort's setting comment draws that line). It clears
   * when the panel unmounts with the route and when a session the user just
   * created needs revealing (SessionTree's create path) — both deliberate
   * forgettings.
   */
  filterQuery: Ref<string>;
  /** True while the quick search holds a non-blank query. */
  filtering: ComputedRef<boolean>;
}

export function useFolderTree(): FolderTree {
  const connection = useConnectionStore();
  const projects = useProjectsStore();
  const sessions = useSessionsStore();
  const settings = useSettingsStore();

  /**
   * Read from the projects store, with an inference from the session paths as
   * the fallback so a host whose `$HOME` never resolved still groups instead of
   * dropping every session into `other`. `groupSessionsIntoRoots` infers on its
   * own when handed null, so passing an already-inferred home through it is
   * idempotent — this widens where the answer is visible, it does not change it.
   */
  const home = computed(() => projects.home ?? inferHome(sessions.sessions.map((s) => s.path)));

  /**
   * `HostEntry.name` is the `Host` directive from `~/.ssh/config` — the same
   * string `FolderWorkspaceView` reads off the route as `:name` and keys its
   * tab order on, so the two persisted arrangements agree about what a host is
   * called without either of them knowing about the other.
   */
  const host = computed(() => connection.activeHost?.name ?? '');

  /**
   * The panel's order, in its three stages.
   *
   * The HOST's order first (`groupSessionsIntoRoots` folds the listing
   * document-order), then the sort the user picked (`applyFolderSort` — a no-op
   * for the `host` key, which is what a user who never opened the sort menu
   * sees), then the user's own dragged arrangement on top (`applyFolderOrder`
   * — a manual position wins over both; unranked folders keep the sorted order
   * relative to each other, because both projections are stable).
   *
   * Pure projections, deliberately: the sessions store refreshes every five
   * seconds and this recomputes each time, so every stage is re-APPLIED rather
   * than remembered. Nothing here mutates the store, holds a copy of the row
   * list, or reconciles anything — which is what makes a drag survive the poll
   * instead of racing it.
   */
  const grouped = computed(() =>
    applyFolderSort(
      groupSessionsIntoRoots(
        sessions.sessions,
        home.value,
        settings.sessionRootsFor(host.value),
      ),
      settings.sessionTreeSort,
    ),
  );
  const arranged = computed(() =>
    applyFolderOrder(grouped.value, settings.folderOrderFor(host.value)),
  );

  /**
   * The quick search's text. One module-scope ref, shared by every component
   * that calls this composable — see `filterQuery` on the returned shape for
   * why it is shared and why it is deliberately ephemeral.
   */
  const filterQuery = ref('');

  // The filter is the LAST stage and the only one that removes rows rather
  // than reordering them: what survives is what the panel draws, and both
  // readers below (`Ctrl+↑`/`Ctrl+↓`, the switcher) must see exactly that.
  const roots = computed(() => filterFolderRoots(arranged.value, filterQuery.value));

  const folders = computed(() => roots.value.flatMap((root) => root.directories));
  const allFolders = computed(() => arranged.value.flatMap((root) => root.directories));
  const filtering = computed(() => filterQuery.value.trim() !== '');

  return { home, host, roots, folders, allFolders, filterQuery, filtering };
}
