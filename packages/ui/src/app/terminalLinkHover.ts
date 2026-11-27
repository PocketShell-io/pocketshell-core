/**
 * The hover underline that covers a link's EVERY row — the half xterm's own
 * hover cannot give.
 *
 * Both link detectors (terminalLinks.ts) hand xterm one fragment link per row
 * a match touches, so xterm's native hover underline — drawn per row, and
 * through empty space on every row that is not the range's last — stays
 * confined to the single row under the mouse. A URL the remote CLI's wrapper
 * broke across three rows therefore read as three half-links: hover painted
 * the row under the cursor and nothing else, however whole the address the
 * click opened was. This layer closes the gap: every fragment's `hover` hands
 * its SIBLING fragments' plain stretches ({@link LinkHoverSegment}) to
 * {@link LinkHoverPainter}, which draws the underline bar under each of them
 * in the row's own foreground — the same vocabulary xterm's native underline
 * uses for the hovered fragment itself. The hovered fragment keeps that
 * native underline; the painter is never asked about it, and never asked
 * about cells the remote CLI already underlined at rest (their stretch reads
 * underlined with no hover at all, and a second bar there would thicken, not
 * underline).
 *
 * The bars live in an absolutely-positioned layer inside `.xterm-screen`,
 * `pointer-events: none` throughout: hit-testing and clicks stay xterm's, and
 * the layer can never turn a hover into an activation or the reverse. While a
 * link is hovered the layer re-derives every bar from the buffer on each
 * `onRender` — a scroll moves the viewport under a stationary mouse, a resize
 * re-measures the cell — so a bar is always where its cells now are, and
 * vanishes with them when they scroll out. `show`/`hide` exchange tokens so a
 * `leave` that arrives after the NEXT fragment's `hover` (the event order
 * across a fragment boundary is xterm's own) cannot erase the link the
 * pointer is on now.
 */
import type { IDisposable, ITheme, Terminal } from '@xterm/xterm';

/** One row's stretch of a link, in buffer coordinates. */
export interface LinkHoverSegment {
  /** 0-based column of the stretch's first cell. */
  x: number;
  /** Cells the stretch spans, a double-width character counted by its width. */
  width: number;
  /** The 1-based buffer line the stretch sits on. */
  line: number;
}

/**
 * What the link builders call on hover and leave. An interface rather than
 * the class so the DOM work stays in one place and a test can inject a
 * recorder.
 */
export interface LinkHoverPaint {
  /** Begin painting [segments]; the answer is the token to pass `hide`. */
  show(segments: LinkHoverSegment[]): number;
  /** Stop painting — but only if [token] is still the live show. */
  hide(token: number | null): void;
}

const NAMED_PALETTE = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
] as const;
const BRIGHT_PALETTE = [
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const;

export class LinkHoverPainter implements LinkHoverPaint {
  private layer: HTMLElement | null = null;
  private segments: LinkHoverSegment[] = [];
  private latest = 0;
  private current = 0;
  private renderSubscription: IDisposable | null = null;

  constructor(private readonly term: Terminal) {}

  show(segments: LinkHoverSegment[]): number {
    const token = ++this.latest;
    this.current = token;
    this.segments = segments;
    this.repaint();
    // Repaint on every render while something is shown — a scroll moves the
    // viewport under a stationary mouse, and a resize re-measures the cell.
    // With nothing shown there is nothing to track, so the subscription
    // covers exactly the shown span and `hide` ends it.
    if (this.segments.length > 0 && this.renderSubscription === null) {
      this.renderSubscription = this.term.onRender(() => this.repaint());
    }
    return token;
  }

  hide(token: number | null): void {
    if (token === null || token !== this.current) return;
    this.current = 0;
    this.segments = [];
    this.clearBars();
    if (this.renderSubscription !== null) {
      this.renderSubscription.dispose();
      this.renderSubscription = null;
    }
  }

  dispose(): void {
    this.hide(this.current);
    this.layer?.remove();
    this.layer = null;
  }

  private repaint(): void {
    const screen = this.term.element?.querySelector<HTMLElement>('.xterm-screen') ?? null;
    if (screen === null || this.segments.length === 0) {
      this.clearBars();
      return;
    }
    if (this.layer === null || !this.layer.isConnected) {
      this.layer = document.createElement('div');
      this.layer.className = 'terminal-link-hover-underlines';
      const style = this.layer.style;
      style.position = 'absolute';
      style.left = '0';
      style.top = '0';
      style.width = '100%';
      style.height = '100%';
      style.pointerEvents = 'none';
      screen.appendChild(this.layer);
    }
    const rect = screen.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      this.clearBars();
      return;
    }
    // The screen element spans exactly cols x rows cells, so the cell size is
    // the rect divided out — renderer-independent (DOM or canvas alike), and
    // correct under zoom because the rect zooms with the cells.
    const cellWidth = rect.width / this.term.cols;
    const cellHeight = rect.height / this.term.rows;
    const viewportY = this.term.buffer.active.viewportY;
    // A glyph baseline sits ~80% down its cell; the bar goes just under it,
    // scaled with the cell so it tracks the font size. `drop` lifts it off
    // the very bottom edge, where the next row begins.
    const thickness = Math.max(1, Math.round(cellHeight / 12));
    const baseline = Math.round(cellHeight * 0.8);
    this.clearBars();
    for (const segment of this.segments) {
      const row = segment.line - 1 - viewportY;
      if (row < 0 || row >= this.term.rows) continue;
      const bar = document.createElement('div');
      const style = bar.style;
      style.position = 'absolute';
      style.left = `${segment.x * cellWidth}px`;
      style.width = `${segment.width * cellWidth}px`;
      style.top = `${row * cellHeight + baseline - thickness}px`;
      style.height = `${thickness}px`;
      style.background = underlineColor(this.term, segment);
      this.layer.appendChild(bar);
    }
  }

  private clearBars(): void {
    if (this.layer !== null) this.layer.replaceChildren();
  }
}

/**
 * The foreground the bar under [segment] is drawn in — the cell's own, so the
 * underline inherits the cell's own foreground the way xterm's native hover
 * underline does and a path printed green underlines green.
 *
 * Guarded duck-checks, for the same reason `cellUnderline` in terminalLinks.ts
 * has them: the test fakes build cells by hand and carry no colour, and a
 * cell without colour answers the theme's default foreground.
 */
function underlineColor(term: Terminal, segment: LinkHoverSegment): string {
  const theme: ITheme = term.options.theme ?? {};
  const line = term.buffer.active.getLine(segment.line - 1);
  const cell = line?.getCell(segment.x);
  if (
    cell !== undefined &&
    typeof cell.isFgRGB === 'function' &&
    typeof cell.isFgPalette === 'function' &&
    typeof cell.getFgColor === 'function'
  ) {
    if (cell.isFgRGB()) return rgb(cell.getFgColor());
    if (cell.isFgPalette()) {
      const named = paletteColor(theme, cell.getFgColor());
      if (named !== undefined) return named;
    }
  }
  return theme.foreground ?? '#ffffff';
}

/** The theme entry for a 256-colour palette index, or undefined past it. */
function paletteColor(theme: ITheme, index: number): string | undefined {
  if (index < 8) return theme[NAMED_PALETTE[index] ?? 'black'];
  if (index < 16) return theme[BRIGHT_PALETTE[index - 8] ?? 'brightBlack'];
  return theme.extendedAnsi?.[index - 16];
}

function rgb(value: number): string {
  return `#${(value & 0xffffff).toString(16).padStart(6, '0')}`;
}
