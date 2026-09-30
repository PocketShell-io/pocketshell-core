import { describe, expect, it, vi } from 'vitest';
import type { HostCliExecOutcome } from '../src/hostCliCommon';
import {
  HostWorkspaceRoots,
  RestoredWorkspaceRootsLedger,
  WORKSPACE_ROOTS_RESTORED_STORAGE_KEY,
  WORKSPACE_ROOT_ORDER_STORAGE_KEY,
  WorkspaceRootOrderStore,
  execWithDeadline,
  workspaceRootsApiFromExec,
  workspaceRootsCliForConnection,
  type WorkspaceRootsCli,
  type WorkspaceStringStorage,
} from '../src/hostWorkspaceRoots';

/**
 * A fake host speaking the real `pocketshell workspaces` schema-1 contract,
 * partitioned by `--host` exactly as the host CLI's registry is. Commands are
 * parsed back out of what HostCliWorkspaces actually sends, so these tests pin
 * the command line as well as the policy.
 */
class FakeHost {
  readonly registry = new Map<string, string[]>();
  readonly commands: string[] = [];
  home = '/home/me';
  override: ((command: string) => HostCliExecOutcome | Promise<HostCliExecOutcome>) | null = null;

  exec = async (_connectionId: string, command: string): Promise<HostCliExecOutcome> => {
    this.commands.push(command);
    if (this.override) return this.override(command);
    const match = /^pocketshell workspaces (list|add|remove)(?: '([^']*)')? --host '([^']*)' --json$/.exec(command);
    if (!match) return { exitCode: 64, stdout: '', stderr: `unexpected command: ${command}` };
    const [, operation, rawPath, host] = match;
    const entries = [...(this.registry.get(host!) ?? [])];
    const canonical = rawPath?.startsWith('~/') ? `${this.home}/${rawPath.slice(2)}` : rawPath;
    if (operation === 'add' && canonical && !entries.includes(canonical)) entries.push(canonical);
    if (operation === 'remove' && canonical) entries.splice(entries.indexOf(canonical), entries.includes(canonical) ? 1 : 0);
    entries.sort();
    this.registry.set(host!, entries);
    const workspaces = entries.map((path) => ({
      path,
      display_path: path.startsWith(`${this.home}/`) ? `~/${path.slice(this.home.length + 1)}` : path,
    }));
    return { exitCode: 0, stdout: JSON.stringify({ schema: 1, host, workspaces }), stderr: '' };
  };

  cli(connectionId = 'conn-1'): WorkspaceRootsCli {
    return workspaceRootsCliForConnection(workspaceRootsApiFromExec(this.exec), connectionId);
  }
}

class MemoryStorage implements WorkspaceStringStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function model(storage = new MemoryStorage()) {
  return new HostWorkspaceRoots(new WorkspaceRootOrderStore(storage, () => 42), new RestoredWorkspaceRootsLedger(storage, () => 42));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('host workspace roots over the host CLI', () => {
  it('lists, adds and removes roots through the host CLI for the selected host only', async () => {
    const host = new FakeHost();
    host.registry.set('host-a', ['/home/me/git']);
    const roots = model();
    await roots.select({ hostIdentity: 'host-a', cli: host.cli() });
    expect(roots.getState()).toMatchObject({ status: 'ready', error: null, hostIdentity: 'host-a' });
    expect(roots.getState().memberships?.map((w) => w.path)).toEqual(['/home/me/git']);

    expect(await roots.addRoot('~/tmp')).toBe(true);
    expect(roots.getState().memberships?.map((w) => w.path)).toEqual(['/home/me/git', '/home/me/tmp']);
    expect(await roots.removeRoot('/home/me/git')).toBe(true);
    expect(roots.getState().memberships?.map((w) => w.path)).toEqual(['/home/me/tmp']);
    expect(roots.getState().notice).toContain('Its files and sessions were not touched');
    // Only registration commands ran: nothing deletes a folder or kills a session.
    expect(host.commands).toEqual([
      "pocketshell workspaces list --host 'host-a' --json",
      "pocketshell workspaces add '~/tmp' --host 'host-a' --json",
      "pocketshell workspaces remove '/home/me/git' --host 'host-a' --json",
    ]);
    expect(host.commands.some((command) => /\brm\b|sessions kill|rmdir/.test(command))).toBe(false);
  });

  it('refuses an invalid or duplicate root before it reaches the host', async () => {
    const host = new FakeHost();
    host.registry.set('host-a', ['/home/me/git']);
    const roots = model();
    await roots.select({ hostIdentity: 'host-a', cli: host.cli() });
    expect(await roots.addRoot('relative/path')).toBe(false);
    expect(roots.getState().mutationError).toContain('absolute path');
    expect(await roots.addRoot('~/git')).toBe(false);
    expect(roots.getState().mutationError).toBe('~/git is already a workspace root.');
    expect(host.commands).toHaveLength(1);
  });

  it('keeps same-path roots on two hosts in separate registrations and orders', async () => {
    const host = new FakeHost();
    host.registry.set('host-a', ['/home/me/git', '/home/me/tmp']);
    host.registry.set('host-b', ['/home/me/git', '/home/me/tmp']);
    const storage = new MemoryStorage();
    const roots = model(storage);
    await roots.select({ hostIdentity: 'host-a', cli: host.cli('conn-a') });
    expect(roots.moveRoot('/home/me/tmp', -1)).toBe(true);
    expect(roots.ordered().map((w) => w.path)).toEqual(['/home/me/tmp', '/home/me/git']);

    await roots.select({ hostIdentity: 'host-b', cli: host.cli('conn-b') });
    expect(roots.ordered().map((w) => w.path)).toEqual(['/home/me/git', '/home/me/tmp']);
    expect(await roots.removeRoot('/home/me/git')).toBe(true);
    expect(host.registry.get('host-a')).toEqual(['/home/me/git', '/home/me/tmp']);
    expect(host.registry.get('host-b')).toEqual(['/home/me/tmp']);

    // A process restart reads the same storage and restores each host's order.
    const restarted = model(storage);
    await restarted.select({ hostIdentity: 'host-a', cli: host.cli('conn-a2') });
    expect(restarted.ordered().map((w) => w.path)).toEqual(['/home/me/tmp', '/home/me/git']);
  });

  it('drops an answer that arrives after the host changed', async () => {
    const host = new FakeHost();
    host.registry.set('host-b', ['/srv/b']);
    const slow = deferred<HostCliExecOutcome>();
    const staleCli: WorkspaceRootsCli = workspaceRootsCliForConnection(
      workspaceRootsApiFromExec(() => slow.promise),
      'conn-a',
    );
    const roots = model();
    const first = roots.select({ hostIdentity: 'host-a', cli: staleCli });
    expect(roots.getState()).toMatchObject({ hostIdentity: 'host-a', status: 'loading' });
    await roots.select({ hostIdentity: 'host-b', cli: host.cli('conn-b') });
    slow.resolve({
      exitCode: 0,
      stdout: JSON.stringify({ schema: 1, workspaces: [{ path: '/srv/a', display_path: '/srv/a' }] }),
      stderr: '',
    });
    await first;
    expect(roots.getState()).toMatchObject({ hostIdentity: 'host-b', status: 'ready' });
    expect(roots.getState().memberships?.map((w) => w.path)).toEqual(['/srv/b']);
  });

  it('resets host-scoped state on a host change and clears on deselect', async () => {
    const host = new FakeHost();
    host.registry.set('host-a', ['/home/me/git']);
    const roots = model();
    await roots.select({ hostIdentity: 'host-a', cli: host.cli() });
    host.override = () => ({ exitCode: 1, stdout: '', stderr: 'boom' });
    await roots.select({ hostIdentity: 'host-b', cli: host.cli('conn-b') });
    // Host A's rows must not be shown as host B's while B fails.
    expect(roots.getState()).toMatchObject({ hostIdentity: 'host-b', status: 'error', memberships: null });
    await roots.select(null);
    expect(roots.getState()).toMatchObject({ hostIdentity: null, status: 'idle', memberships: null });
  });

  it('keeps malformed and failed host responses visible instead of an empty list', async () => {
    const host = new FakeHost();
    host.registry.set('host-a', ['/home/me/git']);
    const roots = model();
    await roots.select({ hostIdentity: 'host-a', cli: host.cli() });

    const cases: Array<[string, HostCliExecOutcome, RegExp]> = [
      ['not json', { exitCode: 0, stdout: 'workspaces: none', stderr: '' }, /not valid JSON/],
      ['too old', { exitCode: 0, stdout: '{"schema":0,"workspaces":[]}', stderr: '' }, /too old/],
      ['missing field', { exitCode: 0, stdout: '{"schema":1}', stderr: '' }, /missing the `workspaces` field/],
      ['bad row', { exitCode: 0, stdout: '{"schema":1,"workspaces":[{"path":""}]}', stderr: '' }, /empty `path`/],
      ['non-zero exit', { exitCode: 2, stdout: '', stderr: 'No such command "workspaces".' }, /exit 2.*No such command/],
      ['timeout', { exitCode: null, stdout: '', stderr: '', timedOut: true }, /did not finish/],
      ['empty stdout', { exitCode: 0, stdout: '  ', stderr: '' }, /printed nothing/],
    ];
    for (const [label, outcome, pattern] of cases) {
      host.override = () => outcome;
      await roots.refresh();
      const state = roots.getState();
      expect(state.status, label).toBe('error');
      expect(state.error, label).toMatch(pattern);
      // The last good listing stays, clearly flagged by the error above.
      expect(state.memberships?.map((w) => w.path), label).toEqual(['/home/me/git']);
    }

    host.override = () => { throw new Error('channel closed'); };
    const fresh = model();
    await fresh.select({ hostIdentity: 'host-z', cli: host.cli() });
    expect(fresh.getState()).toMatchObject({ status: 'error', memberships: null });
    expect(fresh.getState().error).toContain('channel closed');

    host.override = null;
    await roots.refresh();
    expect(roots.getState()).toMatchObject({ status: 'ready', error: null });
  });

  it('reports a failed add or remove without dropping the current roots', async () => {
    const host = new FakeHost();
    host.registry.set('host-a', ['/home/me/git']);
    const roots = model();
    await roots.select({ hostIdentity: 'host-a', cli: host.cli() });
    host.override = () => ({ exitCode: 2, stdout: '', stderr: 'workspaces: `path` must be absolute' });
    expect(await roots.addRoot('/srv/new')).toBe(false);
    expect(roots.getState().mutationError).toMatch(/must be absolute/);
    expect(await roots.removeRoot('/home/me/git')).toBe(false);
    expect(roots.getState().memberships?.map((w) => w.path)).toEqual(['/home/me/git']);
  });

  it('restores a previous client roots once without overwriting a newer order', async () => {
    const host = new FakeHost();
    host.registry.set('tree-1', ['/home/me/git/app']);
    const storage = new MemoryStorage();
    const previousRoots = { roots: ['~/git', '/home/me/git/app'], rootOrder: ['~/git', '/home/me/git/app'] };
    const roots = model(storage);
    await roots.select({ hostIdentity: 'tree-1', cli: host.cli(), previousRoots });
    expect(host.registry.get('tree-1')).toEqual(['/home/me/git', '/home/me/git/app']);
    expect(roots.ordered().map((w) => w.path)).toEqual(['/home/me/git', '/home/me/git/app']);
    expect(roots.getState().notice).toContain('Restored 1 workspace root');

    // The user removes a restored root and reorders; a restart must not undo either.
    await roots.removeRoot('/home/me/git');
    await roots.addRoot('/srv/zeta');
    roots.moveRoot('/srv/zeta', -1);
    const restarted = model(storage);
    await restarted.select({ hostIdentity: 'tree-1', cli: host.cli(), previousRoots });
    expect(host.registry.get('tree-1')).toEqual(['/home/me/git/app', '/srv/zeta']);
    expect(restarted.ordered().map((w) => w.path)).toEqual(['/srv/zeta', '/home/me/git/app']);
    expect(host.commands.filter((command) => command.includes(' add ')).length).toBe(2);
  });

  it('retries a failed restore on the next listing', async () => {
    const host = new FakeHost();
    const storage = new MemoryStorage();
    const previousRoots = { roots: ['~/git'], rootOrder: ['~/git'] };
    const roots = model(storage);
    host.override = (command) => command.includes(' add ')
      ? { exitCode: 1, stdout: '', stderr: 'registry locked' }
      : { exitCode: 0, stdout: '{"schema":1,"workspaces":[]}', stderr: '' };
    await roots.select({ hostIdentity: 'h', cli: host.cli(), previousRoots });
    expect(roots.getState().mutationError).toContain('registry locked');
    host.override = null;
    await roots.refresh();
    expect(host.registry.get('h')).toEqual(['/home/me/git']);
  });

  /** A CLI whose `add` replies are held until released; everything else passes through. */
  function heldAdds(host: FakeHost, connectionId: string) {
    const held: Array<() => void> = [];
    const cli = workspaceRootsCliForConnection(
      workspaceRootsApiFromExec((id, command, timeoutMs) => {
        if (!command.includes(' add ')) return host.exec(id, command);
        return new Promise<HostCliExecOutcome>((resolve) => {
          // The host applies the add when it runs; only the REPLY is held.
          held.push(() => void host.exec(id, command).then(resolve));
          void timeoutMs;
        });
      }),
      connectionId,
    );
    return { cli, release: () => held.splice(0).forEach((reply) => reply()) };
  }

  /** A CLI whose `add` runs on the host at once but whose REPLY is held. */
  function heldReplies(host: FakeHost, connectionId: string) {
    const held: Array<() => void> = [];
    const cli = workspaceRootsCliForConnection(
      workspaceRootsApiFromExec(async (id, command) => {
        const outcome = await host.exec(id, command);
        if (!command.includes(' add ')) return outcome;
        return new Promise<HostCliExecOutcome>((resolve) => held.push(() => resolve(outcome)));
      }),
      connectionId,
    );
    return { cli, release: () => held.splice(0).forEach((reply) => reply()) };
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  }

  it('runs one restore at a time across a reconnect that carries previous roots, as the app does', async () => {
    const host = new FakeHost();
    host.registry.set('h', []);
    const previousRoots = { roots: ['~/git'], rootOrder: ['~/git'] };
    const roots = model();
    const first = heldAdds(host, 'conn-1');
    const firstSelect = roots.select({ hostIdentity: 'h', cli: first.cli, previousRoots });
    await settle();

    // The app's bind() passes the Settings roots on EVERY select, reconnects included.
    const second = heldReplies(host, 'conn-2');
    const secondSelect = roots.select({ hostIdentity: 'h', cli: second.cli, previousRoots });
    await settle();
    expect(roots.getState().mutating).toBe(true);

    // The old connection's add finally lands. Its late reply must not start a
    // second restore, unlock the controls, or even list while conn-2's restore
    // is open — the re-read waits for that restore to finish.
    const lists = () => host.commands.filter((command) => command.includes(' list ')).length;
    const listsBefore = lists();
    first.release();
    await firstSelect;
    await settle();
    expect(roots.getState().mutating).toBe(true);
    expect(lists()).toBe(listsBefore);
    expect(await roots.removeRoot('/home/me/git')).toBe(false);
    expect(await roots.addRoot('/srv/x')).toBe(false);

    second.release();
    await secondSelect;
    await settle();
    expect(roots.getState().mutating).toBe(false);
    expect(host.registry.get('h')).toEqual(['/home/me/git']);
    expect(roots.getState().memberships?.map((w) => w.path)).toEqual(host.registry.get('h'));
    // Only the two restores' adds reached the host — no third from a doubled restore.
    expect(host.commands.filter((command) => command.includes(' add ')).length).toBe(2);
    expect(await roots.removeRoot('/home/me/git')).toBe(true);
    expect(roots.getState().memberships).toEqual([]);
  });

  it('does not start a second restore when the view refreshes during one', async () => {
    const host = new FakeHost();
    host.registry.set('h', []);
    const roots = model();
    const conn = heldAdds(host, 'conn-1');
    const selecting = roots.select({ hostIdentity: 'h', cli: conn.cli, previousRoots: { roots: ['~/git'], rootOrder: [] } });
    await settle();
    expect(roots.getState().mutating).toBe(true);
    await roots.refresh();
    expect(roots.getState().mutating).toBe(true);
    conn.release();
    await selecting;
    await settle();
    expect(host.commands.filter((command) => command.includes(' add ')).length).toBe(1);
    expect(roots.getState()).toMatchObject({ mutating: false, status: 'ready' });
    expect(roots.getState().memberships?.map((w) => w.path)).toEqual(['/home/me/git']);
  });

  it('answers a late reply with a listing only, never another registration command', async () => {
    const host = new FakeHost();
    host.registry.set('h', []);
    const previousRoots = { roots: ['~/git'], rootOrder: [] };
    const roots = model();
    // conn-1's restore add is lost in transit and eventually FAILS without applying.
    const late: Array<() => void> = [];
    const first = workspaceRootsCliForConnection(workspaceRootsApiFromExec(async (id, command) => {
      if (!command.includes(' add ')) return host.exec(id, command);
      host.commands.push(command);
      return new Promise<HostCliExecOutcome>((resolve) => late.push(() => resolve({ exitCode: null, stdout: '', stderr: '', timedOut: true })));
    }), 'conn-1');
    const firstSelect = roots.select({ hostIdentity: 'h', cli: first, previousRoots });
    await settle();
    // conn-2's own restore fails outright, so nothing holds the lock afterwards.
    const failing = workspaceRootsCliForConnection(workspaceRootsApiFromExec(async (id, command) => {
      if (!command.includes(' add ')) return host.exec(id, command);
      host.commands.push(command);
      return { exitCode: 1, stdout: '', stderr: 'registry locked' };
    }), 'conn-2');
    await roots.select({ hostIdentity: 'h', cli: failing, previousRoots });
    expect(roots.getState()).toMatchObject({ mutating: false });
    const adds = () => host.commands.filter((command) => command.includes(' add ')).length;
    const addsBefore = adds();

    late.splice(0).forEach((reply) => reply());
    await firstSelect;
    await settle();
    expect(adds()).toBe(addsBefore);
    expect(roots.getState().mutating).toBe(false);
  });

  it('re-reads once the current operation ends when a late reply arrived during it', async () => {
    const host = new FakeHost();
    host.registry.set('h', ['/home/me/git']);
    const roots = model();
    const first = heldAdds(host, 'conn-1');
    await roots.select({ hostIdentity: 'h', cli: first.cli });
    const lateAdd = roots.addRoot('/srv/a');
    await settle();

    const second = heldReplies(host, 'conn-2');
    await roots.select({ hostIdentity: 'h', cli: second.cli });
    const currentAdd = roots.addRoot('/srv/b');
    await settle();

    // /srv/a lands on the host AFTER conn-2's add answered from its own view.
    first.release();
    expect(await lateAdd).toBe(false);
    second.release();
    expect(await currentAdd).toBe(true);
    await settle();
    expect(host.registry.get('h')).toEqual(['/home/me/git', '/srv/a', '/srv/b']);
    expect(roots.getState().memberships?.map((w) => w.path)).toEqual(host.registry.get('h'));
  });

  /** A CLI whose `list` is answered by the host at SEND time but whose reply is held. */
  function heldLists(host: FakeHost, connectionId: string) {
    const held: Array<() => void> = [];
    const cli = workspaceRootsCliForConnection(
      workspaceRootsApiFromExec(async (id, command) => {
        const outcome = await host.exec(id, command);
        if (!command.includes(' list ')) return outcome;
        return new Promise<HostCliExecOutcome>((resolve) => held.push(() => resolve(outcome)));
      }),
      connectionId,
    );
    return {
      cli,
      release: () => held.splice(0).forEach((reply) => reply()),
      pending: () => held.length,
      takeAll: () => held.splice(0),
    };
  }

  const rows = (roots: HostWorkspaceRoots) => roots.getState().memberships?.map((w) => w.path);

  // Reviewer interleavings I1–I3 (#2925 round 3): a listing requested BEFORE a
  // registration change and answered AFTER it must never overwrite the newer rows.
  it('I1: a reconnect listing that lands after a user remove does not bring the root back', async () => {
    const host = new FakeHost();
    host.registry.set('h', ['/home/me/git', '/srv/a']);
    const roots = model();
    await roots.select({ hostIdentity: 'h', cli: host.cli('conn-1') });
    const conn2 = heldLists(host, 'conn-2');
    const reselect = roots.select({ hostIdentity: 'h', cli: conn2.cli });
    await settle();
    expect(await roots.removeRoot('/srv/a')).toBe(true);
    for (let i = 0; i < 5 && conn2.pending(); i += 1) { conn2.release(); await settle(); }
    await reselect;
    await settle();
    expect(host.registry.get('h')).toEqual(['/home/me/git']);
    expect(rows(roots)).toEqual(host.registry.get('h'));
  });

  it('I2: a first listing that lands after a user add does not drop the new root', async () => {
    const host = new FakeHost();
    host.registry.set('h', ['/home/me/git']);
    const roots = model();
    const conn = heldLists(host, 'conn-1');
    const selecting = roots.select({ hostIdentity: 'h', cli: conn.cli });
    await settle();
    expect(await roots.addRoot('/srv/new')).toBe(true);
    for (let i = 0; i < 5 && conn.pending(); i += 1) { conn.release(); await settle(); }
    await selecting;
    await settle();
    expect(host.registry.get('h')).toEqual(['/home/me/git', '/srv/new']);
    expect(rows(roots)).toEqual(host.registry.get('h'));
  });

  it('I1b: a late-reply re-list that lands after a user add does not drop the new root', async () => {
    const host = new FakeHost();
    host.registry.set('h', ['/home/me/git']);
    const roots = model();
    const first = heldAdds(host, 'conn-1');
    await roots.select({ hostIdentity: 'h', cli: first.cli });
    const lateAdd = roots.addRoot('/srv/late');
    await settle();
    const conn2 = heldLists(host, 'conn-2');
    const reselect = roots.select({ hostIdentity: 'h', cli: conn2.cli });
    await settle();
    conn2.release();
    await reselect;
    // The late reply asks for a re-list; hold that listing's reply.
    first.release();
    await settle();
    expect(conn2.pending()).toBe(1);
    expect(await roots.addRoot('/srv/b')).toBe(true);
    for (let i = 0; i < 5 && conn2.pending(); i += 1) { conn2.release(); await settle(); }
    expect(await lateAdd).toBe(false);
    await settle();
    expect(host.registry.get('h')).toEqual(['/home/me/git', '/srv/b', '/srv/late']);
    expect(rows(roots)).toEqual(host.registry.get('h'));
  });

  it('I3: host switch, reconnect with restore and late replies from both old connections', async () => {
    const host = new FakeHost();
    host.registry.set('h', ['/home/me/git']);
    host.registry.set('g', []);
    const prev = { roots: ['/srv/p'], rootOrder: [] };
    const roots = model();
    const h = heldAdds(host, 'conn-h');
    await roots.select({ hostIdentity: 'h', cli: h.cli });
    const hAdd = roots.addRoot('/srv/late-h');
    await settle();
    const g1 = heldReplies(host, 'conn-g1');
    const gSel1 = roots.select({ hostIdentity: 'g', cli: g1.cli, previousRoots: prev });
    await settle();
    expect(roots.getState().mutating).toBe(true);
    const g2 = heldLists(host, 'conn-g2');
    const gSel2 = roots.select({ hostIdentity: 'g', cli: g2.cli, previousRoots: prev });
    await settle();
    h.release();
    expect(await hAdd).toBe(false);
    g1.release();
    await settle();
    for (let i = 0; i < 5 && g2.pending(); i += 1) { g2.release(); await settle(); }
    await gSel1;
    await gSel2;
    await settle();
    expect(roots.getState()).toMatchObject({ hostIdentity: 'g', mutating: false });
    expect(rows(roots)).toEqual(host.registry.get('g'));
    expect(host.commands.filter((c) => c.includes(" --host 'g'") && c.includes(' add ')).length).toBe(1);
    expect(host.registry.get('h')).toEqual(['/home/me/git', '/srv/late-h']);
    expect(await roots.addRoot('/srv/q')).toBe(true);
  });

  it('writes only the latest listing when two listings land out of order', async () => {
    const host = new FakeHost();
    host.registry.set('h', ['/home/me/git']);
    const roots = model();
    await roots.select({ hostIdentity: 'h', cli: host.cli('conn-1') });
    const conn = heldLists(host, 'conn-2');
    const older = roots.select({ hostIdentity: 'h', cli: conn.cli });
    await settle();
    // Another client registers a root between the two listings.
    host.registry.set('h', ['/home/me/git', '/srv/other-client']);
    const newer = roots.refresh();
    await settle();
    expect(conn.pending()).toBe(2);
    // The newer answer lands first, then the older one.
    const replies = conn.takeAll();
    replies[1]!();
    await settle();
    expect(rows(roots)).toEqual(['/home/me/git', '/srv/other-client']);
    replies[0]!();
    await older;
    await newer;
    await settle();
    expect(rows(roots)).toEqual(host.registry.get('h'));
    expect(conn.pending()).toBe(0);
  });

  it('re-reads a listing that a reorder overlapped, like any other change', async () => {
    const host = new FakeHost();
    host.registry.set('h', ['/home/me/git', '/home/me/tmp']);
    const roots = model();
    const conn = heldLists(host, 'conn-1');
    const selecting = roots.select({ hostIdentity: 'h', cli: conn.cli });
    await settle();
    conn.release();
    await settle();
    await selecting;
    const refreshing = roots.refresh();
    await settle();
    expect(roots.moveRoot('/home/me/tmp', -1)).toBe(true);
    conn.release();
    await settle();
    // The overlapped listing was dropped and one more was sent.
    expect(conn.pending()).toBe(1);
    conn.release();
    await refreshing;
    expect(roots.ordered().map((w) => w.path)).toEqual(['/home/me/tmp', '/home/me/git']);
    expect(roots.getState().status).toBe('ready');
  });

  it('never re-lists another host when a late reply for the previous host arrives', async () => {
    const host = new FakeHost();
    host.registry.set('h', ['/home/me/git']);
    host.registry.set('g', ['/srv/g']);
    const roots = model();
    const first = heldAdds(host, 'conn-h');
    await roots.select({ hostIdentity: 'h', cli: first.cli });
    const pending = roots.addRoot('/srv/late');
    await settle();

    await roots.select({ hostIdentity: 'g', cli: host.cli('conn-g') });
    const before = roots.getState();
    const listsForG = () => host.commands.filter((command) => command.includes("list --host 'g'")).length;
    const gLists = listsForG();

    first.release();
    expect(await pending).toBe(false);
    await settle();
    expect(listsForG()).toBe(gLists);
    expect(roots.getState()).toEqual(before);
  });

  it('releases an add superseded by a reconnect to the same host and shows the host state', async () => {
    const host = new FakeHost();
    host.registry.set('h', ['/home/me/git']);
    const roots = model();
    const first = heldAdds(host, 'conn-1');
    await roots.select({ hostIdentity: 'h', cli: first.cli });
    const pending = roots.addRoot('/srv/b');
    await settle();
    expect(roots.getState().mutating).toBe(true);

    // Background/foreground or a network change: same host, new connection.
    await roots.select({ hostIdentity: 'h', cli: host.cli('conn-2') });
    expect(roots.getState().mutating).toBe(false);
    first.release();
    expect(await pending).toBe(false);
    await settle();

    expect(roots.getState().mutating).toBe(false);
    expect(roots.getState().memberships?.map((w) => w.path)).toEqual(['/home/me/git', '/srv/b']);
    // Mutations work again on the new connection.
    expect(await roots.removeRoot('/srv/b')).toBe(true);
    expect(await roots.addRoot('/srv/c')).toBe(true);
    expect(host.registry.get('h')).toEqual(['/home/me/git', '/srv/c']);
  });

  it('releases a restore superseded by a reconnect to the same host', async () => {
    const host = new FakeHost();
    const storage = new MemoryStorage();
    const previousRoots = { roots: ['~/git'], rootOrder: ['~/git'] };
    const roots = model(storage);
    const first = heldAdds(host, 'conn-1');
    const firstSelect = roots.select({ hostIdentity: 'h', cli: first.cli, previousRoots });
    await settle();
    expect(roots.getState().mutating).toBe(true);

    // The reconnect carries no previous roots of its own, so nothing on the
    // new epoch touches `mutating`: only the superseded restore could.
    await roots.select({ hostIdentity: 'h', cli: host.cli('conn-2') });
    expect(roots.getState().mutating).toBe(false);
    first.release();
    await firstSelect;
    await settle();

    expect(roots.getState()).toMatchObject({ mutating: false, status: 'ready' });
    // The host applied the superseded add; the view re-lists and shows it.
    expect(host.registry.get('h')).toEqual(['/home/me/git']);
    expect(roots.getState().memberships?.map((w) => w.path)).toEqual(['/home/me/git']);
    expect(await roots.addRoot('/srv/d')).toBe(true);
  });

  it('treats an unreadable restore record as already restored, says so once, and repairs it', async () => {
    const host = new FakeHost();
    host.registry.set('h', []);
    const storage = new MemoryStorage();
    storage.setItem(WORKSPACE_ROOTS_RESTORED_STORAGE_KEY, '[broken');
    const previousRoots = { roots: ['~/git'], rootOrder: [] };
    const roots = model(storage);
    await roots.select({ hostIdentity: 'h', cli: host.cli(), previousRoots });
    // A root the user removed must not come back from the previous client.
    expect(host.registry.get('h')).toEqual([]);
    expect(host.commands.some((command) => command.includes(' add '))).toBe(false);
    expect(roots.getState().mutationError).toMatch(/restore record is unreadable/);
    // The unreadable copy is kept; the record itself is rewritten to a valid
    // "every host already restored" form, so it stays fail-closed.
    expect(storage.getItem(`${WORKSPACE_ROOTS_RESTORED_STORAGE_KEY}.unreadable-42`)).toBe('[broken');
    expect(JSON.parse(storage.getItem(WORKSPACE_ROOTS_RESTORED_STORAGE_KEY)!)).toEqual(['*']);

    // Said once: the next listing in this process does not repeat it...
    roots.clearMessages();
    await roots.refresh();
    expect(roots.getState().mutationError).toBeNull();
    // ...and a restart finds a readable record, still closed for every host.
    const ledger = new RestoredWorkspaceRootsLedger(storage, () => 43);
    expect(ledger.loadError).toBeNull();
    expect(ledger.has('some-other-host')).toBe(true);
    ledger.add('some-other-host');
    expect(JSON.parse(storage.getItem(WORKSPACE_ROOTS_RESTORED_STORAGE_KEY)!)).toEqual(['*']);
    const restarted = model(storage);
    await restarted.select({ hostIdentity: 'h2', cli: host.cli(), previousRoots });
    expect(restarted.getState().mutationError).toBeNull();
    expect(host.commands.some((command) => command.includes(' add '))).toBe(false);
  });

  it('clears the deadline timer when the command answers first', async () => {
    const cleared: unknown[] = [];
    const exec = execWithDeadline(
      async () => ({ exitCode: 0, stdout: 'x', stderr: '' }),
      () => 'timer-1',
      (timer) => cleared.push(timer),
    );
    await exec('c', 20_000);
    expect(cleared).toEqual(['timer-1']);
  });

  it('preserves an unreadable stored order and says so', () => {
    const storage = new MemoryStorage();
    storage.setItem(WORKSPACE_ROOT_ORDER_STORAGE_KEY, '{broken');
    const store = new WorkspaceRootOrderStore(storage, () => 7);
    expect(store.loadError).toContain('not valid JSON');
    expect(storage.getItem(`${WORKSPACE_ROOT_ORDER_STORAGE_KEY}.unreadable-7`)).toBe('{broken');
    expect(store.get('h').rootOrder).toEqual([]);
  });

  it('gives a deadline-less exec a timed-out outcome', async () => {
    vi.useFakeTimers();
    try {
      const exec = execWithDeadline(() => new Promise(() => undefined));
      const outcome = exec('pocketshell workspaces list --host h --json', 1_000);
      vi.advanceTimersByTime(1_000);
      await expect(outcome).resolves.toMatchObject({ exitCode: null, timedOut: true });
      const fast = execWithDeadline(async () => ({ exitCode: 0, stdout: 'x', stderr: '' }));
      await expect(fast('c', 1_000)).resolves.toEqual({ exitCode: 0, stdout: 'x', stderr: '', timedOut: false });
    } finally {
      vi.useRealTimers();
    }
  });
});
