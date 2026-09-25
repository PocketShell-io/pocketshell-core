/**
 * The quick-actions palette's command shape — the vocabulary `CommandPalette`
 * renders and the one place that names it (the `hostPanels.ts` reasoning: a
 * type exported from a `.vue` file is invisible to type-aware lint and
 * collapses to `any` at the import site; a `.ts` module is seen by
 * everything).
 *
 * A command is deliberately DUMB: a label to show and match, an optional muted
 * hint and keyword line, and the closure to run. No enabled/disabled state, no
 * arguments, no nesting — VS Code's palette reads as a list of verbs, and a
 * verb that needs a second question belongs in the dialog the verb opens.
 * Availability is decided by the BUILDER (a command absent from the array
 * does not exist), not by a disabled row: a palette row that cannot run is
 * noise in a surface whose whole job is to run things.
 */
export interface PaletteCommand {
  /** Stable identity — the key of the rendered row. */
  id: string;
  /** The row's text, matched by the filter. */
  label: string;
  /** Muted right-side context: where the command goes, the chord that owns it. */
  hint?: string;
  /** Extra match text that is never rendered — synonyms, path spellings. */
  keywords?: string;
  /** The thing that happens. Runs after the palette has closed itself. */
  run: () => void;
}
