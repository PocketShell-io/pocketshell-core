// Reviewer adversarial interleavings for #2925, kept as regression tests.
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
  return { cli, release: () => held.splice(0).forEach((reply) => reply()), pending: () => held.length };
}
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}
const paths = (roots: HostWorkspaceRoots) => roots.getState().memberships?.map((w) => w.path);

/** A CLI whose `add` is APPLIED on the host only when released (the command is still running). */
function heldAdds(host: FakeHost, connectionId: string) {
  const held: Array<() => void> = [];
  const cli = workspaceRootsCliForConnection(
    workspaceRootsApiFromExec((id, command) => {
      if (!command.includes(' add ') && !command.includes(' remove ')) return host.exec(id, command);
      return new Promise<HostCliExecOutcome>((resolve) => held.push(() => void host.exec(id, command).then(resolve)));
    }),
    connectionId,
  );
  return { cli, release: () => held.splice(0).forEach((reply) => reply()), pending: () => held.length };
}
/** Lists answered by the host at SEND time, replies held individually (release in any order). */
function orderedLists(host: FakeHost, connectionId: string, alsoHoldAdds = false) {
  const lists: Array<() => void> = [];
  const adds: Array<() => void> = [];
  const cli = workspaceRootsCliForConnection(
    workspaceRootsApiFromExec(async (id, command) => {
      if (alsoHoldAdds && (command.includes(' add ') || command.includes(' remove '))) {
        return new Promise<HostCliExecOutcome>((resolve) => adds.push(() => void host.exec(id, command).then(resolve)));
      }
      const outcome = await host.exec(id, command);
      if (!command.includes(' list ')) return outcome;
      return new Promise<HostCliExecOutcome>((resolve) => lists.push(() => resolve(outcome)));
    }),
    connectionId,
  );
  return { cli, lists, adds };
}

async function drain(q: Array<() => void>): Promise<void> {
  for (let i = 0; i < 10 && q.length; i += 1) { q.shift()!(); await settle(); }
}

describe('reviewer adversarial interleavings (round 4)', () => {
  it('R4-A: listing SENT during an add (same epoch) whose reply lands after the add reply', async () => {
    const host = new FakeHost();
    host.registry.set('h', ['/home/me/git']);
    const roots = model();
    const c = orderedLists(host, 'conn-1', true);
    const sel = roots.select({ hostIdentity: 'h', cli: c.cli });
    await settle();
    c.lists.shift()!();
    await sel;
    await settle();
    expect(paths(roots)).toEqual(['/home/me/git']);
    const adding = roots.addRoot('/srv/new');          // add command running, not yet applied
    await settle();
    const refreshing = roots.refresh();                 // public API: list answered now = [git], reply held
    await settle();
    c.adds.shift()!();                                  // host applies the add; its reply lands
    expect(await adding).toBe(true);
    await settle();
    c.lists.shift()!();                                 // the stale list reply lands last
    await settle();
    await drain(c.lists);
    await refreshing;
    await settle();
    expect(paths(roots)).toEqual(host.registry.get('h'));
  });

  it('R4-B: reconnect while an add is in flight; the reconnect listing lands after the settle re-list', async () => {
    const host = new FakeHost();
    host.registry.set('h', ['/home/me/git']);
    const roots = model();
    const conn1 = heldAdds(host, 'conn-1');
    await roots.select({ hostIdentity: 'h', cli: conn1.cli });
    const adding = roots.addRoot('/srv/new');           // add running on conn-1, not applied yet
    await settle();
    const conn2 = orderedLists(host, 'conn-2');
    const reselect = roots.select({ hostIdentity: 'h', cli: conn2.cli }); // R: answered now = [git], held
    await settle();
    expect(conn2.lists.length).toBe(1);
    conn1.release();                                    // add applied; superseded reply -> re-list L
    await settle();
    expect(conn2.lists.length).toBe(2);
    conn2.lists[1]!();                                  // L (newer, [git,new]) lands first
    await settle();
    conn2.lists[0]!();                                  // R (older, [git]) lands last
    conn2.lists.splice(0, 2);
    await settle();
    await drain(conn2.lists);
    await reselect;
    await settle();
    expect(await adding).toBe(false);
    expect(paths(roots)).toEqual(host.registry.get('h'));
  });

  it('R4-B2 control: same as R4-B but replies in send order', async () => {
    const host = new FakeHost();
    host.registry.set('h', ['/home/me/git']);
    const roots = model();
    const conn1 = heldAdds(host, 'conn-1');
    await roots.select({ hostIdentity: 'h', cli: conn1.cli });
    const adding = roots.addRoot('/srv/new');
    await settle();
    const conn2 = orderedLists(host, 'conn-2');
    const reselect = roots.select({ hostIdentity: 'h', cli: conn2.cli });
    await settle();
    conn1.release();
    await settle();
    conn2.lists[0]!();
    await settle();
    conn2.lists[1]!();
    conn2.lists.splice(0, 2);
    await settle();
    await drain(conn2.lists);
    await reselect;
    await adding;
    await settle();
    expect(paths(roots)).toEqual(host.registry.get('h'));
  });

  it('R4-C control: listing sent during an add, reply lands BEFORE the add reply (deferred)', async () => {
    const host = new FakeHost();
    host.registry.set('h', ['/home/me/git']);
    const roots = model();
    const c = orderedLists(host, 'conn-1', true);
    const sel = roots.select({ hostIdentity: 'h', cli: c.cli });
    await settle();
    c.lists.shift()!();
    await sel;
    const adding = roots.addRoot('/srv/new');
    await settle();
    const refreshing = roots.refresh();
    await settle();
    c.lists.shift()!();
    await settle();
    c.adds.shift()!();
    await settle();
    await drain(c.lists);
    await adding;
    await refreshing;
    expect(paths(roots)).toEqual(host.registry.get('h'));
    expect(roots.getState().status).toBe('ready');
  });

  it('R4-D: remove during a restore-triggering first listing on reconnect keeps rows true', async () => {
    const host = new FakeHost();
    host.registry.set('h', ['/home/me/git', '/srv/a']);
    const roots = model();
    await roots.select({ hostIdentity: 'h', cli: host.cli('conn-1') });
    const c = orderedLists(host, 'conn-2');
    const reselect = roots.select({ hostIdentity: 'h', cli: c.cli, previousRoots: { roots: ['/srv/p'], rootOrder: [] } });
    await settle();
    expect(await roots.removeRoot('/srv/a')).toBe(true);
    for (let i = 0; i < 6 && c.lists.length; i += 1) { c.lists.shift()!(); await settle(); }
    await reselect;
    await settle();
    // restore decision must be made on a fresh listing: /srv/p restored exactly once
    expect(host.commands.filter((x) => x.includes(' add ')).length).toBe(1);
    expect(paths(roots)).toEqual(host.registry.get('h'));
    expect(roots.getState().mutating).toBe(false);
  });
});
