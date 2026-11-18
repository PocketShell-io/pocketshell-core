/**
 * Monospace typography as a setting: which family, and at what size.
 *
 * Everything here is pure. The surfaces that consume it are wildly different —
 * CSS custom properties for the app chrome, a CodeMirror theme that reads those
 * same properties, and xterm.js which reads NEITHER and has to be assigned to
 * in JavaScript — so the rules about what a legal font setting even is have to
 * live somewhere all three can share and none of them can quietly fork.
 *
 * ---------------------------------------------------------------------------
 * ONE FAMILY, TWO SIZES — and why that is not an inconsistency
 * ---------------------------------------------------------------------------
 * The FAMILY is a single setting for the whole app, because the app already
 * treats it as a single fact. `--font-mono` is not "the terminal's font": it is
 * the font of the terminal, the file editor, session names, ports, paths, IDs
 * and chips, and the terminal says why in as many words — "use the same
 * face for the app's mono chrome … so the terminal and the UI that frames it
 * read as one surface". A per-surface family setting would let a user break
 * that on purpose, which is not a feature; it is the design being undone one
 * dropdown at a time. So the setting moves the token, and the token moves
 * everything downstream of it for free.
 *
 * The SIZE is two settings, because size is where the surfaces genuinely
 * differ:
 *
 *   - They ship at different values TODAY — 16px in the terminal
 *     (TERMINAL_OPTIONS.fontSize, mirrored by `--term-font-size`) and 13px in
 *     the editor (`--fs-300`, the app's workhorse). One shared size would have
 *     to pick one, and either choice silently resizes a surface on upgrade for
 *     every existing user. The brief was explicit that nothing may change size
 *     on upgrade, and that applies to the editor as much as to the terminal.
 *   - The terminal's size has a REMOTE consequence the editor's does not. Cell
 *     size decides the column and row count, which is pushed to the PTY, which
 *     makes tmux reflow on the far end. Bumping the editor two points reflows
 *     some text in a pane; bumping the terminal two points changes what the
 *     program on the other side of the wire believes about its screen. Those
 *     are not the same decision and it is right that they are two controls.
 *   - The app's UI type scale (`--fs-100`…`--fs-600`) is deliberately NOT
 *     included in either. It is a density system — 28px rows, 40px bars, the
 *     11/12/13/15/18/20 ladder — and driving it from a font
 *     preference would rewrite every row height in the app. "Font size" here
 *     means the size of the text the user READS, not the scale of the chrome.
 */

/**
 * The face every client bundles (fonts.css, assets/fonts): JetBrains Mono, OFL.
 * It is the first family of every shipped stack so the terminal and the mono
 * chrome are the same real monospace face on every platform, installed or not.
 */
export const BUNDLED_MONO_FAMILY = 'JetBrains Mono';

/**
 * The bundled symbol fallback (fonts.css, assets/fonts, #3157): the symbols
 * terminal UIs draw that JetBrains Mono lacks — Claude Code's ⏵⏵ ✻ ⎿ ⧉ and
 * friends — re-fitted to JetBrains Mono's 0.6em cell. A phone has no system
 * font for most of them, so without it they render as .notdef boxes (tofu).
 * It is inserted after the first family in the COMPACT layout only
 * ({@link monoStackFor}); it answers only code points that face does not have
 * (and its @font-face `unicode-range` keeps it out of every other script).
 */
export const SYMBOL_FALLBACK_FAMILY = 'PocketShell Symbols';

/**
 * The desktop/web stack: the bundled face, then the OS faces it used to lead
 * with. No symbol fallback here: a desktop OS has symbol fonts of its own,
 * and the phone slice (#3157) changes nothing on the desktop (D44).
 */
export const DEFAULT_MONO_STACK = `'${BUNDLED_MONO_FAMILY}', Consolas, 'Cascadia Mono', ui-monospace, monospace`;
/** The phone stack: the bundled face and the platform's own monospace — no Consolas on Android. */
export const BUNDLED_MONO_STACK = `'${BUNDLED_MONO_FAMILY}', ui-monospace, monospace`;

/**
 * A stack with the symbol fallback inserted straight after its first family
 * (#3157). Only the compact (phone) layout uses it — see {@link monoStackFor}:
 * a phone has no system font for ⏵ ✻ ⎿ ⧉, and D44 keeps wide rendering
 * exactly as it was.
 */
export function withSymbolFallback(stack: string): string {
  if (stack.includes(SYMBOL_FALLBACK_FAMILY)) return stack;
  const comma = stack.indexOf(',');
  const symbols = `'${SYMBOL_FALLBACK_FAMILY}'`;
  return comma < 0 ? `${stack}, ${symbols}` : `${stack.slice(0, comma)}, ${symbols}${stack.slice(comma)}`;
}

/** The mono stack in effect for a layout: {@link resolveMonoStack}, plus the symbol fallback on compact. */
export function monoStackFor(
  family: string | null | undefined,
  fallbackStack: string | undefined,
  compact: boolean,
): string {
  const stack = resolveMonoStack(family, fallbackStack);
  return compact ? withSymbolFallback(stack) : stack;
}

/**
 * Exactly the characters a terminal agent UI draws that #3157 found as tofu
 * on a phone, plus the box drawing they sit in. Tests render these and
 * require a real glyph for every one; nothing in the app reads it.
 */
export const TERMINAL_SYMBOL_PROBE = '⏵⏸⏺✻✳✶✢·⎿❯●○◯◉↓↑←→✓✔✗✘⧉…│─╭╮╯╰├┤▐▛▜▌';

/** The shipped stack, and the tail every custom family falls back through. */
const FALLBACK_STACK = DEFAULT_MONO_STACK;

/**
 * The picker's suggestions. NOT an allow-list — the control is a combobox and
 * any sanitised name is accepted — because an Electron renderer has no reliable
 * way to enumerate installed fonts (`queryLocalFonts` is behind a permission
 * Electron does not surface, and probing by measuring glyph widths is a
 * heuristic that misreports on metric-compatible faces). A curated list of
 * families that are common on this app's platforms, plus free text for
 * everything else, is the honest answer.
 *
 * Ordered by how likely they are to already be installed on the Windows target
 * this app is built for, then the cross-platform developer faces, then the
 * macOS system monos.
 */
export const MONOSPACE_FAMILIES: readonly string[] = [
  BUNDLED_MONO_FAMILY,
  'Consolas',
  'Cascadia Mono',
  'Cascadia Code',
  'Lucida Console',
  'Courier New',
  'Fira Code',
  'Source Code Pro',
  'IBM Plex Mono',
  'Hack',
  'DejaVu Sans Mono',
  'Menlo',
  'SF Mono',
  'Monaco',
  'Ubuntu Mono',
];

/**
 * Size bounds, shared by both size settings.
 *
 * The UI type scale tops out at 20px and that is deliberately
 * NOT the cap here: the scale sizes chrome, and this sizes the text a user
 * stares at all day, which is a property of their eyes and their monitor rather
 * than of the design system. The bounds exist for the case the brief names —
 * a 4px or 400px terminal is not a preference, it is a mistake — and they are
 * the only thing standing between a hand-edited settings blob and an app with
 * one cell in it.
 *
 * 8 at the bottom: below that Consolas' hinting collapses under greyscale
 * antialiasing and tmux's status line stops being readable, which is the line
 * the user relies on to know which session they are in.
 * 32 at the top: past that a single cell is wider than a UI row is tall, and
 * the terminal stops being able to show a conventional 80 columns in any
 * window this app opens. (Consolas' advance is 0.5493em, so 80 columns needs
 * 80 x 0.5493 x size px — about 980px of pane at 22px, which is roughly what a
 * 1280px window has left once the session panel is open. Above ~22 the user is
 * trading columns for legibility, which is their call to make; 32 is where the
 * trade stops being a trade.)
 */
export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 32;

/** Exactly what ships today, so an upgrade changes nothing on screen. */
export const TERMINAL_FONT_SIZE_DEFAULT = 16;
/**
 * The compact (phone) default, Termius' density on the same phone (#3157).
 *
 * Termius renders the very same face, JetBrains Mono, at a ~6.83 CSS px cell
 * on a 411dp-wide Pixel 7a (~57 columns, measured from the maintainer's
 * screenshot). JetBrains Mono's advance is 0.6em, so 12px is a 7.2px cell:
 * 411dp minus the compact 2px gutters is 56 columns — where 13px (7.8px) gave
 * 41 inside the rail-framed pane and 16px (9.6px) gave ~33. 11.5px (59
 * columns) is one half-pixel step down in Settings.
 */
export const TERMINAL_FONT_SIZE_COMPACT_DEFAULT = 12;

/**
 * The terminal size for a layout. They are two settings, not one with two
 * defaults: a phone and a desktop window want genuinely different cells, and
 * a stored single size cannot tell a user's choice from a default an earlier
 * build persisted — which is exactly how a phone kept the desktop's 16px
 * (31 columns) after #3138 shipped a phone default (#3157).
 */
export function terminalFontSizeFor(
  settings: { terminalFontSize: number; compactTerminalFontSize: number },
  compact: boolean,
): number {
  return compact ? settings.compactTerminalFontSize : settings.terminalFontSize;
}
/** `--fs-300`, the value `codeEditorTheme.ts` has always used. */
export const EDITOR_FONT_SIZE_DEFAULT = 13;

/** Characters legal in a family name here. Everything else is dropped. */
const FAMILY_ALLOWED = /[^A-Za-z0-9 _.-]+/g;
/** Long enough for any real face name; short enough to bound a stored blob. */
const FAMILY_MAX_LENGTH = 64;

/**
 * Normalise a user-entered or stored family name.
 *
 * Returns `null` for "no choice — use the shipped stack", `undefined` for a
 * value that cannot be trusted at all (which the settings store reads as "fall
 * back to the default"), and a cleaned single family name otherwise.
 *
 * The character filter is not paranoia about CSS injection alone — although it
 * is that too, since this string is written into a custom property and handed
 * to xterm as a font stack. It is also what makes ONE family mean one family:
 * commas are stripped, so a user cannot enter a stack of their own and thereby
 * bypass the fallback tail below. They do not need to; the tail is appended for
 * them, and it is what guarantees the terminal can never end up proportional.
 */
export function sanitiseFontFamily(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw
    .replace(FAMILY_ALLOWED, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, FAMILY_MAX_LENGTH)
    .trim();
  return cleaned === '' ? null : cleaned;
}

/** The size granularity everywhere but the phone's terminal: a whole pixel. */
export const FONT_SIZE_STEP = 1;
/**
 * The phone terminal's granularity: half a pixel (#3157). A whole-pixel step
 * is too coarse there, where one pixel of font is ~5 columns of a 411dp
 * screen; Termius' density sits between 11px (61 columns) and 12px (56). The
 * desktop's sizes keep whole pixels (D44: the phone slice changes no desktop
 * control).
 */
export const COMPACT_FONT_SIZE_STEP = 0.5;

/** Pull `n` into [FONT_SIZE_MIN, FONT_SIZE_MAX] and onto a multiple of `step` (default a whole pixel). */
export function clampFontSize(n: number, step: number = FONT_SIZE_STEP): number {
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n / step) * step));
}

/**
 * Parse a stored/entered size.
 *
 * An out-of-range NUMBER is clamped rather than rejected: 400 is a user who
 * wanted "big", or a stepper someone leant on, and honouring the intent at the
 * legal maximum is friendlier than silently reverting to 16. A value that is
 * not a finite number at all carries no intent to honour and is rejected, which
 * sends the settings store to that key's default.
 */
export function parseFontSize(raw: unknown, step: number = FONT_SIZE_STEP): number | undefined {
  const n = typeof raw === 'string' ? Number(raw.trim()) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  return clampFontSize(n, step);
}

/** The phone terminal's size: {@link parseFontSize} on half pixels (#3157). */
export function parseCompactFontSize(raw: unknown): number | undefined {
  return parseFontSize(raw, COMPACT_FONT_SIZE_STEP);
}

/**
 * Build the CSS font stack for a chosen family.
 *
 * The chosen family is PREPENDED to the shipped stack rather than replacing it,
 * which is the whole mechanism behind the brief's hard requirement: a family
 * the user does not actually have installed falls through to Consolas, then to
 * `ui-monospace`, then to the `monospace` generic. There is no path by which an
 * unavailable choice lands on a proportional face — a terminal in a
 * proportional font is not degraded, it is broken.
 *
 * The name is double-quoted because {@link sanitiseFontFamily} has already
 * removed every quote and backslash, so quoting is safe and covers the families
 * whose names contain spaces without a per-name special case.
 */
export function resolveMonoStack(
  family: string | null | undefined,
  fallbackStack = FALLBACK_STACK,
): string {
  const clean = sanitiseFontFamily(family ?? null);
  return clean ? `"${clean}", ${fallbackStack}` : fallbackStack;
}

/** The subset of settings this module needs. Keeps the store out of here. */
export interface FontSettings {
  monospaceFontFamily: string | null;
  /** The terminal size in effect for the current layout (see terminalFontSizeFor). */
  terminalFontSize: number;
  editorFontSize: number;
}

/**
 * The custom properties that carry these settings into the DOM.
 *
 * Returned as data rather than written here so the mapping is unit-testable and
 * so exactly one component (App.vue) owns the act of touching the document.
 * Every consumer downstream is plain CSS and updates live with no JavaScript at
 * all: `codeEditorTheme.ts` reads `--font-mono` and `--code-font-size`, and the
 * app's mono chrome reads `--font-mono`.
 *
 * xterm is the exception and cannot be served this way — it rasterises to a
 * canvas from an options object and never consults the cascade — so
 * `TerminalView.vue` assigns `term.options.fontFamily/fontSize` itself. That is
 * why {@link resolveMonoStack} is exported separately: the terminal needs the
 * same string, by a different route.
 */
export function fontCssVariables(
  settings: FontSettings,
  fallbackStack = FALLBACK_STACK,
  compact = false,
): Record<string, string> {
  return {
    '--font-mono': monoStackFor(settings.monospaceFontFamily, fallbackStack, compact),
    // Half-pixel clamp: the phone terminal's size may be one (#3157); a
    // desktop size is always whole, so this changes nothing there.
    '--term-font-size': `${clampFontSize(settings.terminalFontSize, COMPACT_FONT_SIZE_STEP)}px`,
    '--code-font-size': `${clampFontSize(settings.editorFontSize)}px`,
  };
}

/** What xterm exposes that {@link remeasureAfterFontLoad} needs; keeps xterm out of this module. */
export interface FontMeasuredTerminal {
  options: { fontFamily?: string; fontWeight?: unknown; fontWeightBold?: unknown };
}

/**
 * The faces a terminal draws: regular and bold of the first family in the
 * stack, and the symbol fallback when the stack carries it. The fallback is
 * loaded with a symbol as its sample text — its `unicode-range` excludes the
 * default sample (a space), which would resolve without loading anything —
 * and it is loaded up front because xterm caches each character's measured
 * width: a symbol measured before its face arrived keeps the wrong spacing.
 */
function faceQueries(stack: string, sizePx: number): Array<[string, string?]> {
  const first = stack.split(',')[0]?.trim() ?? '';
  const queries: Array<[string, string?]> = first === ''
    ? []
    : [[`400 ${sizePx}px ${first}`], [`700 ${sizePx}px ${first}`]];
  if (stack.includes(SYMBOL_FALLBACK_FAMILY)) {
    queries.push([`400 ${sizePx}px '${SYMBOL_FALLBACK_FAMILY}'`, TERMINAL_SYMBOL_PROBE]);
  }
  return queries;
}

/**
 * Resolve once the first family of `stack` is actually loaded (both weights).
 * Never rejects: a platform without the FontFaceSet API, or a face that fails
 * to load, resolves immediately — the stack's tail is already a monospace.
 */
export async function loadMonoFace(stack: string, sizePx: number): Promise<void> {
  const set = typeof document === 'undefined' ? undefined : document.fonts;
  if (!set || typeof set.load !== 'function') return;
  try {
    await Promise.all(faceQueries(stack, sizePx).map(([q, text]) => set.load(q, text)));
  } catch {
    // The stack falls through to a system monospace; measuring then is right.
  }
}

/**
 * Re-measure a terminal's cell after its face finished loading.
 *
 * xterm measures its cell width once, when the font option is set. A terminal
 * opened before the webfont is ready measures the FALLBACK face, and keeps
 * those metrics once the real face paints — a cell-width mismatch that shows
 * as wrong column counts and misaligned box drawing. xterm ignores an option
 * assignment that does not change the value, so the font is bounced through
 * one different string and back (both measure; the last one is the real face),
 * then `refit` recomputes cols/rows from the new cell.
 *
 * `isDisposed` is consulted after each await; once true, nothing is written
 * and no refit is requested. Returns after the refit has been requested;
 * awaiting it is optional.
 */
export async function remeasureAfterFontLoad(
  term: FontMeasuredTerminal,
  stack: string,
  sizePx: number,
  refit: () => void,
  isDisposed: () => boolean = () => false,
): Promise<void> {
  await loadMonoFace(stack, sizePx);
  if (isDisposed()) return;
  // `ready` also covers a face the stylesheet starts loading late.
  try {
    await document.fonts?.ready;
  } catch {
    // ignore: see loadMonoFace
  }
  // Every write below happens after an await: the terminal may have been
  // disposed meanwhile, and writing an option on a disposed xterm throws.
  if (isDisposed()) return;
  const current = term.options.fontFamily ?? stack;
  term.options.fontFamily = `${current}, monospace`;
  term.options.fontFamily = current;
  refit();
}
