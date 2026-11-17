import type { SessionSummary } from './types';

/**
 * Renderer-side identity for a session row.
 *
 * tmux names are host-global, so the bare name IS the identity — and keeping
 * it bare keeps every persisted key (`conn/name` composer drafts in
 * localStorage) stable. aplexer tags repeat across workspaces, so an aplexer
 * row addresses as `aplexer:<aplexerId>` (immutable, #3146), or — with no id
 * yet — `aplexer:<workspace>:<tag>`: two folders holding same-named tags get
 * two composer drafts and two shells entries instead of one aliasing the other.
 *
 * An aplexer row WITHOUT a workspace (a stale row, a caller that only has a
 * name) falls back to the bare name — the same answer the tmux case gives.
 * That fallback is deliberate: an identity function must never refuse, and a
 * merged draft beats a dropped write. Callers that need strictness (kill,
 * rename) do their own snapshot resolution main-side instead.
 */
export function sessionIdentityKey(
  name: string,
  opts?: {
    backend?: SessionSummary['backend'];
    workspace?: string | null;
    aplexerId?: string | null;
  },
): string {
  // The UUID is immutable; an aplexer session's workspace is NOT — it follows
  // the shell's cwd, so a `cd` re-keyed the pane, draft and tab and remounted
  // the terminal (#3146). Workspace+tag is only the fallback for a row with no
  // id yet (an optimistic pending create).
  if (opts?.backend === 'aplexer' && opts.aplexerId) {
    return `aplexer:${opts.aplexerId}`;
  }
  if (opts?.backend === 'aplexer' && opts.workspace) {
    return `aplexer:${opts.workspace}:${name}`;
  }
  return name;
}
