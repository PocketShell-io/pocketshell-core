import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@ui/app/ipc';
import { TerminalPane } from '@ui/app/terminalPane';
import type { ConnectionId, SessionSummary, ShellId } from '@pocketshell/core';

vi.mock('@ui/app/ipc', () => ({
  api: {
    shell: {
      close: vi.fn(),
      onData: vi.fn(() => () => {}),
      onExited: vi.fn(() => () => {}),
      redraw: vi.fn(),
      windowSize: vi.fn(),
    },
    helper: {
      sessionsList: vi.fn(),
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

const WORKSPACE = '/home/x/repo';
const SESSION_ID = 'uuid-aplexer-session';

/** The host's fresh listing, as the pane's verdict reads it. */
function listed(patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    name: 'aplexer-session',
    created: 1,
    activity: 1,
    attached: true,
    path: WORKSPACE,
    backend: 'aplexer',
    workspace: WORKSPACE,
    tag: 'aplexer-session',
    aplexerId: SESSION_ID,
    aplexerPhase: 'running',
    ...patch,
  };
}

function makePane(backend: 'aplexer' | 'tmux' | undefined) {
  const pane = new TerminalPane({
    shells: { register: vi.fn(), unregister: vi.fn() },
    getConnectionId: () => 'conn-1' as ConnectionId,
    getCommand: () => undefined,
    getTargetSession: () => (backend === 'aplexer' ? 'aplexer-session' : ''),
    getRegistryKey: () => 'ws::tag',
    getBackend: () => backend,
    getWorkspace: () => (backend === 'aplexer' ? WORKSPACE : null),
    getAplexerId: () => (backend === 'aplexer' ? SESSION_ID : null),
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
  // By default the host still runs the session: only the client dropped.
  vi.mocked(api.helper.sessionsList).mockReset().mockResolvedValue([listed()]);
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

/**
 * #3039: a REAL session end (killed, or its workload exited) reaches the pane
 * as the very same clean client exit as a dropped client. On 781c52d the pane
 * re-attached it anyway — the attach PTY of a dead session opened, got its
 * geometry pushed while its client was already exiting, and that channel
 * request raced the teardown into `server_input_channel_req: unknown channel
 * 0`, a dropped SSH connection and a full reconnect. The host's fresh listing
 * now decides, before anything is opened.
 */
describe('the client-exit verdict: a real session end never re-joins (#3039)', () => {
  const realEnds: Array<[string, () => void]> = [
    ['the host no longer lists the session (killed, record removed)', () => {
      vi.mocked(api.helper.sessionsList).mockResolvedValue([]);
    }],
    ['the host lists it as exiting (killed, record not yet removed)', () => {
      vi.mocked(api.helper.sessionsList).mockResolvedValue([listed({ aplexerPhase: 'exiting' })]);
    }],
    ['the host lists it as exited (its workload ended)', () => {
      vi.mocked(api.helper.sessionsList).mockResolvedValue([listed({ aplexerPhase: 'exited' })]);
    }],
    ['only a NEW session reuses the tag (another aplexer id)', () => {
      vi.mocked(api.helper.sessionsList).mockResolvedValue([listed({ aplexerId: 'uuid-someone-else' })]);
    }],
    ['the listing itself fails (no evidence the session lives)', () => {
      vi.mocked(api.helper.sessionsList).mockRejectedValue(new Error('exec failed'));
    }],
  ];

  for (const [label, arrange] of realEnds) {
    it(`prints [process exited] and attaches nothing when ${label}`, async () => {
      arrange();
      const { pane, internals, writes } = makePane('aplexer');
      internals.shellId = 'shell-1' as ShellId;
      internals.shellAttachedAt = Date.now();
      internals.open = vi.fn(async () => {
        internals.shellId = 'shell-2' as ShellId; // a dead session's attach still "opens"
      });
      // Through the real exit route the hub drives: retire → onExited.
      internals.bindShellStream();
      const handler = vi.mocked(api.shell.onExited).mock.calls.at(-1)![0];
      handler({ shellId: 'shell-1' as ShellId, exitCode: 0 });
      await settle();
      await settle();
      // Load-bearing first: nothing is opened against the dead session.
      expect(internals.open).not.toHaveBeenCalled();
      expect(api.shell.close).not.toHaveBeenCalled();
      expect(writes).toEqual([EXITED]);
      expect(api.helper.sessionsList).toHaveBeenCalledWith('conn-1');
      expect(internals.shellGone).toBe(true);
      expect(internals.rejoinStreak).toBe(0);
    });
  }

  it('asks the host BEFORE closing or opening anything on a client drop', async () => {
    const order: string[] = [];
    vi.mocked(api.helper.sessionsList).mockImplementation(async () => {
      order.push('list');
      return [listed()];
    });
    vi.mocked(api.shell.close).mockImplementation(async () => {
      order.push('close');
      return true;
    });
    const { pane, internals, writes } = makePane('aplexer');
    internals.shellId = 'shell-1' as ShellId;
    internals.shellAttachedAt = Date.now();
    internals.open = vi.fn(async () => {
      order.push('open');
      internals.shellId = 'shell-2' as ShellId;
    });
    internals.bindShellStream();
    const handler = vi.mocked(api.shell.onExited).mock.calls.at(-1)![0];
    handler({ shellId: 'shell-1' as ShellId, exitCode: 0 });
    await settle();
    await settle();
    expect(order).toEqual(['list', 'close', 'open']);
    expect(writes).toEqual([REATTACHED]);
    expect(internals.shellGone).toBe(false);
    expect(internals.rejoinStreak).toBe(1);
  });

  it('prefers the richer sessionsListing when the client offers it', async () => {
    const sessionsListing = vi.fn(async () => ({ sessions: [], errors: [] }));
    (api.helper as unknown as { sessionsListing?: typeof sessionsListing }).sessionsListing = sessionsListing;
    try {
      const { pane, internals, writes } = makePane('aplexer');
      internals.shellId = 'shell-1' as ShellId;
      internals.open = vi.fn(async () => undefined);
      internals.rejoinAfterClientExit('shell-1' as ShellId);
      await settle();
      await settle();
      expect(internals.open).not.toHaveBeenCalled();
      expect(writes).toEqual([EXITED]);
      expect(sessionsListing).toHaveBeenCalledWith('conn-1');
      expect(api.helper.sessionsList).not.toHaveBeenCalled();
    } finally {
      delete (api.helper as unknown as { sessionsListing?: unknown }).sessionsListing;
    }
  });

  it('drops a verdict that arrives after the pane moved on to another shell', async () => {
    let answer!: (rows: SessionSummary[]) => void;
    vi.mocked(api.helper.sessionsList).mockImplementation(
      () => new Promise<SessionSummary[]>((resolve) => { answer = resolve; }),
    );
    const { pane, internals, writes } = makePane('aplexer');
    internals.shellId = 'shell-1' as ShellId;
    internals.open = vi.fn(async () => undefined);
    internals.rejoinAfterClientExit('shell-1' as ShellId);
    internals.shellId = 'shell-7' as ShellId; // a user switch landed meanwhile
    answer([listed()]);
    await settle();
    await settle();
    expect(api.shell.close).not.toHaveBeenCalled();
    expect(internals.open).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
});
