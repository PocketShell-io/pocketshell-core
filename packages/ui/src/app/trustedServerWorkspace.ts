import type { SessionSummary, StartSessionResult, SessionsListResult } from '@pocketshell/core';
import { normaliseRootPath, isWindowsDrivePath } from '@pocketshell/core';

/** Onboarding orchestration only; the connection controller remains sole owner
 * of SSH/reconnect. Every effect is bracketed by current-account/connection checks. */
export async function openTrustedServerWorkspace(deps: {
  current(): Promise<boolean>;
  lastFolder: string | null;
  list(): Promise<SessionsListResult>;
  home(): Promise<string>;
  start(folder: string): Promise<StartSessionResult>;
  pending(result: StartSessionResult, folder: string): void;
}): Promise<{ folder: string; session?: string }> {
  const guard = async () => {if (!await deps.current()) throw new Error('The active account or server changed. Connect again.');};
  await guard();
  const listing = await deps.list();
  await guard();
  if (listing.errors.length) throw new Error('Could not verify existing sessions. Refresh and connect again.');
  // SessionsListResult contains only live workers; aplexerPhase is display
  // metadata, explicitly not a separate client-side liveness signal.
  const live = listing.sessions;
  const folderOf = (s: SessionSummary) => normaliseRootPath(s.workspace || s.path);
  if (deps.lastFolder && live.some(s => folderOf(s) === deps.lastFolder)) return {folder:deps.lastFolder};
  const home = normaliseRootPath(await deps.home());
  await guard();
  if (!home || (!home.startsWith('/') && !isWindowsDrivePath(home))) throw new Error('Could not resolve your home folder.');
  const existing = live.find(s => folderOf(s) === home && !s.agentKind);
  if (existing) return {folder:home,session:existing.name};
  const result = await deps.start(home);
  await guard();
  if (!result.ok || !result.sessionName || !result.folder) throw new Error(result.error || 'Could not open your shell. Connect again to retry.');
  const folder = normaliseRootPath(result.folder);
  if (!folder) throw new Error('The server returned an invalid shell folder.');
  deps.pending(result,folder);
  return {folder,session:result.sessionName};
}
