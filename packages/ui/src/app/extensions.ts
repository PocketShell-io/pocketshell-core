/**
 * The UI extension points: where platform-only code plugs into the shared app.
 *
 * The shared app (this directory) holds everything every client does the same
 * way. A client's own behaviour is contributed into named slots at startup,
 * next to `provideApi()`:
 *
 *   provideExtensions({ 'terminal.inputAdapter': [androidImeAdapter] });
 *
 * A slot nobody contributed to does nothing, so a client that contributes
 * nothing gets exactly the app it had before this file existed. Nothing in
 * here, or in the views that read it, may branch on which platform is running;
 * a platform is visible only through what it contributed.
 *
 * This is the `terminal.inputAdapter` slot only, with the same names and shapes
 * as the full registry (#2949 — dock, composer sources, settings sections,
 * dismiss layers), so that registry can take this file over unchanged:
 *
 *   terminal.inputAdapter  a filter attached to each terminal's input element
 *                          (IME/composition, paste policy)
 */
import { shallowRef } from 'vue';

/** What a terminal input adapter is attached to. */
export interface TerminalInputTarget {
  /** xterm's hidden helper textarea: where keys, IME composition and paste arrive. */
  textarea: HTMLTextAreaElement;
  /**
   * The terminal's container element, an ancestor of {@link textarea}. A
   * capture-phase listener here runs before xterm's own textarea listeners,
   * so an adapter can take an event over before xterm acts on it.
   */
  element: HTMLElement;
  /** The pane's current session identity key ('' for a bare shell); read it when needed, it follows re-points. */
  sessionKey: string;
  /** Send bytes to this pane's shell, as if typed. */
  sendInput(data: string): void;
}

export interface TerminalInputAdapter {
  id: string;
  /** Called once per terminal after it opens; the returned function detaches. */
  attach(target: TerminalInputTarget): (() => void) | void;
  order?: number;
}

export interface ExtensionSlots {
  'terminal.inputAdapter': TerminalInputAdapter;
}

export type ExtensionSlotName = keyof ExtensionSlots;

export type AppExtensions = { [K in ExtensionSlotName]?: readonly ExtensionSlots[K][] };

export const EXTENSION_SLOTS: readonly ExtensionSlotName[] = ['terminal.inputAdapter'];

const EMPTY: readonly never[] = Object.freeze([]);

function normalise<T extends { id: string; order?: number }>(slot: string, entries: readonly T[]): readonly T[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.id) throw new Error(`extension in ${slot} has no id`);
    if (seen.has(entry.id)) throw new Error(`duplicate extension id "${entry.id}" in ${slot}`);
    seen.add(entry.id);
  }
  // A stable sort: ordered entries first by `order`, then the rest as given.
  return Object.freeze(
    entries
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => {
        const ao = a.entry.order ?? Number.POSITIVE_INFINITY;
        const bo = b.entry.order ?? Number.POSITIVE_INFINITY;
        return ao === bo ? a.index - b.index : ao - bo;
      })
      .map(({ entry }) => entry),
  );
}

const registry = shallowRef<AppExtensions>({});

/**
 * Install the platform's contributions. Replaces any earlier call wholesale,
 * like `provideApi()`: one platform, one set. An unknown slot name or a
 * duplicate id throws, so a typo cannot silently drop a feature.
 */
export function provideExtensions(extensions: AppExtensions): void {
  const next: AppExtensions = {};
  for (const slot of Object.keys(extensions) as ExtensionSlotName[]) {
    if (!EXTENSION_SLOTS.includes(slot)) throw new Error(`unknown extension slot: ${String(slot)}`);
    const entries = extensions[slot] as readonly { id: string; order?: number }[] | undefined;
    if (entries === undefined) continue;
    (next as Record<string, unknown>)[slot] = normalise(slot, entries);
  }
  registry.value = next;
}

/** The contributions for a slot, in order. */
export function extensionsFor<K extends ExtensionSlotName>(slot: K): readonly ExtensionSlots[K][] {
  return (registry.value[slot] as readonly ExtensionSlots[K][] | undefined) ?? EMPTY;
}
