import { describe, expect, it } from 'vitest';
import { readPagerBar } from '@ui/app/terminalPane';

/**
 * The pager is host state no protocol exposes — the ONLY thing it publishes
 * is its status bar row, so `readPagerBar` is the whole of the desktop's pager
 * detection. Every string below is a real aplexer bar, spelled in
 * aplexer/status_bar.rs (`scroll_bar_text`) and scroll.rs (`scroll_bar_text`
 * for the pager row). If aplexer changes the words, this file is where the
 * two repos meet to say so.
 */
describe('readPagerBar', () => {
  it('reads the live bar as un-paged', () => {
    const live = '~/git/pocketshell:main  RUNNING  claude  |  ^b ?';
    expect(readPagerBar(live)).toEqual({ paged: false, typing: false, offsetLines: null });
  });

  it('reads the live bar of a stopped shell the same way', () => {
    const live = 'scratch  EXITED  shell  ^b ?';
    expect(readPagerBar(live)).toEqual({ paged: false, typing: false, offsetLines: null });
  });

  it('reads the pager bar with its position', () => {
    const paged = 'SCROLL 9/214 · PgUp/PgDn ↑↓ Home/End · q live · keys go here, not to the session';
    expect(readPagerBar(paged)).toEqual({ paged: true, typing: false, offsetLines: 9 });
  });

  it('reads a pager at the bottom as paged at offset 0', () => {
    const paged = 'SCROLL 0/0 · no history: the workload owns the screen · q live';
    expect(readPagerBar(paged)).toEqual({ paged: true, typing: false, offsetLines: 0 });
  });

  it('reads the narrowed fallback as paged with no position', () => {
    // fit_bar_text's minimum keeps the mode word and the way out; the numbers
    // are the first thing to go, and the exit takes the blind sweep.
    expect(readPagerBar('SCROLL · q')).toEqual({ paged: true, typing: false, offsetLines: null });
  });

  it('reads type-through as paged but typing — the keys already reach the session', () => {
    const typing = 'SCROLL 3/214 · TYPE — keys go to the session · Esc back to paging';
    expect(readPagerBar(typing)).toEqual({ paged: true, typing: true, offsetLines: 3 });
    expect(readPagerBar('SCROLL 0/5 · TYPE')).toEqual({ paged: true, typing: true, offsetLines: 0 });
  });

  it('does not mistake a workspace path for the mode word', () => {
    // A folder literally named SCROLL must not page the detector: the bar's
    // word is followed by its position, a path's by the next path segment.
    const live = '~/git/SCROLL/fix:main  RUNNING  claude  |  ^b ?';
    expect(readPagerBar(live)).toEqual({ paged: false, typing: false, offsetLines: null });
  });

  it('does not mistake a branch named TYPE for type-through', () => {
    // The branch segment is set off by the ⎇ glyph and spaces, never by the
    // " · " separator the pager's TYPE suffix carries.
    const live = '~/git/api:main  ⎇ TYPE  RUNNING  claude  |  ^b ?';
    const read = readPagerBar(live);
    expect(read.paged).toBe(false);
    expect(read.typing).toBe(false);
  });
});
