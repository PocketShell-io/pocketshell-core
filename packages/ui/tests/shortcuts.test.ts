import { describe, expect, it } from 'vitest';
import {
  chordFromEvent,
  chordMatches,
  defaultBindings,
  isShortcut,
  parseChord,
} from '@pocketshell/core/shared/shortcuts';

/**
 * Chromium's ghost keydown: a `<datalist>` popup committing or closing
 * dispatches a keydown whose `key` is undefined — not a KeyboardEvent field at
 * all. One reached the app's window-capture chord matching on 2026-11-24 (see
 * `chordFromEvent` for the incident), so the event→chord boundary has to fold
 * it into a chord that matches nothing rather than throw out of every matcher
 * in the app.
 */
const ghost = { ctrlKey: true } as unknown as KeyboardEvent;

describe('chord matching against a keyless ghost keydown', () => {
  it('reads the event into a chord with an empty key', () => {
    expect(chordFromEvent(ghost)).toEqual({ ctrl: true, alt: false, shift: false, key: '' });
  });

  it('fires no shortcut — the incident path stops matching instead of throwing', () => {
    expect(isShortcut(defaultBindings(), 'text.deleteWordBackward', ghost)).toBe(false);
  });

  it('is nobody\'s chord: neither side of a match can hold the empty key', () => {
    // `parseChord` rejects the spelling that would produce one, so a stored
    // binding never carries it and the ghost chord can only ever compare false.
    expect(parseChord('Ctrl+')).toBeNull();
    expect(chordMatches(chordFromEvent(ghost), { key: 'w', ctrlKey: true })).toBe(false);
    expect(chordMatches({ ctrl: true, alt: false, shift: false, key: 'W' }, ghost)).toBe(false);
  });

  it('leaves real events matching exactly as before', () => {
    expect(isShortcut(defaultBindings(), 'text.deleteWordBackward', { key: 'w', ctrlKey: true })).toBe(true);
    expect(isShortcut(defaultBindings(), 'text.deleteWordBackward', { key: 'W', ctrlKey: true })).toBe(true);
  });
});
