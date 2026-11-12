import { ref, type ComputedRef, type Ref } from 'vue';
import { canDropFolderAt, reorderFolders } from './folderOrder';
import { canDropRootAt, reorderRoots } from './rootOrder';
import type { SessionDirectory, SessionRootFolder } from './sessionTree';
import type { useSettingsStore } from './stores/settings';
import { useStripDrag } from './useStripDrag';

export interface FolderDragDeps {
  /** The roots as the panel is drawing them right now — the drop reads this. */
  roots: ComputedRef<SessionRootFolder[]>;
  /** The host alias the manual arrangement is stored under. */
  host: ComputedRef<string>;
  settings: ReturnType<typeof useSettingsStore>;
}

/**
 * Dragging a folder row of the session panel up and down to reorder it — and,
 * the same gesture one level up, dragging a root header to reorder the roots
 * the folders group under. Extracted from SessionTree.vue with its reasoning;
 * the rows component binds the handlers, this owns the state and the commit.
 */
export function useFolderDrag(deps: FolderDragDeps): {
  dragging: Ref<string | null>;
  dropTarget: Ref<{ root: string; gap: number } | null>;
  rootDragging: Ref<string | null>;
  rootDropTarget: Ref<number | null>;
  onRowDragStart: (dir: SessionDirectory, e: DragEvent) => void;
  onRowDragOver: (root: SessionRootFolder, index: number, e: DragEvent) => void;
  onRowDrop: () => void;
  onRootDragStart: (root: SessionRootFolder, e: DragEvent) => void;
  onRootDragOver: (index: number, e: DragEvent) => void;
  onRootDrop: () => void;
  onRowDragEnd: () => void;
} {
  /* ── Dragging a folder row up and down ───────────
   * > "but I can also pull them up and down to rearraange"
   *
   * The same native HTML5 drag the workspace's tab bar uses, turned ninety
   * degrees. It is deliberately the same family and not a
   * pointer-events implementation of its own: the two are one gesture in the
   * user's hands — drag a thing along the strip it lives in — and a panel that
   * felt different from the tab bar would be a second thing to learn for nothing.
   *
   * All three of the rules the tab drag obeys carry over unchanged:
   *
   *   - **the drag does not fight the click.** A row is a `<button>` that
   *     navigates, and native DnD suppresses the `click` that would otherwise
   *     follow a drag — which is exactly what the tab bar already relies on for
   *     its own `<button class="tab" draggable>`. So dragging a row does not open
   *     its workspace, and nothing here has to guess at a threshold or swallow a
   *     click after the fact. The row's other behaviours are untouched for the
   *     same reason: the context menu is a right-button gesture and a drag is a
   *     left-button one, and `draggable` changes nothing about the keyboard, so
   *     Enter/Space still activate the row and `Ctrl+↑`/`Ctrl+↓` still walk it.
   *   - **the dragged row fades but stays in place.** Removing it from the flow
   *     would shift every row below it the instant the drag began, moving the
   *     target the user is aiming at at precisely the wrong moment.
   *   - **the landing place is drawn**, as a 2px accent rule in the gap. Without
   *     it a reorder is "let go and find out", and the one rule this drag
   *     enforces — a row cannot leave its root — is invisible unless something
   *     draws it. A refused drop draws nothing, and that absence IS the refusal.
   */
  const FOLDER_DRAG_TYPE = 'application/x-pocketshell-folder';
  const ROOT_DRAG_TYPE = 'application/x-pocketshell-root';

  // The drag MECHANICS (payload, midpoint rule, drop-target marking) live in
  // useStripDrag, the tab bar's composable; the folder list keeps its own
  // indicator shape — root plus gap, because the panel renders one indicator per
  // root — and its own policy in the handlers below.
  const { dragging, startDrag, gapFor, markDroppable, endDrag } = useStripDrag({
    dragType: FOLDER_DRAG_TYPE,
    axis: 'y',
  });
  /** The folder key being dragged, and the gap the drop indicator is sitting in. */
  const dropTarget = ref<{ root: string; gap: number } | null>(null);

  /**
   * The root headers run their own strip beside the folders', in the same
   * family for the reason the folder drag is in the tab bar's. The two carry
   * DIFFERENT payload types on purpose: a type nothing else claims is what
   * keeps a folder drag from lighting up a header on the way past, and a root
   * drag from lighting up the rows — each strip's `dragging` is null while the
   * other is in flight, so the crossed `dragover` handlers refuse before the
   * policy is even asked.
   */
  const rootStrip = useStripDrag({ dragType: ROOT_DRAG_TYPE, axis: 'y' });
  /** The root key being dragged, and the gap index the indicator sits in. */
  const rootDropTarget = ref<number | null>(null);

  function onRowDragStart(dir: SessionDirectory, e: DragEvent): void {
    startDrag(dir.key, e);
    dropTarget.value = null;
  }

  /**
   * The pointer is over row [index] of [root].
   *
   * `root` is the root the pointer is IN, not the one the drag started in, and
   * that is what refuses a cross-root drag without this handler knowing anything
   * about roots: `canDropFolderAt` asks whether the dragged key is one of THIS
   * root's rows, and a key from `git` is not one of `tmp`'s. A root is a real
   * directory on the host, so a row that moved out of it would be a claim about
   * where the folder lives — see `folderOrder.ts` for the whole argument.
   */
  function onRowDragOver(root: SessionRootFolder, index: number, e: DragEvent): void {
    const from = dragging.value;
    if (from === null) return;
    const gap = gapFor(index, e);
    // REFUSED VISIBLY: no indicator, and no `preventDefault`, so the pointer
    // keeps its `no-drop` cursor. A drop that is accepted and then snaps back
    // reads as a bug; one that never lights up reads as a rule.
    if (!canDropFolderAt(root, from, gap)) {
      dropTarget.value = null;
      return;
    }
    markDroppable(e);
    dropTarget.value = { root: root.key, gap };
  }

  /**
   * Commit the drag.
   *
   * `reorderFolders` is handed `roots.value` — the list as the panel is drawing it
   * THIS instant, poll and all — and returns the whole panel's keys in draw
   * order, which is what gets stored. It returns null for a move that ended where
   * it started, and writing then would persist an arrangement for nothing.
   *
   * Nothing here re-sorts anything. The store holds a ranking, `folderTree.ts`
   * applies it to whatever the next refresh brings, and this handler's only job is
   * to write the ranking down — which is why a drag survives the five-second poll
   * instead of racing it.
   */
  function onRowDrop(): void {
    const from = dragging.value;
    const target = dropTarget.value;
    endDrag();
    dropTarget.value = null;
    if (from === null || target === null) return;
    const next = reorderFolders(deps.roots.value, from, target.gap);
    if (!next) return;
    // A drag IS the manual arrangement speaking, so it switches the panel
    // back under `host` first: with a sort active, a kept sort would veto the
    // freshly written ranks folder by folder — the exact silent-noop that
    // made "I picked Name" read as broken. Sorting and arranging are one
    // mode at a time, and the mode the hands chose wins.
    if (deps.settings.sessionTreeSort !== 'host') deps.settings.setSessionTreeSort('host');
    deps.settings.setFolderOrder(deps.host.value, next);
  }

  function onRowDragEnd(): void {
    endDrag();
    dropTarget.value = null;
    rootStrip.endDrag();
    rootDropTarget.value = null;
  }

  /**
   * The pointer is over the root at [index]'s WHOLE SECTION — header and
   * folder rows alike, because the gesture aims at the group and a thin
   * header row among dozens of rows is a target a hand only hits by accident
   * (ten refused drags to one landing, measured in the wild). The midpoint
   * rule is the strip's, applied to the section's box: top half proposes the
   * boundary above the group, bottom half the one below it.
   *
   * `canDropRootAt` is the policy — a root cannot land after the pinned `other`
   * bucket, and the bucket itself cannot be dragged — and a refusal draws
   * nothing and keeps the no-drop cursor, exactly as the folder drag's does.
   */
  function onRootDragOver(index: number, e: DragEvent): void {
    const from = rootStrip.dragging.value;
    if (from === null) return;
    const gap = rootStrip.gapFor(index, e);
    if (!canDropRootAt(deps.roots.value, from, gap)) {
      rootDropTarget.value = null;
      return;
    }
    rootStrip.markDroppable(e);
    rootDropTarget.value = gap;
  }

  /**
   * Commit the drag: `reorderRoots` is handed the roots as the panel is
   * drawing them THIS instant and returns every root key in draw order, the
   * whole-panel ranking `reorderFolders` writes, and null for a drag that
   * ended where it started.
   *
   * The one deliberate difference from {@link onRowDrop}: the sort setting is
   * left alone. A sort reorders the rows WITHIN each root and never the root
   * sequence (`folderSort.ts`), so there is no kept sort to switch away from —
   * the fresh ranks cannot be vetoed, and picking a sort later does not clear
   * them either (`setSessionTreeSort`).
   */
  function onRootDragStart(root: SessionRootFolder, e: DragEvent): void {
    rootStrip.startDrag(root.key, e);
    rootDropTarget.value = null;
  }

  function onRootDrop(): void {
    const from = rootStrip.dragging.value;
    const target = rootDropTarget.value;
    rootStrip.endDrag();
    rootDropTarget.value = null;
    if (from === null || target === null) return;
    const next = reorderRoots(deps.roots.value, from, target);
    if (!next) return;
    deps.settings.setRootOrder(deps.host.value, next);
  }

  return {
    dragging,
    dropTarget,
    rootDragging: rootStrip.dragging,
    rootDropTarget,
    onRowDragStart,
    onRowDragOver,
    onRowDrop,
    onRootDragStart,
    onRootDragOver,
    onRootDrop,
    onRowDragEnd,
  };
}
