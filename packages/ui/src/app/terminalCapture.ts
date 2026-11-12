/**
 * The pane's on-screen text as TEXT — what a screenshot loses.
 *
 * Why this exists: the pane's URL repair (terminalLinks.ts) is developed
 * against reports, and the reports arrived as PICTURES of a multi-line URL.
 * A picture carries neither the exact characters (a wrapped slug is
 * unreadable at screenshot resolution) nor the row boundaries (which the
 * join rules are arithmetic ABOUT), so every report cost a round of
 * guessing. This module is the other half of that conversation: one chord,
 * and the clipboard holds the pane exactly as the grid holds it — paste it
 * into a bug report and the reader gets the characters, the rows and the
 * blanks, not an impression of them. It also serves the plainer want it
 * shares with every terminal: taking a chunk of screen that outlives the
 * selection, without dragging a mouse across it.
 *
 * FAITHFUL, not repaired. The link provider reconstructs logical lines the
 * remotes in this pane never flagged as wrapped (terminalLinks.ts explains
 * why `isWrapped` alone is too weak for links), but that machinery is tuned
 * to make a URL clickable, and its joins are INFERENCES — gluing rows it
 * believes were one line, dropping gutters it believes are decoration. A
 * capture that applied them would hand the reader the detector's opinion
 * instead of the evidence the detector is being debugged against. So the
 * only join here is xterm's own: a row flagged `isWrapped` — the terminal
 * itself recorded that it is the continuation of the row above — is glued
 * back onto it, and everything else stays the separate row it visibly is.
 * The reader of a capture sees the row breaks, and can reason about them;
 * that is the entire point.
 *
 * Rows are walked cell by cell rather than read with
 * `translateToString(true)` for the same two reasons the link flattening
 * does: a width-0 cell (the right half of a double-width character) holds
 * no character of its own and must not become one, and an untouched cell
 * reads as the space it renders as. Trailing blanks go — per row (the
 * padding to the pane's edge is layout, not content) and off the end of
 * the capture (the rows below the prompt are the pane's emptiness, not
 * something to paste).
 */
import type { IBufferLine, Terminal } from '@xterm/xterm';
import { isShortcut, type Chord } from '@pocketshell/core/shared/shortcuts';

/** How much of the buffer a capture takes. */
export type CaptureScope =
  /** What is on screen right now — the viewport, wherever it is scrolled to. */
  | 'screen'
  /** The viewport plus all the scrollback behind it. */
  | 'buffer';

/**
 * The pane's text over [scope], logical lines joined with `\n`.
 *
 * Empty for a pane with no rows — a capture of nothing must not blank the
 * clipboard, which is the caller's guard and the reason this returns a
 * string rather than writing anything itself.
 */
export function captureTerminalText(term: Terminal, scope: CaptureScope): string {
  const buf = term.buffer.active;
  // The viewport may sit anywhere in the scrollback (`viewportY` is its top
  // row), so "the screen" is wherever the user is looking, not the buffer's
  // tail. `term.rows` is the viewport's height in rows.
  const first = scope === 'buffer' ? 0 : buf.viewportY;
  const last = Math.min(
    scope === 'buffer' ? buf.length - 1 : buf.viewportY + term.rows - 1,
    buf.length - 1,
  );

  const lines: string[] = [];
  for (let y = first; y <= last; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const text = rowText(line);
    // xterm's own record that this row is the overflow of the one above it:
    // one logical line, so no newline goes between them. At the FIRST row of
    // the range there is nothing to join onto — a viewport scrolled into the
    // middle of a wrapped line shows its remainder, and that is what the
    // capture shows too.
    if (line.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += text;
    } else {
      lines.push(text);
    }
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/**
 * One row, trailing padding trimmed. A row is as wide as the pane whether or
 * not anything was written to it; only the cells up to the last non-space
 * are content.
 */
function rowText(line: IBufferLine): string {
  let out = '';
  let lastNonSpace = -1;
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    const ch = cell.getChars() || ' ';
    out += ch;
    if (ch !== ' ') lastNonSpace = out.length - 1;
  }
  return lastNonSpace >= 0 ? out.slice(0, lastNonSpace + 1) : '';
}

/**
 * Answer a capture CHORD against [bindings]: when [e] is one —
 * `terminal.copyScreen` or `terminal.copyBuffer` (src/shared/shortcutTable.ts)
 * — cancel the keystroke, copy the pane over that chord's scope through
 * [copy], and answer true, the shape xterm's custom-key handler reads as
 * "the key is ours". Living here rather than beside the other clipboard
 * branches in TerminalView is a design-gate payment: the view sits under the
 * 1000-line cap, and this is the second module a feature moved out of it
 * wholesale (useQuickActions was the first). [copy] is injected so the pane's
 * one clipboard path — its empty-capture guard, its silent failure — stays
 * exactly as it is.
 */
export function captureChord(
  bindings: ReadonlyMap<string, readonly Chord[]>,
  e: KeyboardEvent,
  term: Terminal,
  copy: (text: string) => Promise<void>,
): boolean {
  const scope = isShortcut(bindings, 'terminal.copyScreen', e)
    ? 'screen'
    : isShortcut(bindings, 'terminal.copyBuffer', e)
      ? 'buffer'
      : null;
  if (scope === null) return false;
  e.preventDefault();
  void copy(captureTerminalText(term, scope));
  return true;
}
