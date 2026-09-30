/**
 * The context a `terminal.dock` contribution (extensions.ts) receives: the
 * workspace's active session pane and a way to type into it. Null while no
 * session pane is showing — a Files tab, or no session yet — which is also
 * when the dock is not rendered.
 */
import type { TerminalDockContext } from './extensions';

export interface DockInputPane {
  sendInput: (data: string) => void;
}

export function dockContextFor(
  sessionTabActive: boolean,
  identity: string | null,
  sessionName: string | null,
  panes: ReadonlyMap<string, DockInputPane>,
): TerminalDockContext | null {
  if (!sessionTabActive || !identity || !sessionName) return null;
  return {
    sessionKey: identity,
    sessionName,
    // Looked up at send time: the pane may re-key on rename or mount late.
    sendInput: (data: string) => panes.get(identity)?.sendInput(data),
  };
}
