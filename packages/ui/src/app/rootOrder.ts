/**
 * The session panel's MANUAL ROOT order — the headers (`~/git`, `~/tmp`) the
 * folder rows group under, one level up from `folderOrder.ts`'s folder rows.
 *
 * `folderOrder.ts` is explicit that the ROOTS themselves are never reordered
 * there: a root is a real directory on the host, a folder row sits under it
 * because its working directory is genuinely inside it, and a row dragged
 * under another header would contradict its own tooltip. That argument is
 * about a FOLDER ROW's honesty, and it does not reach the headers themselves:
 * `~/git` before `~/tmp` is the registered order (or the order the sessions
 * happened to appear in, on a host with nothing registered), which is a fact
 * about registration and listing, not about the filesystem. Dragging `~/tmp`
 * above `~/git` relabels no directory — it is exactly the tab bar's group
 * rule, "cheap to relax" for a presentational grouping, relaxed one level up
 * for the reason the tab bar gave.
 *
 * ## This is `folderOrder.ts`'s design, one level up
 *
 * The stored value, the pipeline stage, the drag's refusal rule and the shape
 * of what a drop writes are that module's, and the arguments are cited rather
 * than restated. Read them there first; only the two places this level
 * genuinely differs are written out in full:
 *
 *   - **the bucket is pinned, not placed.** `groupSessionsIntoRoots` pins
 *     `other` last — it is a bucket, not a place, and letting it float would
 *     put the least-organised rows where the eye lands first. A ranking could
 *     silently move it, so `applyRootOrder` re-pins it AFTER the sort, and
 *     `canDropRootAt` refuses the one gap that would rank a root below it.
 *   - **a sort cannot veto these ranks.** `applyFolderSort` re-orders the rows
 *     WITHIN each root and never touches the root sequence, so unlike the
 *     folder drag — which must switch the panel back to `host` before writing
 *     ranks, because a kept sort would veto them row by row — a root drag
 *     composes with any sort and writes nothing but the ranking.
 *
 * The sort setting keeps its hands off here too: `setSessionTreeSort` clears
 * the folder arrangement (the veto above) and deliberately leaves this one.
 */
import type { SessionRootFolder } from './sessionTree';

/**
 * One host's root arrangement: the root keys the user has placed, best first.
 *
 * The keys are `SessionRootFolder.key`s — home-relative root paths (`~/git`)
 * or the `other` sentinel. The home-relative spelling is what makes them
 * survivable across restarts, the same reason folder keys carry it. The blob
 * shape and its failure modes are `FolderOrder`'s exactly, so the settings
 * store parses this with the same normaliser it parses that one.
 */
export type RootOrder = Record<string, string[]>;

/**
 * Re-order the panel's root sections by a stored manual [order], keeping the
 * grouped order for anything the user has not placed.
 *
 * The three awkward cases need no handling at all, for `applyFolderOrder`'s
 * reasons: a NEW root (just registered, or just appeared because a session
 * landed in it) has no rank and sorts after every ranked one; a REMOVED root
 * leaves no hole, because nothing is positioned by index; an UNKNOWN key is
 * inert. The sort is STABLE, so unranked roots keep their grouped order
 * relative to each other — registered order, or first appearance.
 *
 * `other` is pinned last AFTER the ranking sort, whatever it ranked: the pin
 * is the grouping's declared output (`groupSessionsIntoRoots`), and a stored
 * rank must not be able to float the bucket above a real root.
 *
 * A NEW array is returned and the input is not mutated, because the input is a
 * Vue computed's value — the same write-during-a-read argument
 * `applyFolderOrder` makes. The root objects themselves are shared, not
 * cloned: nothing at this level changes a root's insides.
 */
export function applyRootOrder(
  roots: readonly SessionRootFolder[],
  order: readonly string[],
): SessionRootFolder[] {
  if (order.length === 0) return [...roots];
  const rank = new Map(order.map((key, i) => [key, i]));
  const byRank = (a: SessionRootFolder, b: SessionRootFolder): number =>
    (rank.get(a.key) ?? Number.POSITIVE_INFINITY) - (rank.get(b.key) ?? Number.POSITIVE_INFINITY);
  const sorted = [...roots].sort(byRank);
  return [...sorted.filter((root) => !root.other), ...sorted.filter((root) => root.other)];
}

/**
 * May the root [fromKey] be dropped at gap [toIndex] of the panel's roots?
 *
 * Exists so the panel can say NO while the drag is still in the air — no
 * indicator, no `preventDefault`, no-drop cursor — rather than accepting the
 * drop and snapping the header back (`canDropFolderAt`'s argument, unchanged).
 *
 * [toIndex] is a GAP index in `0..roots.length`: `0` is "above the first
 * header", `roots.length` is "below the last".
 *
 * Three refusals:
 *
 *   - [fromKey] names no root the panel is drawing — a stale drag, a
 *     hand-crafted event;
 *   - the dragged root IS the `other` bucket: it is pinned last, so there is
 *     no gap that means anything for it (the header also refuses to START the
 *     drag; this is the same rule stated where the drop reads it);
 *   - the gap lies below a pinned-last `other`. Ranking a root after the
 *     bucket is a placement `applyRootOrder` would silently undo, and an
 *     accepted drop that snaps back reads as a bug — the refusal has to be
 *     visible while the drag is still in the air.
 */
export function canDropRootAt(
  roots: readonly SessionRootFolder[],
  fromKey: string,
  toIndex: number,
): boolean {
  const from = roots.findIndex((root) => root.key === fromKey);
  if (from < 0) return false;
  if (roots[from]!.other) return false;
  if (toIndex < 0 || toIndex > roots.length) return false;
  if (toIndex === roots.length && roots[roots.length - 1]?.other) return false;
  return true;
}

/**
 * Move [fromKey] to gap [toIndex] among the panel's roots, and return the
 * WHOLE PANEL's root keys in the new draw order — or null when the move is
 * refused or is a no-op.
 *
 * The whole panel and not the one moved root is `reorderFolders`' argument,
 * unchanged: a total ranking is what makes `applyRootOrder`'s "unranked sorts
 * last" mean "roots I have never touched keep their grouped order", and
 * emitting the list in DRAW ORDER means one write needs no merge with
 * whatever was stored before.
 *
 * A key that is not on screen right now is dropped, for `reorderFolders`'s
 * reason too: an unranked root sorts after the ranked ones at its grouped
 * position among the other unranked, which is where a root absent since the
 * last arrangement belongs anyway.
 *
 * The index is clamped, not rejected (`reorderFolders`' reason: the
 * interaction is "put this as far up as it goes", and refusing an overshoot
 * would make the ends reachable only by pixel-accurate drops). Returning null
 * for a no-op is what lets the caller skip persisting a drag that ended where
 * it started.
 */
export function reorderRoots(
  roots: readonly SessionRootFolder[],
  fromKey: string,
  toIndex: number,
): string[] | null {
  const from = roots.findIndex((root) => root.key === fromKey);
  if (from < 0) return null;

  // A gap index becomes an array index: removing the row first shifts every
  // gap after it down by one.
  const gap = Math.max(0, Math.min(roots.length, toIndex));
  const to = gap > from ? gap - 1 : gap;
  if (to === from) return null;

  const arranged = [...roots];
  const moving = arranged.splice(from, 1)[0];
  if (moving === undefined) return null;
  arranged.splice(to, 0, moving);

  return arranged.map((root) => root.key);
}
