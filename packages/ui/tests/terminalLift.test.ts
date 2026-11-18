import { describe, expect, it } from 'vitest';
import { terminalLiftPx } from '../src/app/terminalLift';

describe('terminalLiftPx (#3128: lift the view, never resize the terminal)', () => {
  const open = { sessionTab: true, cardTop: 600, paneBottom: 900 };
  it('lifts a phone session terminal by the card overlap', () => {
    expect(terminalLiftPx({ layout: 'compact', ...open })).toBe(300);
  });
  it.each(['medium', 'expanded'] as const)('never lifts on the %s layout (D44: desktop unchanged)', (layout) => {
    expect(terminalLiftPx({ layout, ...open })).toBe(0);
  });
  it('drops back to 0 when the composer closes, on a non-session tab, or with no overlap', () => {
    expect(terminalLiftPx({ layout: 'compact', ...open, cardTop: null })).toBe(0);
    expect(terminalLiftPx({ layout: 'compact', ...open, sessionTab: false })).toBe(0);
    expect(terminalLiftPx({ layout: 'compact', ...open, cardTop: 950 })).toBe(0);
    expect(terminalLiftPx({ layout: 'compact', ...open, paneBottom: null })).toBe(0);
  });
});
