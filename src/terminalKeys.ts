/**
 * Shared key catalog and terminal byte policy for the fast access bar and
 * hotkeys palette. This module is deliberately platform independent: clients
 * render the catalog and pass the returned bytes to their active PTY.
 */

export type ControlLetter =
  | 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm'
  | 'n' | 'o' | 'p' | 'q' | 'r' | 's' | 't' | 'u' | 'v' | 'w' | 'x' | 'y' | 'z';

export type TerminalKeyId =
  | 'arrow-up' | 'arrow-down' | 'enter' | 'arrow-left' | 'arrow-right'
  | 'escape' | 'tab' | 'shift-tab' | `ctrl-${ControlLetter}` | 'ctrl-backslash';

export type HoldableControlKey = 'ctrl-c' | 'ctrl-d';
export type ControlKeyGesture = 'tap' | 'hold' | 'cancel';

export interface TerminalHotkey {
  readonly id: TerminalKeyId;
  readonly label: string;
}

function hotkey<Id extends TerminalKeyId>(id: Id, label: string): TerminalHotkey & { readonly id: Id } {
  return Object.freeze({ id, label });
}

/** The three one-tap keys used for navigating menus and prompts on mobile. */
export const SESSION_BAR_NAV_KEYS = Object.freeze([
  hotkey('arrow-up', '↑'),
  hotkey('arrow-down', '↓'),
  hotkey('enter', 'Enter'),
] as const);

/** Main palette page; Up, Down and Enter remain on the persistent bar. */
export const HOTKEY_PALETTE_MAIN_SECTIONS = Object.freeze([
  Object.freeze({
    title: 'ARROWS',
    keys: Object.freeze([hotkey('arrow-left', '←'), hotkey('arrow-right', '→')]),
  }),
  Object.freeze({
    title: 'KEYS',
    keys: Object.freeze([hotkey('escape', 'Esc'), hotkey('tab', 'Tab'), hotkey('shift-tab', '⇧Tab')]),
  }),
  Object.freeze({
    title: 'CTRL',
    keys: Object.freeze([hotkey('ctrl-b', '^B'), hotkey('ctrl-c', '^C'), hotkey('ctrl-d', '^D'),
      hotkey('ctrl-q', '^Q'), hotkey('ctrl-x', '^X')]),
  }),
] as const);

function controlHotkey(letter: string): TerminalHotkey {
  const lower = letter.toLowerCase() as ControlLetter;
  return hotkey(`ctrl-${lower}`, `^${letter.toUpperCase()}`);
}

/** QWERTY Ctrl page rows, including the dedicated Ctrl+backslash key. */
export const HOTKEY_CTRL_PAGE_ROWS = Object.freeze([
  Object.freeze([...`QWERT`].map(controlHotkey)),
  Object.freeze([...`YUIOP`].map(controlHotkey)),
  Object.freeze([...`ASDFG`].map(controlHotkey)),
  Object.freeze([...`HJKL`].map(controlHotkey)),
  Object.freeze([...`ZXCVB`].map(controlHotkey)),
  Object.freeze([...`NM`].map(controlHotkey).concat(hotkey('ctrl-backslash', '^\\'))),
] as const);

const NAMED_KEY_BYTES: Partial<Record<TerminalKeyId, readonly number[]>> = Object.freeze({
  'arrow-up': [0x1b, 0x5b, 0x41],
  'arrow-down': [0x1b, 0x5b, 0x42],
  enter: [0x0d],
  'arrow-left': [0x1b, 0x5b, 0x44],
  'arrow-right': [0x1b, 0x5b, 0x43],
  escape: [0x1b],
  tab: [0x09],
  'shift-tab': [0x1b, 0x5b, 0x5a],
});

/**
 * Return a fresh byte array for one catalog key. Enter is carriage return
 * (0x0d); line feed (0x0a) is a separate byte and is never substituted here.
 */
export function terminalKeyBytes(key: TerminalKeyId): Uint8Array {
  const named = NAMED_KEY_BYTES[key];
  if (named != null) return Uint8Array.from(named);
  if (key === 'ctrl-backslash') return Uint8Array.of(0x1c);

  const match = /^ctrl-([a-z])$/.exec(key);
  if (match != null) return Uint8Array.of(match[1]!.charCodeAt(0) - 0x60);

  // TerminalKeyId makes this unreachable for typed callers; retain a clear
  // failure if untyped JavaScript passes a value outside the shared catalog.
  throw new RangeError(`Unknown terminal key: ${String(key)}`);
}

/**
 * Resolve exactly one press outcome for Ctrl+C or Ctrl+D.
 *
 * Call once when the pointer gesture resolves: `tap` returns one byte, `hold`
 * returns the atomic two-byte sequence, and `cancel` returns null. In
 * particular, a hold must not first dispatch the tap result and then dispatch
 * the doubled result.
 */
export function terminalControlKeyGestureBytes(
  key: HoldableControlKey,
  gesture: ControlKeyGesture,
): Uint8Array | null {
  if (gesture === 'cancel') return null;
  const single = terminalKeyBytes(key);
  if (gesture === 'tap') return single;
  return Uint8Array.of(single[0]!, single[0]!);
}
