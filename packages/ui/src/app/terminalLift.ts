import type { LayoutClass } from './layoutClass';

/**
 * How far to lift the terminal VIEW above the open composer card (#3128).
 *
 * Phone only (D44): on a compact layout the card covers the bottom of the
 * terminal, where the cursor and an agent's prompt are, so the view is moved
 * up by the overlap with a transform. The pane keeps its size: the remote
 * terminal is never resized and nothing redraws. Medium and expanded layouts
 * keep the floating card over an unmoved terminal (0).
 */
export function terminalLiftPx(input: {
  layout: LayoutClass;
  sessionTab: boolean;
  /** The open card's top edge in viewport px; null while the composer is closed. */
  cardTop: number | null;
  /** The terminal pane's own (unlifted) bottom edge in viewport px. */
  paneBottom: number | null;
}): number {
  if (input.layout !== 'compact' || !input.sessionTab || input.cardTop === null || input.paneBottom === null) return 0;
  return Math.max(0, Math.round(input.paneBottom - input.cardTop));
}
