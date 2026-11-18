import { describe, expect, it } from 'vitest';
import { TERMINAL_LIFT_GAP_PX, terminalLiftPx } from '../src/app/terminalLift';

describe('terminalLiftPx (#3128: lift the view to the cursor row, never resize the terminal)', () => {
  const open = { sessionTab: true, cardTop: 600, paneBottom: 900 };

  it('lifts only as far as the cursor row needs to end just above the card', () => {
    expect(terminalLiftPx({ layout: 'compact', ...open, cursorBottom: 700 })).toBe(100 + TERMINAL_LIFT_GAP_PX);
  });

  it('does not lift at all when the cursor row is already above the card (prompt near the top)', () => {
    expect(terminalLiftPx({ layout: 'compact', ...open, cursorBottom: 120 })).toBe(0);
    expect(terminalLiftPx({ layout: 'compact', ...open, cursorBottom: 600 - TERMINAL_LIFT_GAP_PX })).toBe(0);
  });

  it('never lifts more than the card covers, and lifts the whole cover when the cursor is out of view', () => {
    expect(terminalLiftPx({ layout: 'compact', ...open, cursorBottom: 2000 })).toBe(300);
    expect(terminalLiftPx({ layout: 'compact', ...open, cursorBottom: null })).toBe(300);
    expect(terminalLiftPx({ layout: 'compact', ...open })).toBe(300);
  });

  it.each(['medium', 'expanded'] as const)('never lifts on the %s layout (D44: desktop unchanged)', (layout) => {
    expect(terminalLiftPx({ layout, ...open, cursorBottom: 880 })).toBe(0);
  });

  it('drops back to 0 when the composer closes, on a non-session tab, or with no overlap', () => {
    expect(terminalLiftPx({ layout: 'compact', ...open, cursorBottom: 880, cardTop: null })).toBe(0);
    expect(terminalLiftPx({ layout: 'compact', ...open, cursorBottom: 880, sessionTab: false })).toBe(0);
    expect(terminalLiftPx({ layout: 'compact', ...open, cursorBottom: 880, cardTop: 950 })).toBe(0);
    expect(terminalLiftPx({ layout: 'compact', ...open, cursorBottom: 880, paneBottom: null })).toBe(0);
  });
});
