import type { Terminal } from '@xterm/xterm';
import { extensionsFor } from './extensions';

interface InputOwnershipOptions {
  getPrefixOwner(): string | null;
  getContainer(): HTMLElement | null;
  getSessionKey(): string;
  routeKey(event: KeyboardEvent, prefixSuffix: boolean): boolean;
  cancelDetachCandidate(): void;
  expectIntentionalDetach(): void;
}

/** Pane-local keyboard ownership and platform adapters; never a remote ACK. */
export function createTerminalInputOwnership(options: InputOwnershipOptions) {
  let prefixOwner: string | null = null;
  let visibilityObserver: ResizeObserver | null = null;
  const prefixDetaches: Array<() => void> = [];
  let adapterDetaches: Array<() => void> = [];

  function clearPrefix(): void {
    prefixOwner = null;
    options.cancelDetachCandidate();
  }

  function observeVisibility(): void {
    if (visibilityObserver || typeof ResizeObserver === 'undefined') return;
    const container = options.getContainer();
    if (!container) return;
    visibilityObserver = new ResizeObserver(() => {
      if (!container.clientWidth || !container.clientHeight) clearPrefix();
    });
    visibilityObserver.observe(container);
    prefixDetaches.push(() => { visibilityObserver?.disconnect(); visibilityObserver = null; });
  }

  function onCustomKey(event: KeyboardEvent): boolean {
    if (event.type !== 'keydown') return true;
    if (event.isComposing) clearPrefix();
    const modifierOnly = ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(event.key);
    const owner = options.getPrefixOwner();
    const suffix = !modifierOnly && !event.isComposing && owner !== null && prefixOwner === owner;
    if (!modifierOnly) clearPrefix();
    const allowed = options.routeKey(event, suffix);
    if (allowed && suffix && event.key === 'd' && !event.ctrlKey && !event.altKey &&
      !event.metaKey && !event.shiftKey && !event.repeat) options.expectIntentionalDetach();
    if (!allowed) clearPrefix();
    else if (!modifierOnly && !suffix && !event.isComposing && !event.repeat &&
      event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'b' && owner !== null) {
      observeVisibility();
      prefixOwner = owner;
    }
    return allowed;
  }

  function attachPrefixResets(container: HTMLElement): void {
    const listen = (target: EventTarget, type: string, listener: EventListener): void => {
      target.addEventListener(type, listener, true);
      prefixDetaches.push(() => target.removeEventListener(type, listener, true));
    };
    listen(container, 'focusout', (event) => {
      const next = (event as FocusEvent).relatedTarget;
      if (!(next instanceof Node) || !container.contains(next)) clearPrefix();
    });
    for (const type of ['compositionstart', 'paste', 'drop']) listen(container, type, clearPrefix);
    listen(window, 'blur', clearPrefix);
    listen(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') clearPrefix();
    });
  }

  /** Adapter bytes use xterm input, retaining the pane's onData input fence. */
  function attachInputAdapters(terminal: Pick<Terminal, 'textarea' | 'input'>, element: HTMLElement): void {
    const textarea = terminal.textarea;
    if (!textarea) return;
    for (const adapter of extensionsFor('terminal.inputAdapter')) {
      const detach = adapter.attach({
        textarea,
        element,
        get sessionKey() { return options.getSessionKey(); },
        sendInput: (data) => { clearPrefix(); terminal.input(data, true); },
      });
      if (typeof detach === 'function') adapterDetaches.push(detach);
    }
  }

  return {
    clearPrefix,
    onCustomKey,
    attachPrefixResets,
    attachInputAdapters,
    disposePrefixResets(): void {
      for (const detach of prefixDetaches) detach();
      prefixDetaches.length = 0;
    },
    disposeInputAdapters(): void {
      for (const detach of adapterDetaches) detach();
      adapterDetaches = [];
    },
  };
}

/**
 * Re-attaching a PTY must not redirect a keystroke from another surface.
 *
 * A reconnect can finish after the prompt composer has taken focus, and the
 * old unconditional `term.focus()` then made the next character land in the
 * terminal. Only restore focus for a visible pane when it already owns focus,
 * or when the document has no meaningful focused control (the initial mount).
 */
export function mayRestoreTerminalFocus(container: HTMLElement | null): boolean {
  if (!container || container.clientWidth <= 0 || container.clientHeight <= 0) {
    return false;
  }
  const active = document.activeElement;
  if (active && container.contains(active)) return true;
  return active === null || active === document.body || active === document.documentElement;
}
