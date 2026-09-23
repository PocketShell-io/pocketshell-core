import { describe, expect, it } from 'vitest';
import {
  HOTKEY_CTRL_PAGE_ROWS,
  HOTKEY_PALETTE_MAIN_SECTIONS,
  SESSION_BAR_NAV_KEYS,
  terminalControlKeyGestureBytes,
  terminalKeyBytes,
  type ControlLetter,
} from '../src/terminalKeys';

const bytes = (value: Uint8Array | null): number[] | null => value == null ? null : [...value];

describe('shared mobile terminal hotkey catalog', () => {
  it('keeps Up, Down and Enter on the one-tap session bar with exact PTY bytes', () => {
    expect(SESSION_BAR_NAV_KEYS.map(({ id, label }) => [id, label])).toEqual([
      ['arrow-up', '↑'],
      ['arrow-down', '↓'],
      ['enter', 'Enter'],
    ]);
    expect(bytes(terminalKeyBytes('arrow-up'))).toEqual([0x1b, 0x5b, 0x41]);
    expect(bytes(terminalKeyBytes('arrow-down'))).toEqual([0x1b, 0x5b, 0x42]);
    expect(bytes(terminalKeyBytes('enter'))).toEqual([0x0d]);
    expect(bytes(terminalKeyBytes('enter'))).not.toEqual([0x0a]);
  });

  it('catalogs the palette arrows and named keys with their exact bytes', () => {
    expect(HOTKEY_PALETTE_MAIN_SECTIONS.map(({ title, keys }) => [title, keys.map(({ label }) => label)])).toEqual([
      ['ARROWS', ['←', '→']],
      ['KEYS', ['Esc', 'Tab', '⇧Tab']],
      ['CTRL', ['^B', '^C', '^D', '^Q', '^X']],
    ]);
    expect(bytes(terminalKeyBytes('arrow-left'))).toEqual([0x1b, 0x5b, 0x44]);
    expect(bytes(terminalKeyBytes('arrow-right'))).toEqual([0x1b, 0x5b, 0x43]);
    expect(bytes(terminalKeyBytes('escape'))).toEqual([0x1b]);
    expect(bytes(terminalKeyBytes('tab'))).toEqual([0x09]);
    expect(bytes(terminalKeyBytes('shift-tab'))).toEqual([0x1b, 0x5b, 0x5a]);
    expect(bytes(terminalKeyBytes('ctrl-q'))).toEqual([0x11]); // XON
  });

  it('keeps the Ctrl page in QWERTY order and maps A-Z plus backslash', () => {
    expect(HOTKEY_CTRL_PAGE_ROWS.map((row) => row.map(({ label }) => label))).toEqual([
      ['^Q', '^W', '^E', '^R', '^T'],
      ['^Y', '^U', '^I', '^O', '^P'],
      ['^A', '^S', '^D', '^F', '^G'],
      ['^H', '^J', '^K', '^L'],
      ['^Z', '^X', '^C', '^V', '^B'],
      ['^N', '^M', '^\\'],
    ]);

    const letters = [
      'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
      'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
    ] as const satisfies readonly ControlLetter[];
    letters.forEach((letter, index) => {
      expect(bytes(terminalKeyBytes(`ctrl-${letter}`))).toEqual([index + 1]);
    });
    expect(bytes(terminalKeyBytes('ctrl-backslash'))).toEqual([0x1c]);
  });
});

describe('held Ctrl+C and Ctrl+D gestures', () => {
  it('sends one byte for a tap and no bytes when a gesture is cancelled', () => {
    expect(bytes(terminalControlKeyGestureBytes('ctrl-c', 'tap'))).toEqual([0x03]);
    expect(bytes(terminalControlKeyGestureBytes('ctrl-d', 'tap'))).toEqual([0x04]);
    expect(terminalControlKeyGestureBytes('ctrl-c', 'cancel')).toBeNull();
    expect(terminalControlKeyGestureBytes('ctrl-d', 'cancel')).toBeNull();
  });

  it('resolves a hold to one atomic doubled write without a tap byte', () => {
    const writes = [terminalControlKeyGestureBytes('ctrl-c', 'hold')];
    expect(writes).toHaveLength(1);
    expect(bytes(writes[0]!)).toEqual([0x03, 0x03]);
    expect(bytes(terminalControlKeyGestureBytes('ctrl-d', 'hold'))).toEqual([0x04, 0x04]);
  });
});
