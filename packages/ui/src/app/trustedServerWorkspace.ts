import type { SessionSummary, StartSessionResult, SessionsListResult } from '@pocketshell/core';
import { normaliseRootPath, isWindowsDrivePath, directoryKey } from '@pocketshell/core';

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
  const home = normaliseRootPath(await deps.home());
  await guard();
  if (!home || (!home.startsWith('/') && !isWindowsDrivePath(home))) throw new Error('Could not resolve your home folder.');
  // Router folders are grouping keys, not absolute SFTP paths. Use the same
  // conversion as the session panel and FolderWorkspaceView, including for
  // persisted absolute paths written by the previous onboarding handoff.
  const remembered = normaliseRootPath(deps.lastFolder);
  const rememberedKey = remembered ? directoryKey(remembered,home) : null;
  const restored = rememberedKey ? live.filter(s => {
    const path = folderOf(s);
    return path !== null && directoryKey(path,home) === rememberedKey;
  }) : [];
  if (rememberedKey && restored.length) {
    return {folder:rememberedKey};
  }
  const existing = live.find(s => folderOf(s) === home && !s.agentKind);
  if (existing) return {folder:directoryKey(home,home),session:existing.name};
  const result = await deps.start(home);
  await guard();
  if (!result.ok || !result.sessionName || !result.folder) throw new Error(result.error || 'Could not open your shell. Connect again to retry.');
  const folder = normaliseRootPath(result.folder);
  if (!folder) throw new Error('The server returned an invalid shell folder.');
  deps.pending(result,folder);
  return {folder:directoryKey(folder,home),session:result.sessionName};
}
