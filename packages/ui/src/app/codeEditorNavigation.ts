/**
 * Cursor-location history for the code editor — VS Code's "Go Back" and
 * "Go Forward", as a CodeMirror extension.
 *
 * The gesture is the one every IDE trains into the hand: jump somewhere (a
 * click across the file, a page move, Ctrl+Home), read it, then Alt+Left to
 * stand where you were before the jump, Alt+Right to undo the undo. The
 * chords live in the shortcut registry (`files.editorBack` /
 * `files.editorForward`) and are handled by FilesView, which owns the pane's
 * keyboard; this module only maintains the memory and exposes the two steps.
 *
 * ---------------------------------------------------------------------------
 * WHAT BECOMES A LOCATION, AND WHAT DOES NOT
 * ---------------------------------------------------------------------------
 * The whole feature is the rule that decides it, because a history that
 * records every keystroke is noise and a history that records nothing is
 * dead. The rule reads the transaction CodeMirror already attached to every
 * selection change instead of trying to catch DOM events:
 *
 *   - A POINTER gesture records. A click is a decision about where to look,
 *     and the location being left behind is worth a slot. Only the click's
 *     own collapse does: the transactions in the middle of a drag-selection
 *     (anchor pinned, head sweeping) are the drag's wake, not destinations,
 *     and recording each would fill the stack with the path of one gesture.
 *   - A KEYBOARD move records only when ONE transaction crosses more than
 *     {@link JUMP_LINES} lines. Arrows arrive one line (or one character) per
 *     transaction, so even a held key never records — a thousand small moves
 *     are drifting, not travelling. PageUp/PageDown, Ctrl+Home/End and a
 *     shift-select across a page arrive as a single long transaction and do
 *     record, which is exactly the set VS Code records.
 *   - TYPING never records. Edits are not navigation; what they DO is move
 *     the remembered locations with the text, so a spot noted before an
 *     insertion still means the same line and column after it (each stored
 *     position is mapped through every transaction's changes, kept to the
 *     left of text inserted at its exact offset).
 *   - COLLAPSING a selection onto one of its own ends never records. The
 *     Left/Right reflex after drag-selecting a word is returning, not
 *     travelling, and the selection can be long enough that the collapse
 *     would otherwise look like a long jump.
 *
 * A new recording clears the forward stack (VS Code's behaviour: a new
 * destination invalidates the "un-back" path), but drift does not — arrowing
 * one line after going back does not cost the forward route. Each stack is
 * capped at {@link MAX_HISTORY} entries, oldest discarded.
 *
 * The history is per open buffer. CodeEditor dispatches
 * {@link clearNavHistory} when a different document wholesale-replaces the
 * buffer, because a position in yesterday's document is not a position in
 * this one — the editor is one instance reused across files, and stale
 * offsets would silently re-aim it.
 */

import {
  Annotation,
  EditorSelection,
  StateEffect,
  StateField,
  type ChangeDesc,
  type Extension,
  type Transaction,
} from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/** How many locations the walk may hold, per direction. */
const MAX_HISTORY = 100;

/**
 * The keyboard jump threshold, in lines crossed by a single transaction.
 * Three and not one: Shift+Down held for a few steps is drift, while even a
 * short page on a laptop screen crosses far more than three.
 */
const JUMP_LINES = 3;

/** One remembered location: both ends of the selection that sat there. */
interface NavLocation {
  anchor: number;
  head: number;
}

interface NavStacks {
  /** Locations to land on, most recent last. */
  back: readonly NavLocation[];
  /** Locations unwound by going back, most recent last. */
  forward: readonly NavLocation[];
}

/**
 * Marks a transaction as this extension's own back/forward step, so the field
 * moves a location BETWEEN stacks instead of recording the move as a new
 * location. Without it, Alt+Left would be recorded as just another jump and
 * the walk would never leave the first two spots.
 */
const NavMove = Annotation.define<'back' | 'forward'>();

/**
 * Wipes the history. Dispatched when the buffer is wholesale-replaced by a
 * different document (see CodeEditor's external-value watch).
 */
export const clearNavHistory = StateEffect.define<null>();

const EMPTY_STACKS: NavStacks = { back: [], forward: [] };

function locationOf(selection: EditorSelection): NavLocation {
  const main = selection.main;
  return { anchor: main.anchor, head: main.head };
}

/**
 * Move a remembered location with the text. `assoc: -1` keeps the location
 * with the text BEFORE it: text typed exactly at a remembered offset should
 * not pull the spot to its end.
 */
function mapLocation(location: NavLocation, changes: ChangeDesc): NavLocation {
  return { anchor: changes.mapPos(location.anchor, -1), head: changes.mapPos(location.head, -1) };
}

/**
 * Does this selection change cross to a location worth remembering? The rule
 * is the module's whole point — see the header — and every branch here is one
 * of its clauses, in the order they are meant to be read: no-ops first, then
 * the deliberate-gesture cases.
 */
function recordsJump(tr: Transaction): boolean {
  const previous = tr.startState.selection.main;
  const current = tr.state.selection.main;
  if (previous.anchor === current.anchor && previous.head === current.head) return false;
  // Collapsing onto an end of the very selection being collapsed — the
  // arrow-key reflex after a drag-select — is returning, not travelling.
  if (
    current.anchor === current.head &&
    previous.anchor !== previous.head &&
    (current.head === previous.anchor || current.head === previous.head)
  ) {
    return false;
  }
  const userEvent = tr.isUserEvent('select.pointer');
  if (userEvent) {
    // The collapse of a click, or the first transaction of a drag (the one
    // that stretched a collapsed cursor into the drag's anchor+head) records.
    // The middle of a drag — old selection already stretched, head still
    // sweeping — is the path of one gesture and records nothing.
    return current.anchor === current.head || previous.anchor === previous.head;
  }
  // Every other gesture is keyboard. Arrows and word-moves arrive one small
  // transaction at a time and never cross the threshold; the page-shaped
  // moves arrive as one long transaction and do.
  const from = tr.state.doc.lineAt(previous.head).number;
  const to = tr.state.doc.lineAt(current.head).number;
  return Math.abs(to - from) > JUMP_LINES;
}

const navField = StateField.define<NavStacks>({
  create: () => ({ back: [], forward: [] }),
  update(value, tr) {
    if (tr.effects.some((effect) => effect.is(clearNavHistory))) return EMPTY_STACKS;
    // Edits move the remembered locations with the text; navigation
    // transactions change no text, so the mapping is identity for them.
    if (tr.docChanged) {
      value = {
        back: value.back.map((location) => mapLocation(location, tr.changes)),
        forward: value.forward.map((location) => mapLocation(location, tr.changes)),
      };
    }
    const move = tr.annotation(NavMove);
    if (move) {
      // The location being left behind is where the transaction STARTED —
      // the selection the user is stepping away from, whatever it was.
      const displaced = locationOf(tr.startState.selection);
      return move === 'back'
        ? { back: value.back.slice(0, -1), forward: [...value.forward, displaced] }
        : { back: [...value.back, displaced], forward: value.forward.slice(0, -1) };
    }
    if (!tr.selection || tr.docChanged || !recordsJump(tr)) return value;
    const displaced = locationOf(tr.startState.selection);
    const back = [...value.back, displaced];
    return {
      back: back.length > MAX_HISTORY ? back.slice(back.length - MAX_HISTORY) : back,
      // A new destination invalidates the path forward.
      forward: EMPTY_STACKS.forward,
    };
  },
});

/**
 * The extension itself: a StateField, one per editor instance, carrying the
 * two stacks. State fields are definitions, safe to share in the extension
 * array across EditorState instances — each state keeps its own value.
 */
export const cursorNavHistory: Extension = navField;

/**
 * Step back to the most recent remembered location — VS Code's Go Back. The
 * cursor (and the scroll, which follows the selection) moves there; the spot
 * being left moves onto the forward stack. False when there is nowhere to go,
 * which the chord treats as "not mine": with an empty history Alt+Left stays
 * as inert as it was before this feature.
 */
export function navGoBack(view: EditorView): boolean {
  return navStep(view, 'back');
}

/** The inverse of {@link navGoBack} — redo a back-step. */
export function navGoForward(view: EditorView): boolean {
  return navStep(view, 'forward');
}

function navStep(view: EditorView, direction: 'back' | 'forward'): boolean {
  const stacks = view.state.field(navField, false);
  const stack = direction === 'back' ? stacks?.back : stacks?.forward;
  if (!stack || stack.length === 0) return false;
  const target = stack[stack.length - 1];
  view.dispatch({
    selection: EditorSelection.single(target.anchor, target.head),
    effects: EditorView.scrollIntoView(target.head),
    annotations: NavMove.of(direction),
    // CodeMirror's own userEvent vocabulary has no name for this; the
    // `select.` prefix says "a selection change a user gesture caused".
    userEvent: 'select.nav',
  });
  return true;
}
