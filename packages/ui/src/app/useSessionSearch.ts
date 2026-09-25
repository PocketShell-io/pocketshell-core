/**
 * The session panel's quick search — the summoned filter row's state machine,
 * lifted out of `SessionTree.vue` as a design-gate payment (the view sits
 * under CLEAN_CODE's 1000-line cap only while whole concerns live in their
 * own modules; this one's is 60 lines and a clean seam).
 *
 * The row exists ONLY while summoned — `sessions.filterTree` (Ctrl+Shift+F)
 * opens it focused, Escape clears and closes it, Enter takes the first match
 * and closes. The Files pane's Ctrl+F is the pattern being copied whole, and
 * the reason is the same one that killed the permanent strip this row
 * replaced: the panel is the app's front door and 36px of always-on chrome
 * for a tool used in bursts was space the rows were paying for. A filter you
 * summon is where you are looking RIGHT NOW; when the look ends, the row
 * leaves with it.
 *
 * The TEXT lives in the shared derivation (folderTree.ts's `filterQuery`),
 * not here: `Ctrl+↑`/`Ctrl+↓` and the collapsed rail's switcher must see
 * exactly the rows the panel draws, and a second copy of the query they
 * cannot read would put the chord on hidden rows — the two-derivations bug
 * that file exists to prevent, one level up. The rules the match itself obeys
 * live in folderFilter.ts.
 */
import { nextTick, ref, type ComputedRef, type Ref } from 'vue';
import type { SessionDirectory } from './sessionTree';

export interface SessionSearchDeps {
  /** The rows the panel draws, flat — Enter's "first match" reads this. */
  folders: ComputedRef<SessionDirectory[]>;
  /** The shared query ref (folderTree.ts) — the input writes it. */
  filterQuery: Ref<string>;
  /** Enter's landing: the panel's own select, the same emit a row click makes. */
  onSelect: (dir: SessionDirectory) => void;
}

export function useSessionSearch(deps: SessionSearchDeps): {
  searchOpen: Ref<boolean>;
  filterEl: Ref<HTMLInputElement | null>;
  openSearch: () => void;
  closeSearch: () => void;
  onFilterEnter: () => void;
  onFilterEscape: () => void;
} {
  const searchOpen = ref(false);
  const filterEl = ref<HTMLInputElement | null>(null);

  /** Summon the row and put the keyboard in it, previous query selected. */
  function openSearch(): void {
    searchOpen.value = true;
    void nextTick(() => {
      filterEl.value?.focus();
      filterEl.value?.select();
    });
  }

  /**
   * Dismiss: the query goes WITH the row — a closed search keeping its text
   * is a filter the panel still applies with nothing on screen to say so,
   * which is how a tree ends up quietly missing folders.
   */
  function closeSearch(): void {
    searchOpen.value = false;
    deps.filterQuery.value = '';
  }

  /** Enter takes the first visible folder and ends the search. */
  function onFilterEnter(): void {
    const first = deps.folders.value[0];
    if (first) {
      closeSearch();
      deps.onSelect(first);
    }
  }

  function onFilterEscape(): void {
    closeSearch();
  }

  return { searchOpen, filterEl, openSearch, closeSearch, onFilterEnter, onFilterEscape };
}
