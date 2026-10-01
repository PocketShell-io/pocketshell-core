/**
 * The inset contract: the custom properties that say how much of the
 * viewport the platform's own chrome covers.
 *
 *   --ps-inset-top       status bar / notch
 *   --ps-inset-bottom    navigation bar / home indicator
 *   --ps-inset-left      a cutout or bar on the left (a phone in landscape)
 *   --ps-inset-right     a cutout or bar on the right (a phone in landscape)
 *   --ps-inset-keyboard  the on-screen keyboard, when it overlays the page
 *
 * `tokens.css` defaults all of them to 0px, and desktop and web never write
 * them. A platform whose chrome draws over the page (a phone WebView drawn
 * edge to edge) writes them here, from whatever its native layer reports.
 * Shared CSS reads the variables and never `env(safe-area-inset-*)`, so the
 * same rule lays out every client and the platform stays the only thing that
 * knows where its bars are.
 */
export const INSET_VARIABLES = {
  top: '--ps-inset-top',
  bottom: '--ps-inset-bottom',
  left: '--ps-inset-left',
  right: '--ps-inset-right',
  keyboard: '--ps-inset-keyboard',
} as const;

export type InsetEdge = keyof typeof INSET_VARIABLES;

/**
 * A number is CSS pixels. A string is any CSS length expression, so a
 * platform can hand over `env(safe-area-inset-top, 0px)` when its WebView
 * does resolve it. `null` removes the override, falling back to the 0px
 * default.
 */
export type InsetValue = number | string | null;

export type AppInsets = Partial<Record<InsetEdge, InsetValue>>;

function cssLength(value: number | string): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`inset must be a finite, non-negative pixel count, got ${value}`);
    }
    return `${value}px`;
  }
  return value;
}

/** The style surface the insets are written onto; `<html>` by default. */
export interface InsetTarget {
  style: Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'>;
}

/**
 * Write the given edges onto `target` (default `document.documentElement`).
 * Edges not named are left as they are, so the keyboard inset can move on its
 * own without restating the bars.
 */
export function writeAppInsets(insets: AppInsets, target?: InsetTarget): void {
  const el = target ?? document.documentElement;
  for (const edge of Object.keys(insets) as InsetEdge[]) {
    const name = INSET_VARIABLES[edge];
    if (name === undefined) throw new Error(`unknown inset edge: ${String(edge)}`);
    const value = insets[edge];
    if (value === undefined) continue;
    if (value === null) el.style.removeProperty(name);
    else el.style.setProperty(name, cssLength(value));
  }
}
