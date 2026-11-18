import type { LayoutClass } from './layoutClass';

/** Room left under the cursor row above the card, so its descenders are not clipped. */
export const TERMINAL_LIFT_GAP_PX = 4;

/**
 * How far to lift the terminal VIEW above the open composer card (#3128).
 *
 * Phone only (D44): on a compact layout the card covers the bottom of the
 * terminal. The view is moved up with a transform - the pane keeps its size,
 * so the remote terminal is never resized and nothing redraws - but only as
 * far as the CURSOR ROW needs: the line being typed into (and the lines above
 * it) end directly above the card. A cursor already above the card means no
 * lift at all; a cursor that is not in view (scrolled back) lifts by the card's
 * whole cover so the live bottom stays reachable. Never more than the cover.
 * Medium and expanded layouts keep the floating card over an unmoved terminal.
 */
export function terminalLiftPx(input: {
  layout: LayoutClass;
  sessionTab: boolean;
  /** The open card's top edge in viewport px; null while the composer is closed. */
  cardTop: number | null;
  /** The terminal pane's own (unlifted) bottom edge in viewport px. */
  paneBottom: number | null;
  /** The cursor row's bottom as if unlifted, in viewport px; null when not in view or unknown. */
  cursorBottom?: number | null;
}): number {
  if (input.layout !== 'compact' || !input.sessionTab || input.cardTop === null || input.paneBottom === null) return 0;
  const cover = Math.max(0, input.paneBottom - input.cardTop);
  const cursor = input.cursorBottom ?? null;
  const need = cursor === null ? cover : Math.max(0, cursor + TERMINAL_LIFT_GAP_PX - input.cardTop);
  return Math.round(Math.min(cover, need));
}
