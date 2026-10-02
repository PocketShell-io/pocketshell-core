import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@ui/app/ipc';
import { TerminalPane } from '@ui/app/terminalPane';
import type { ConnectionId, ShellId } from '@pocketshell/core';

vi.mock('@ui/app/ipc', () => ({
  api: {
    shell: {
      close: vi.fn(),
      onData: vi.fn(() => () => {}),
      onExited: vi.fn(() => () => {}),
      redraw: vi.fn(),
      windowSize: vi.fn(),
    },
  },
}));

/**
 * An aplexer pane's shell is a client (`a attach`), not the session: when it
 * exits on its own, the session underneath is usually perfectly fine — the
 * recurring "[process exited]" on healthy sessions (diagnosed 2026-10-02) was
 * the client dropping while the workload carried on. The pane now treats that
 * exit like a dead tmux client: a bounded, SILENT re-join, falling back to the
 * ordinary "[process exited]" only when the fresh attach finds nothing —
 * which is the session the user stopped on purpose, whose exit event can
 * reach the still-mounted pane before the store row leaves.
 *
 * These specs pin the contract: silent success, honest failure, legacy
 * behavior for non-aplexer panes, and the per-episode budget (a shell that
 * lived longer than REJOIN_MIN_INTERVAL_MS starts a fresh one, because an
 * aplexer pane's probe answers 'bare' and never clears the streak the way a
 * tmux probe does).
 */

const EXITED = '\r\n\x1b[90m[process exited]\x1b[0m\r\n';
const REATTACHED =
  '\r\n\x1b[90m[PocketShell] client dropped — reattached to the live session\x1b[0m\r\n';

type PaneInternals = {
  term: object | null;
  shellId: ShellId | null;
  shellGone: boolean;
  shellAttachedAt: number | null;
  rejoinStreak: number;
  open: (quietFailure?: boolean) => Promise<void>;
  rejoinAfterClientExit: (id: ShellId) => void;
  bindShellStream: () => void;
  paneWrite: (data: string) => void;
};

function makePane(backend: 'aplexer' | 'tmux' | undefined) {
  const pane = new TerminalPane({
    shells: { register: vi.fn(), unregister: vi.fn() },
    getConnectionId: () => 'conn-1' as ConnectionId,
    getCommand: () => undefined,
    getTargetSession: () => (backend === 'aplexer' ? 'aplexer-session' : ''),
    getRegistryKey: () => 'ws::tag',
    getBackend: () => backend,
    getWorkspace: () => (backend === 'aplexer' ? '/home/x/repo' : null),
    getAplexerId: () => null,
    isVisible: () => true,
    mayRestoreFocus: () => false,
  });
  const writes: string[] = [];
  const internals = pane as unknown as PaneInternals;
  internals.paneWrite = (data: string) => {
    writes.push(data);
  };
  // These paths only test truthiness of the terminal; the stub keeps the
  // specs free of xterm.
  internals.term = {};
  return { pane, internals, writes };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.mocked(api.shell.close).mockReset().mockResolvedValue(undefined);
  vi.mocked(api.shell.onExited).mockClear();
});

describe('the aplexer client-exit re-join', () => {
  it('re-joins silently when the session survived the client', async () => {
    const { pane, internals, writes } = makePane('aplexer');
    internals.shellId = 'shell-1' as ShellId;
    internals.shellAttachedAt = Date.now();
    internals.open = vi.fn(async () => {
      internals.shellId = 'shell-2' as ShellId;
    });
    internals.rejoinAfterClientExit('shell-1' as ShellId);
    await settle();
    expect(api.shell.close).toHaveBeenCalledWith('shell-1');
    expect(internals.open).toHaveBeenCalledWith(true);
    expect(writes).toEqual([REATTACHED]);
    expect(internals.shellGone).toBe(false);
    expect(internals.shellAttachedAt).not.toBeNull();
  });

  it('prints the ordinary [process exited] when nothing is left to attach to', async () => {
    const { pane, internals, writes } = makePane('aplexer');
    internals.shellId = 'shell-1' as ShellId;
    internals.shellAttachedAt = Date.now();
    internals.open = vi.fn(async () => {
      internals.shellId = null; // quiet failure: the stopped-session case
    });
    internals.bindShellStream();
    const handler = vi.mocked(api.shell.onExited).mock.calls.at(-1)![0];
    handler({ shellId: 'shell-1' as ShellId, exitCode: 0 });
    await settle();
    expect(writes).toEqual([EXITED]);
    // The handler marked the shell gone on entry and the failed re-join left
    // it so — the hidden→visible edge can still retry when the user returns.
    expect(internals.shellGone).toBe(true);
  });

  it('routes bare and tmux panes straight to the plain exit line', async () => {
    for (const backend of ['tmux', undefined] as const) {
      const { pane, internals, writes } = makePane(backend);
      internals.shellId = 'shell-1' as ShellId;
      internals.bindShellStream();
      const handler = vi.mocked(api.shell.onExited).mock.calls.at(-1)![0];
      handler({ shellId: 'shell-1' as ShellId, exitCode: 0 });
      expect(writes).toEqual([EXITED]);
      expect(api.shell.close).not.toHaveBeenCalled();
    }
  });

  it('spends the budget on an unstable session, then says exited without joining', async () => {
    const { pane, internals, writes } = makePane('aplexer');
    internals.open = vi.fn(async () => {
      internals.shellId = null; // every fresh attach finds a stopped session
    });
    for (let i = 0; i < 3; i++) {
      internals.shellId = ('shell-' + i) as ShellId;
      internals.shellGone = true;
      internals.shellAttachedAt = Date.now(); // died young: no stability reset
      internals.rejoinAfterClientExit(('shell-' + i) as ShellId);
      await settle();
    }
    expect(api.shell.close).toHaveBeenCalledTimes(3);
    internals.shellId = 'shell-3' as ShellId;
    internals.rejoinAfterClientExit('shell-3' as ShellId);
    await settle();
    expect(writes.filter((w) => w === EXITED)).toHaveLength(4);
    expect(api.shell.close).toHaveBeenCalledTimes(3);
  });

  it('starts a fresh budget once a shell has lived a stable interval', async () => {
    const { pane, internals, writes } = makePane('aplexer');
    internals.open = vi.fn(async () => {
      internals.shellId = null;
    });
    internals.rejoinStreak = 3; // previous episode spent it
    internals.shellId = 'shell-9' as ShellId;
    internals.shellGone = true;
    internals.shellAttachedAt = Date.now() - 61_000; // stable life since
    internals.rejoinAfterClientExit('shell-9' as ShellId);
    await settle();
    expect(api.shell.close).toHaveBeenCalledTimes(1); // the re-join ran
    expect(writes).toEqual([EXITED]); // and failed into the ordinary line
  });
});
