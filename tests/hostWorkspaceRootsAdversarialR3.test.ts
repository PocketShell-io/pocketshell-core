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

describe('reviewer adversarial interleavings (round 3)', () => {
  it('I1: reconnect listing in flight, user removes a root, stale listing lands after', async () => {
    const host = new FakeHost();
    host.registry.set('h', ['/home/me/git', '/srv/a']);
    const roots = model();
    await roots.select({ hostIdentity: 'h', cli: host.cli('conn-1') });
    expect(paths(roots)).toEqual(['/home/me/git', '/srv/a']);
    // Reconnect: rows stay on screen while the new connection's list is in flight.
    const conn2 = heldLists(host, 'conn-2');
    const reselect = roots.select({ hostIdentity: 'h', cli: conn2.cli });
    await settle();
    const s = roots.getState();
    // The Remove button is only disabled on `mutating`, so this click is accepted.
    const removed = await roots.removeRoot('/srv/a');
    for (let i = 0; i < 5 && conn2.pending(); i += 1) { conn2.release(); await settle(); }
    await reselect;
    await settle();
    expect(paths(roots)).toEqual(host.registry.get('h'));
  });

  it('I2: first listing in flight, user adds a root, stale listing lands after', async () => {
    const host = new FakeHost();
    host.registry.set('h', ['/home/me/git']);
    const roots = model();
    const conn = heldLists(host, 'conn-1');
    const selecting = roots.select({ hostIdentity: 'h', cli: conn.cli });
    await settle();
    const added = await roots.addRoot('/srv/new');
    for (let i = 0; i < 5 && conn.pending(); i += 1) { conn.release(); await settle(); }
    await selecting;
    await settle();
    expect(paths(roots)).toEqual(host.registry.get('h'));
  });

  it('I3: host switch h->g, reconnect g with restore, late h reply then late g-1 reply', async () => {
    const host = new FakeHost();
    host.registry.set('h', ['/home/me/git']);
    host.registry.set('g', []);
    const prev = { roots: ['/srv/p'], rootOrder: [] };
    const roots = model();
    // h: an add held in transit
    const hHeld: Array<() => void> = [];
    const hcli = workspaceRootsCliForConnection(workspaceRootsApiFromExec((id, c) => c.includes(' add ')
      ? new Promise<HostCliExecOutcome>((r) => hHeld.push(() => void host.exec(id, c).then(r)))
      : host.exec(id, c)), 'conn-h');
    await roots.select({ hostIdentity: 'h', cli: hcli });
    const hAdd = roots.addRoot('/srv/late-h');
    await settle();
    // g conn-1 with restore, add reply held
    const g1Held: Array<() => void> = [];
    const g1 = workspaceRootsCliForConnection(workspaceRootsApiFromExec(async (id, c) => {
      const o = await host.exec(id, c);
      return c.includes(' add ') ? new Promise<HostCliExecOutcome>((r) => g1Held.push(() => r(o))) : o;
    }), 'conn-g1');
    const gSel1 = roots.select({ hostIdentity: 'g', cli: g1, previousRoots: prev });
    await settle();
    expect(roots.getState().mutating).toBe(true);
    // reconnect g, restore again (already registered now -> none missing)
    const g2 = heldLists(host, 'conn-g2');
    const gSel2 = roots.select({ hostIdentity: 'g', cli: g2.cli, previousRoots: prev });
    await settle();
    hHeld.splice(0).forEach((f) => f());
    expect(await hAdd).toBe(false);
    g1Held.splice(0).forEach((f) => f());
    await settle();
    for (let i = 0; i < 5 && g2.pending(); i += 1) { g2.release(); await settle(); }
    await gSel1;
    await gSel2;
    await settle();
    expect(roots.getState().hostIdentity).toBe('g');
    expect(roots.getState().mutating).toBe(false);
    expect(paths(roots)).toEqual(host.registry.get('g'));
    expect(host.commands.filter((c) => c.includes(" --host 'g'") && c.includes(' add ')).length).toBe(1);
    expect(host.registry.get('h')).toEqual(['/home/me/git', '/srv/late-h']);
    expect(await roots.addRoot('/srv/q')).toBe(true);
  });
});
