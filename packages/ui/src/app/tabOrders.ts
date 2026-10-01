/**
 * The manual tab order's one store, and the reason it is one.
 *
 * The ranking lived only in `useWorkspaceMemory` — a per-workspace ref beside
 * its Files tabs and selection — and that was right until the session panel's
 * folder rows began wearing the same order: the mark run on a row is the
 * folder's tab bar folded flat (`agentBadges`), so the panel must READ the
 * arrangement while the workspace writes it, and the two are mounted
 * side by side. A drag that moved a tab left the row's marks in the old
 * order; the user reported exactly that.
 *
 * So the ranking is promoted to MODULE state on the `filterQuery` precedent
 * (folderTree.ts): one module, one read, one write, and both surfaces cannot
 * disagree because there is nothing to synchronise — they read the same
 * entry. Everything else about the value is unchanged:
 *
 * **`localStorage`, not the settings store**, following the precedent the
 * session panel's width and the file tree's width already set: the settings
 * store is for preferences a user sets BY NAME in the Settings overlay, and an
 * arrangement you reach by dragging until it looks right is not one of those.
 * It is raw layout state, and raw layout state has been going here.
 *
 * **Keyed on the HOST ALIAS and the folder, never on the connection id.** A
 * connection id is an opaque handle minted per connect, so a key built from it
 * would be a fresh key on every launch and the order would never survive a
 * restart — and even within one window a re-dial mints a new id, which would
 * orphan the arrangement. The route's `:name` is the `~/.ssh/config` alias,
 * which is exactly as stable as the folder path beside it; the workspace's own
 * memory map and its persisted copy key on the same alias for the same reason.
 * Same reasoning as the port panel's preference keys, which key on the alias
 * too.
 *
 * ## Why the disk is read on every read, and the reactive edge is a tick
 *
 * A cache in front of the store — the obvious shape for a module like this —
 * would make the map, not the disk, the answer to every read, and then a
 * second copy of the ranking exists that can go stale against its store. The
 * reads are cheap (one `getItem` of a short JSON array, once per row per
 * render), the writes are rare (a drag), and one source of truth is worth
 * more than the caching: this module's own tests seed the disk the way a
 * previous window would have left it, and a value cache answers those seeds
 * with whatever it happened to hold — stale by construction. So the disk is
 * read fresh every time, and what the reactive map carries is only a TICK per
 * key: reading a key tracks it, writing one bumps it, and that is the whole
 * relay a drag needs to re-render the panel's rows and the workspace's bar.
 */
import { reactive } from 'vue';

/**
 * One write-tick per storage key this window has touched. Deliberately NOT a
 * cache of rankings — see the section above; the values here are never read
 * as data, only tracked (a read of an absent key tracks it too, so the first
 * write to a folder the panel is already drawing still lands).
 */
const ticks = reactive(new Map<string, number>());

export function tabOrderStorageKey(hostAlias: string, folderKey: string): string {
  return `ps.tabOrder.${hostAlias}.${folderKey}`;
}

/**
 * The stored ranking for one folder, or `[]` when the user has arranged
 * nothing. Empty is a real and common answer, not a missing one: it means
 * "use the derived order", which is what `applyTabOrder` does with it.
 *
 * Disk entries are validated rather than trusted — this is user-writable JSON,
 * and a non-array (or an array of objects) must not reach `applyTabOrder` and
 * rank tabs by whatever `Map` made of it.
 */
export function tabOrderFor(hostAlias: string, folderKey: string): string[] {
  ticks.get(tabOrderStorageKey(hostAlias, folderKey));
  return readStored(tabOrderStorageKey(hostAlias, folderKey));
}

function readStored(key: string): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

/**
 * Store [next] as the ranking for one folder — to `localStorage`, for the
 * next window and for every read this one still makes, then through the tick,
 * which re-renders the readers.
 *
 * An empty order is REMOVED from the disk rather than stored as `[]`. "The
 * user has arranged nothing" and "there is no entry" are the same state, and
 * keeping one spelling of it means a workspace whose tabs were all closed does
 * not leave a key behind forever. A failed write (quota, a locked profile)
 * still bumps the tick: the readers re-read, get the disk's unchanged answer,
 * and the UI snaps back — losing a tab arrangement on restart must not mean
 * showing one that was not kept.
 */
export function writeTabOrderFor(hostAlias: string, folderKey: string, next: string[]): void {
  const key = tabOrderStorageKey(hostAlias, folderKey);
  if (typeof localStorage !== 'undefined') {
    try {
      if (next.length === 0) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // Quota, or a locked profile. Losing a tab arrangement on restart beats
      // throwing out of a drop handler.
    }
  }
  ticks.set(key, (ticks.get(key) ?? 0) + 1);
}
