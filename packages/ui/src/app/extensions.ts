/**
 * The UI extension points: where platform-only code plugs into the shared app.
 *
 * The shared app (this directory) holds everything every client does the same
 * way. A client's own features — a phone's fast-keys dock and dictation, the
 * desktop's zoom settings, the web's account settings — are contributed into
 * named slots at startup, next to `provideApi()`:
 *
 *   provideExtensions({ 'terminal.dock': [{ id: 'fast-keys', component: FastKeysDock }] });
 *
 * The shared views render whatever a slot holds and render NOTHING when it is
 * empty — no wrapper, no spacing — so a client that contributes nothing gets
 * exactly the app it had before this file existed. Nothing in here, or in the
 * views that read it, may branch on which platform is running; a platform is
 * visible only through what it contributed.
 *
 * The slots:
 *   terminal.dock          a component under the active terminal
 *   terminal.inputAdapter  a filter attached to each terminal's input element
 *                          (IME/composition, paste policy)
 *   composer.inputSources  components that insert text or files into the
 *                          prompt composer (a picker, dictation, a share inbox)
 *   composer.accessory     a chip row above the composer's draft
 *   settings.sections      extra sections at the end of Settings
 *   app.dismissLayers      runtime, not contributed: open overlays register a
 *                          close handler, and the platform's dismiss gesture
 *                          (Esc, Android Back) closes the topmost one
 */
import { markRaw, onBeforeUnmount, onMounted, shallowRef, type Component } from 'vue';

/** A contributed component, rendered with the slot's context as `context`. */
export interface ComponentContribution {
  /** Unique within its slot; also the Vue key. */
  id: string;
  component: Component;
  /** Ascending render order; contributions without one keep their given order, after ordered ones. */
  order?: number;
}

/**
 * A section appended to Settings, under its own group heading, after the
 * shared groups. Rendered with no props: it reads and writes its own platform
 * store. Its id is kebab-case, because it is also the group's DOM id
 * (`settings-section-<id>`).
 */
export interface SettingsSectionContribution extends ComponentContribution {
  title: string;
}

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

/** The context a `terminal.dock` component receives. */
export interface TerminalDockContext {
  /** The active pane's session identity key. */
  sessionKey: string;
  /** The session's display name. */
  sessionName: string;
  /** Send bytes to the active pane's shell, as if typed. */
  sendInput(data: string): void;
}

/** The context `composer.inputSources` and `composer.accessory` components receive. */
export interface ComposerExtensionContext {
  /** The session the composer drafts for. */
  sessionName: string;
  /** Insert text into the draft at the caret, opening the composer if closed. */
  insertText(text: string): void;
  /** Stage files as attachments, the same path as a drop. */
  attachFiles(files: File[]): void;
}

export interface ExtensionSlots {
  'terminal.dock': ComponentContribution;
  'terminal.inputAdapter': TerminalInputAdapter;
  'composer.inputSources': ComponentContribution;
  'composer.accessory': ComponentContribution;
  'settings.sections': SettingsSectionContribution;
}

export type ExtensionSlotName = keyof ExtensionSlots;

/** The component-rendering slots `<ExtensionSlot>` can show. */
export type ComponentSlotName = 'terminal.dock' | 'composer.inputSources' | 'composer.accessory';

export type AppExtensions = { [K in ExtensionSlotName]?: readonly ExtensionSlots[K][] };

export const EXTENSION_SLOTS: readonly ExtensionSlotName[] = [
  'terminal.dock',
  'terminal.inputAdapter',
  'composer.inputSources',
  'composer.accessory',
  'settings.sections',
];

const EMPTY: readonly never[] = Object.freeze([]);

function normalise<T extends { id: string; order?: number }>(slot: string, entries: readonly T[]): readonly T[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.id) throw new Error(`extension in ${slot} has no id`);
    if (seen.has(entry.id)) throw new Error(`duplicate extension id "${entry.id}" in ${slot}`);
    if (slot === 'settings.sections' && !/^[a-z0-9-]+$/.test(entry.id)) {
      throw new Error(`settings section id must be kebab-case: ${entry.id}`);
    }
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
      // A component is a definition, never state: keep Vue from proxying it.
      .map(({ entry }) =>
        'component' in entry ? { ...entry, component: markRaw((entry as { component: Component }).component) } : entry,
      ),
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

/**
 * The contributions for a slot, in render order. Reactive: a component that
 * reads this during render re-renders when `provideExtensions` runs again.
 */
export function extensionsFor<K extends ExtensionSlotName>(slot: K): readonly ExtensionSlots[K][] {
  return (registry.value[slot] as readonly ExtensionSlots[K][] | undefined) ?? EMPTY;
}

// ---- app.dismissLayers -------------------------------------------------------

export interface DismissLayer {
  close(): void;
}

const layers: DismissLayer[] = [];

/**
 * Register an open layer's close handler. The most recently registered layer
 * is the topmost. Returns the unregister function; calling it twice is safe.
 */
export function registerDismissLayer(close: () => void): () => void {
  const layer: DismissLayer = { close };
  layers.push(layer);
  return () => {
    const at = layers.lastIndexOf(layer);
    if (at !== -1) layers.splice(at, 1);
  };
}

/**
 * Close the topmost open layer. Returns false when none is open, so the
 * platform's gesture can fall through to its own meaning (Android Back
 * navigates; Esc does nothing).
 */
export function dismissTopLayer(): boolean {
  const top = layers[layers.length - 1];
  if (top === undefined) return false;
  top.close();
  return true;
}

/** How many layers are open. */
export function openDismissLayerCount(): number {
  return layers.length;
}

/** Register `close` for as long as the calling component is mounted. */
export function useDismissLayer(close: () => void): void {
  let unregister: (() => void) | null = null;
  onMounted(() => {
    unregister = registerDismissLayer(close);
  });
  onBeforeUnmount(() => {
    unregister?.();
    unregister = null;
  });
}
