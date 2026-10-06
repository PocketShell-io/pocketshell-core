// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { clearNavHistory, cursorNavHistory, navGoBack, navGoForward } from '@ui/app/codeEditorNavigation';

/**
 * The recording rule, exercised the way the editor actually produces
 * transactions: through dispatches carrying CodeMirror's own `userEvent` tags
 * (`select.pointer` for a mouse gesture, `move` for cursor keys, `input.type`
 * for typing). That is the same data the rule reads in the wild, so a dispatch
 * is not a weaker stand-in for a real event — it is the same shape.
 *
 * The buffer is 40 lines of ~21 columns, so "a few lines down" and "ten lines
 * down" are plain offsets and the jump threshold (> 3 lines) has room on both
 * sides of itself.
 */

const LINES = Array.from({ length: 40 }, (_, i) => `line ${i} of the buffer, padded`);
/** Offset of the start of line `n` — prefix sums, since the lines differ in length. */
const LINE_STARTS = LINES.map((_, i) => LINES.slice(0, i).reduce((sum, line) => sum + line.length + 1, 0));
function lineStart(n: number): number {
  return LINE_STARTS[n];
}

function makeView(): EditorView {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc: LINES.join('\n'), extensions: [cursorNavHistory] }),
  });
  return view;
}

/** A selection change with the userEvent a gesture of that kind would carry. */
function gesture(view: EditorView, selection: EditorSelection | { anchor: number }, userEvent?: string): void {
  view.dispatch({ selection, ...(userEvent ? { userEvent } : {}) });
}

function cursor(view: EditorView): number {
  return view.state.selection.main.head;
}

describe('cursor navigation history', () => {
  it('records nothing until a jump happens — typing and drifting are not locations', () => {
    const view = makeView();
    // Typing moves both the text and the cursor; the transaction changes the
    // document, and edits are not navigation.
    view.dispatch({ changes: { from: 5, insert: 'x' }, selection: { anchor: 6 }, userEvent: 'input.type' });
    gesture(view, { anchor: 7 }, 'move');
    gesture(view, { anchor: 8 }, 'move');
    gesture(view, { anchor: lineStart(2) }, 'move'); // two lines down, still drift
    expect(navGoBack(view)).toBe(false);
    expect(navGoForward(view)).toBe(false);
    view.destroy();
  });

  it('a click records where the cursor was, back lands there, forward undoes it', () => {
    const view = makeView();
    gesture(view, { anchor: 7 });
    gesture(view, { anchor: lineStart(20) }, 'select.pointer'); // a click 20 lines down
    expect(navGoBack(view)).toBe(true);
    expect(cursor(view)).toBe(7);
    expect(navGoForward(view)).toBe(true);
    expect(cursor(view)).toBe(lineStart(20));
    // The walk is a cycle, not a queue: both stacks are spent now.
    expect(navGoBack(view)).toBe(true);
    expect(cursor(view)).toBe(7);
    expect(navGoForward(view)).toBe(true);
    view.destroy();
  });

  it('a page-length keyboard move records; every arrow step along the way does not', () => {
    const view = makeView();
    gesture(view, { anchor: 7 });
    gesture(view, { anchor: lineStart(2) }, 'move');
    gesture(view, { anchor: lineStart(3) }, 'move');
    gesture(view, { anchor: lineStart(20) }, 'move'); // Ctrl+Home- or PageDown-shaped
    expect(navGoBack(view)).toBe(true);
    // "Back" lands on the last drifted-through spot, not the first.
    expect(cursor(view)).toBe(lineStart(3));
    view.destroy();
  });

  it('a drag records the click that started it, not the path it swept', () => {
    const view = makeView();
    gesture(view, { anchor: 7 });
    gesture(view, EditorSelection.single(50, 90), 'select.pointer'); // mousedown starts a drag
    gesture(view, EditorSelection.single(50, 130), 'select.pointer'); // still sweeping
    gesture(view, EditorSelection.single(50, 200), 'select.pointer'); // mouseup here
    expect(navGoBack(view)).toBe(true);
    expect(cursor(view)).toBe(7);
    expect(navGoBack(view)).toBe(false); // one location, not three
    view.destroy();
  });

  it('collapsing a selection onto its own end is returning, not travelling', () => {
    const view = makeView();
    gesture(view, { anchor: 7 });
    gesture(view, EditorSelection.single(50, 200), 'select.pointer'); // a drag-select
    gesture(view, { anchor: 50 }, 'move'); // the Left reflex: collapse to the anchor
    expect(navGoBack(view)).toBe(true);
    expect(cursor(view)).toBe(7); // the pre-drag spot, not the selection's far end
    view.destroy();
  });

  it('remembered locations move with the text', () => {
    const view = makeView();
    gesture(view, { anchor: 7 });
    gesture(view, { anchor: lineStart(20) }, 'select.pointer'); // records offset 7
    view.dispatch({
      changes: { from: 0, insert: 'typed!' },
      selection: { anchor: 6 },
      userEvent: 'input.type',
    });
    expect(navGoBack(view)).toBe(true);
    expect(cursor(view)).toBe(13); // 7, pushed along by the six inserted characters
    view.destroy();
  });

  it('a new jump forgets the forward path; drifting after going back does not', () => {
    const view = makeView();
    gesture(view, { anchor: 7 });
    gesture(view, { anchor: lineStart(20) }, 'select.pointer');
    expect(navGoBack(view)).toBe(true);
    gesture(view, { anchor: lineStart(1) }, 'move'); // one line of drift
    expect(navGoForward(view)).toBe(true); // the drift did not cost the way forward
    expect(cursor(view)).toBe(lineStart(20));
    gesture(view, { anchor: lineStart(30) }, 'select.pointer'); // a new destination
    expect(navGoForward(view)).toBe(false); // ...and it forgot the forward path
    view.destroy();
  });

  it('clearNavHistory empties the walk', () => {
    const view = makeView();
    gesture(view, { anchor: 7 });
    gesture(view, { anchor: lineStart(20) }, 'select.pointer');
    view.dispatch({ effects: clearNavHistory.of(null) });
    expect(navGoBack(view)).toBe(false);
    expect(navGoForward(view)).toBe(false);
    view.destroy();
  });

  it('the walk is bounded, oldest locations discarded first', () => {
    const view = makeView();
    gesture(view, { anchor: 0 });
    // 105 clicks, each to a distinct spot within the buffer (max 1155 < the
    // doc's ~1189 characters); every one collapses a collapsed cursor, so
    // every one records.
    for (let i = 1; i <= 105; i += 1) gesture(view, { anchor: i * 11 }, 'select.pointer');
    let steps = 0;
    while (navGoBack(view)) steps += 1;
    expect(steps).toBe(100);
    // The oldest 5 are gone: the earliest reachable spot is click #6's origin.
    expect(cursor(view)).toBe(5 * 11);
    view.destroy();
  });

  it('an empty history claims nothing', () => {
    const view = makeView();
    const before = view.state.selection.main.head;
    expect(navGoBack(view)).toBe(false);
    expect(navGoForward(view)).toBe(false);
    expect(view.state.selection.main.head).toBe(before);
    view.destroy();
  });
});
