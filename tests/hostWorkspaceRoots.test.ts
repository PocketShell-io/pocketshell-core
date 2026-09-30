import { describe, expect, it, vi } from 'vitest';
import type { HostCliExecOutcome } from '../src/hostCliCommon';
import {
  HostWorkspaceRoots,
  RestoredWorkspaceRootsLedger,
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
  return new HostWorkspaceRoots(new WorkspaceRootOrderStore(storage, () => 42), new RestoredWorkspaceRootsLedger(storage));
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
