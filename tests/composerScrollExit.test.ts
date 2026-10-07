import { describe, expect, it } from 'vitest';
import {
  ARROW_DOWN_KEY,
  PAGE_DOWN_KEY,
  SCROLL_EXIT_ATTEMPTS,
  SCROLL_EXIT_GAP_MS,
  SCROLL_EXIT_SWEEP_LINES,
  SCROLL_EXIT_SWEEP_PAGES,
  deliverPayload,
  scrollExitKeys,
  type PaneScrollProbe,
} from '../src';

/**
 * The send that leaves aplexer's pager first.
 *
 * A prompt delivered while the pager holds the keyboard is eaten whole — every
 * byte is "navigation or not" (aplexer scroll_input.rs) — and the chunk that
 * closes the pager discards whatever trails it. These pin the wire contract of
 * the exit: exact keys sized from the bar's own position, the read-boundary
 * gap, the re-ask that self-heals a short walk, and the abort when the exit
 * itself fails to land.
 */

const noSleep = async (): Promise<void> => {};

function recorder(result = true): { writes: string[]; write: (d: string) => Promise<boolean> } {
  const writes: string[] = [];
  return {
    writes,
    write: async (d: string) => {
      writes.push(d);
      return result;
    },
  };
}

describe('scrollExitKeys — sizing the walk from the bar', () => {
  it('sends exactly one Down for a pager already at the bottom (offset 0)', () => {
    // The one past-the-bottom press IS the exit; nothing may precede it.
    expect(scrollExitKeys(0, 41)).toBe(ARROW_DOWN_KEY);
  });

  it('covers a short walk with Downs alone', () => {
    // Page 40 rows; an offset of 9 is all remainder: 9 lines + the exit press.
    expect(scrollExitKeys(9, 41)).toBe(ARROW_DOWN_KEY.repeat(10));
  });

  it('burns the bulk of a deep walk with PageDowns, then Downs for the rest', () => {
    // Page = rows - 1 = 40. Offset 85 = 2 full pages + 5 lines, then the exit.
    expect(scrollExitKeys(85, 41)).toBe(PAGE_DOWN_KEY.repeat(2) + ARROW_DOWN_KEY.repeat(6));
  });

  it('lands the exit press even when the offset divides the page exactly', () => {
    // 80 lines at a 40-row page: two pages bring the pager to offset 0, and
    // the +1 Down is what leaves the mode.
    expect(scrollExitKeys(80, 41)).toBe(PAGE_DOWN_KEY.repeat(2) + ARROW_DOWN_KEY);
  });

  it('takes the blind sweep when the bar carried no position', () => {
    expect(scrollExitKeys(null, 41)).toBe(
      PAGE_DOWN_KEY.repeat(SCROLL_EXIT_SWEEP_PAGES) +
        ARROW_DOWN_KEY.repeat(SCROLL_EXIT_SWEEP_LINES),
    );
  });

  it('sweeps on absurd answers rather than dividing by a zero page', () => {
    // A one-row pane cannot page; a negative offset cannot happen. Both take
    // the bounded sweep instead of trusting the arithmetic.
    expect(scrollExitKeys(9, 1)).toBe(
      PAGE_DOWN_KEY.repeat(SCROLL_EXIT_SWEEP_PAGES) +
        ARROW_DOWN_KEY.repeat(SCROLL_EXIT_SWEEP_LINES),
    );
    expect(scrollExitKeys(-3, 41)).toBe(
      PAGE_DOWN_KEY.repeat(SCROLL_EXIT_SWEEP_PAGES) +
        ARROW_DOWN_KEY.repeat(SCROLL_EXIT_SWEEP_LINES),
    );
  });
});

describe('deliverPayload with probeScroll — leaving the pager before the prompt', () => {
  const payload = 'fix the flaky test';

  it('writes the sized exit first, gaps past the read boundary, then the prompt', async () => {
    const r = recorder();
    const slept: number[] = [];
    // The walk lands: the pane answers paged once, then live — the re-ask
    // below is what stops a second exit write from existing.
    let reads = 0;
    const ok = await deliverPayload(payload, {
      write: r.write,
      submitDelayMs: 0,
      sleep: async (ms) => {
        slept.push(ms);
      },
      probeScroll: () =>
        ++reads === 1
          ? { paged: true, offsetLines: 9, rows: 41 }
          : { paged: false, offsetLines: null, rows: 41 },
    });

    expect(ok).toBe(true);
    expect(r.writes).toEqual([
      ARROW_DOWN_KEY.repeat(10),
      payload,
      '\r',
    ]);
    // The gap is not decoration: aplexer discards the rest of the chunk that
    // closed the pager, so the payload must arrive in a LATER read.
    expect(slept).toEqual([SCROLL_EXIT_GAP_MS]);
  });

  it('sends nothing but the prompt when the pane is live', async () => {
    const r = recorder();
    const slept: number[] = [];
    await deliverPayload(payload, {
      write: r.write,
      submitDelayMs: 0,
      sleep: async (ms) => {
        slept.push(ms);
      },
      probeScroll: () => ({ paged: false, offsetLines: null, rows: 41 }),
    });

    expect(r.writes).toEqual([payload, '\r']);
    expect(slept).toEqual([]);
  });

  it('treats type-through as live — the keys already reach the session', async () => {
    // `i` in the pager hands the keyboard back; the probe answers paged:false
    // and the exit must not spray arrows at the agent's prompt.
    const r = recorder();
    await deliverPayload(payload, {
      write: r.write,
      submitDelayMs: 0,
      sleep: noSleep,
      probeScroll: () => ({ paged: false, offsetLines: 4, rows: 41 }),
    });
    expect(r.writes).toEqual([payload, '\r']);
  });

  it('re-asks after the walk, so a pager that sat deeper gets a second exit', async () => {
    const r = recorder();
    const probes: PaneScrollProbe[] = [
      { paged: true, offsetLines: 3, rows: 41 },
      { paged: true, offsetLines: 1200, rows: 41 },
      { paged: false, offsetLines: null, rows: 41 },
    ];
    const ok = await deliverPayload(payload, {
      write: r.write,
      submitDelayMs: 0,
      sleep: noSleep,
      probeScroll: () => probes.shift() ?? { paged: false, offsetLines: null, rows: 41 },
    });

    expect(ok).toBe(true);
    expect(r.writes).toEqual([
      ARROW_DOWN_KEY.repeat(4), // first walk: offset 3 + exit
      PAGE_DOWN_KEY.repeat(30) + ARROW_DOWN_KEY, // second: 30 pages of 40 + exit
      payload,
      '\r',
    ]);
  });

  it('gives up after the bounded attempts and sends anyway', async () => {
    const r = recorder();
    const ok = await deliverPayload(payload, {
      write: r.write,
      submitDelayMs: 0,
      sleep: noSleep,
      probeScroll: () => ({ paged: true, offsetLines: 2, rows: 41 }),
    });

    // A pager that outlives every walk gets the prompt regardless — the same
    // outcome as not asking, after a genuine effort, never an unsent draft.
    expect(ok).toBe(true);
    expect(r.writes).toHaveLength(SCROLL_EXIT_ATTEMPTS + 2);
    expect(r.writes.slice(0, SCROLL_EXIT_ATTEMPTS)).toEqual(
      Array(SCROLL_EXIT_ATTEMPTS).fill(ARROW_DOWN_KEY.repeat(3)),
    );
    expect(r.writes.at(-2)).toBe(payload);
    expect(r.writes.at(-1)).toBe('\r');
  });

  it('aborts on a failed exit write, before any payload byte exists', async () => {
    const r = recorder(false);
    const ok = await deliverPayload(payload, {
      write: r.write,
      submitDelayMs: 0,
      sleep: noSleep,
      probeScroll: () => ({ paged: true, offsetLines: 0, rows: 41 }),
    });

    expect(ok).toBe(false);
    expect(r.writes).toEqual([ARROW_DOWN_KEY]);
  });
});
