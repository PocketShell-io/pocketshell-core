import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THEMES } from '@ui/themes';

/**
 * The guard against xterm's DOM-renderer inverse-contrast lift, executed
 * rather than remembered.
 *
 * TerminalView.vue overrides the colour of `.xterm-bg-257` cells (reverse
 * video over DEFAULT colours — the aplexer status bar's shape: the bar is
 * drawn as plain `ESC[7m`, status_bar.rs's `status_bar_sequence`) with the
 * theme's own background. xterm's row factory measures that cell's contrast
 * as theme.foreground (the text candidate it passes) against theme.foreground
 * (the painted ground the inverse swap produced) — 1:1 — and rewrites the
 * colour inline instead of applying the `xterm-fg-257` rule, whose value is
 * exactly theme.background. The rewrite darkens in ceil(10%) iterations:
 * 204, 183, 164, 147, 132, 118, 106 — a 3.37:1 gray where Windows Terminal,
 * fed the same bytes and the same Campbell palette, renders the theme ink at
 * 15:1. Measured on a real bar before the guard existed.
 *
 * The guard is exact, not a blunt override, for the same reason: on these
 * cells theme.background IS the colour xterm would paint without the bug, so
 * the guard becomes a no-op the day upstream picks the right candidate. Two
 * shapes are deliberately left on xterm's own path: selected cells (they take
 * the RGB background path and never carry `xterm-bg-257`) and dim cells
 * (`:not(.xterm-dim)` — their checker run is dim-aware, MCR halved).
 *
 * The override keys on an xterm INTERNAL — the numeric INVERTED_DEFAULT_COLOR
 * behind the class name — so both halves are pinned here: the constant the
 * selector is built from, and the rule itself. The parity gate underneath
 * (`--term-bg` == `terminal.background` per theme) is what makes
 * `var(--term-bg)` the right ink with no script attached.
 */

const XTERM_BUNDLE = readFileSync(
  fileURLToPath(new URL('../node_modules/@xterm/xterm/lib/xterm.js', import.meta.url)),
  'utf8',
);
const TERMINAL_VIEW = readFileSync(
  fileURLToPath(new URL('../src/app/components/TerminalView.vue', import.meta.url)),
  'utf8',
);

describe('inverse-video default cells keep the theme ink', () => {
  it('the installed xterm still numbers INVERTED_DEFAULT_COLOR 257', () => {
    const match = /INVERTED_DEFAULT_COLOR=(\d+)/.exec(XTERM_BUNDLE);
    expect(match?.[1]).toBe('257');
  });

  it('the guard rule overrides the lifted inline colour for non-dim inverse cells', () => {
    const flat = TERMINAL_VIEW.replace(/\s+/g, ' ');
    expect(flat).toContain(
      '.terminal :deep(.xterm-bg-257:not(.xterm-dim)) { color: var(--term-bg) !important; }',
    );
  });

  it('`--term-bg` is every theme’s terminal background, so the guard tracks the theme', () => {
    for (const theme of THEMES) {
      expect(theme.terminal.background?.toLowerCase()).toBe(
        theme.tokens['--term-bg']?.toLowerCase(),
      );
    }
  });
});
