/**
 * How the host workspace lays out its two halves — the session panel and the
 * open folder's pane — for the width it has.
 *
 * Wide: side by side, the panel resizable and collapsible to a rail (`split`).
 * Narrow (a phone): there is no room for both, so exactly one is on screen.
 * With no folder open that is the panel, full width (`panel`); opening a
 * folder swaps to its pane with the rail as the way back (`pane`); the rail's
 * "show panel" brings the panel back over the pane without closing it
 * (`panel` again), so the terminals behind it keep their state.
 */
export type WorkspaceLayout = 'split' | 'panel' | 'pane';

/** At or below this viewport width the workspace shows one half at a time. */
export const NARROW_WORKSPACE_MAX_WIDTH = 640;

export const NARROW_WORKSPACE_QUERY = `(max-width: ${NARROW_WORKSPACE_MAX_WIDTH}px)`;

export function resolveWorkspaceLayout(input: {
  narrow: boolean;
  hasFolder: boolean;
  panelRequested: boolean;
}): WorkspaceLayout {
  if (!input.narrow) return 'split';
  if (!input.hasFolder || input.panelRequested) return 'panel';
  return 'pane';
}
