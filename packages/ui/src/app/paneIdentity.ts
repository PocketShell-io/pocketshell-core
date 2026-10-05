/**
 * The two identities one terminal pane answers to, extracted from
 * TerminalView.vue so the bare-pane rules are stated next to the session ones
 * they modify — and are unit-testable without a mount.
 *
 * A pane is SESSION-shaped unless `bare` is set: its `sessionKey` then names
 * the session to show (`sessionName` overrides it for callers whose key is a
 * workspace-qualified identity rather than a session name). A BARE pane has
 * no session behind it — the maintenance workspace's `htop` pane is the user
 * (see maintenance.ts) — so its key is only its registry identity, and the ''
 * `targetSession` is what keeps `requestShell` on the plain-shell branch
 * instead of asking main to join a session that does not exist.
 */
import { computed, type ComputedRef } from 'vue';
import { sessionIdentityKey } from './sessionIdentity';

/** The props the identities read, as TerminalView receives them. */
export interface PaneIdentityProps {
  /** See TerminalView's `bare` — set only for a pane that runs a command of its own. */
  bare?: boolean;
  /** A key that, when changed, re-points the pane (used to switch sessions). */
  sessionKey?: string;
  /** The tmux session to display. Falls back to {@link PaneIdentityProps.sessionKey}. */
  sessionName?: string;
  /** Which runtime owns the session. Absent means tmux. */
  backend?: 'tmux' | 'aplexer';
  /** Aplexer workspace, carried so same-named tags cannot share a registration. */
  workspace?: string | null;
}

export function usePaneIdentity(props: PaneIdentityProps): {
  targetSession: ComputedRef<string>;
  registryKey: ComputedRef<string>;
} {
  /** The tmux session this pane should be showing, or '' for a bare shell. */
  const targetSession = computed(() =>
    props.bare ? '' : (props.sessionName ?? props.sessionKey ?? ''),
  );

  /**
   * The shells-registry key for this pane.
   *
   * Same workspace rule as the join: a bare tag repeats across workspaces, so
   * the registration carries the workspace for aplexer panes and two folders
   * holding same-named tags resolve to their own PTYs. tmux names are
   * host-global and stay bare; a BARE pane registers under its [sessionKey] —
   * it has no session name to derive one from, and keying on `targetSession`'s
   * '' would point every bare pane in the app at one registry slot. See
   * `renderer/sessionIdentity.ts`.
   */
  const registryKey = computed(() =>
    sessionIdentityKey(props.bare ? (props.sessionKey ?? '') : targetSession.value, {
      backend: props.backend,
      workspace: props.workspace ?? undefined,
    }),
  );

  return { targetSession, registryKey };
}
