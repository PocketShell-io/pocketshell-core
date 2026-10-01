// Reviewer randomized interleaving checker for #2925 (round 5): every written
// listing must reflect all completed changes, and the view must quiesce to the
// host registry. Kept as a regression test over the whole class of orderings.
// Reviewer r5: seeded randomized interleaving checker for HostWorkspaceRoots.
import { describe, expect, it } from 'vitest';
import type { HostCliExecOutcome } from '../src/hostCliCommon';
import {
  HostWorkspaceRoots, RestoredWorkspaceRootsLedger, WorkspaceRootOrderStore,
  workspaceRootsApiFromExec, workspaceRootsCliForConnection, type WorkspaceStringStorage,
} from '../src/hostWorkspaceRoots';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
class Mem implements WorkspaceStringStorage { v = new Map<string, string>(); getItem(k: string) { return this.v.get(k) ?? null; } setItem(k: string, x: string) { this.v.set(k, x); } }
const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r)); };

type Ev = { kind: 'exec' | 'reply'; run: () => void };
interface Result { violations: string[]; lists: number; bumps: number; events: number; livelock: boolean; final: string }

async function scenario(seed: number, opts: { steps: number; errors: boolean; storm?: boolean }): Promise<Result> {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const registry = new Map<string, string[]>([['A', ['/p/a']], ['B', ['/p/b']]]);
  let clock = 0;
  const maxCompleted = new Map<string, number>();
  const pending: Ev[] = [];
  let delivering: { kind: string; host: string; execTime: number } | null = null;
  let lists = 0;
  const violations: string[] = [];
  const exec = (_id: string, command: string) => new Promise<HostCliExecOutcome>((resolve) => {
    const m = /^pocketshell workspaces (list|add|remove)(?: '([^']*)')? --host '([^']*)' --json$/.exec(command)!;
    const [, op, path, host] = m;
    if (op === 'list') lists += 1;
    pending.push({ kind: 'exec', run: () => {
      const fail = opts.errors && r() < 0.12;
      const applyThenFail = fail && op !== 'list' && r() < 0.5;
      const entries = [...(registry.get(host!) ?? [])];
      if (!fail || applyThenFail) {
        if (op === 'add' && !entries.includes(path!)) entries.push(path!);
        if (op === 'remove' && entries.includes(path!)) entries.splice(entries.indexOf(path!), 1);
        entries.sort(); registry.set(host!, entries);
      }
      const execTime = ++clock;
      const out: HostCliExecOutcome = fail ? { exitCode: 1, stdout: '', stderr: 'boom' }
        : { exitCode: 0, stdout: JSON.stringify({ schema: 1, host, workspaces: entries.map((p) => ({ path: p, display_path: p })) }), stderr: '' };
      pending.push({ kind: 'reply', run: () => {
        if (op !== 'list') maxCompleted.set(host!, Math.max(maxCompleted.get(host!) ?? 0, execTime));
        delivering = { kind: op!, host: host!, execTime };
        resolve(out);
      } });
    } });
  });
  const api = workspaceRootsApiFromExec(exec);
  const storage = new Mem();
  const roots = new HostWorkspaceRoots(new WorkspaceRootOrderStore(storage, () => 1), new RestoredWorkspaceRootsLedger(storage, () => 1));
  const anyRoots = roots as any;
  const origSet = anyRoots.set.bind(roots);
  anyRoots.set = (u: any) => {
    const d = delivering as any;
    if (d && d.kind === 'list' && u.memberships !== undefined && u.status === 'ready') {
      const sel = anyRoots.selection?.hostIdentity;
      if (sel !== d.host) violations.push(`listing for ${d.host} written while ${sel} selected`);
      const need = maxCompleted.get(d.host) ?? 0;
      if (d.execTime < need) violations.push(`seed ${seed}: listing exec@${d.execTime} written after a mutation completed exec@${need}`);
    }
    origSet(u);
  };
  let bumps = 0; const genOf = () => anyRoots.generation as number;
  let conn = 0;
  const actions = [
    () => { conn += 1; void roots.select({ hostIdentity: 'A', cli: workspaceRootsCliForConnection(api, `c${conn}`), previousRoots: r() < 0.5 ? { roots: ['/p/r1', '/p/r2'], rootOrder: ['/p/r1'] } : null }); },
    () => { conn += 1; void roots.select({ hostIdentity: pick(['A', 'B']), cli: workspaceRootsCliForConnection(api, `c${conn}`) }); },
    () => { if (r() < 0.2) void roots.select(null); },
    () => { void roots.addRoot(pick(['/p/x', '/p/y', '/p/r1', '/p/a'])); },
    () => { const m = roots.getState().memberships; if (m?.length) void roots.removeRoot(pick(m).path); },
    () => { const m = roots.getState().memberships; if (m?.length) roots.moveRoot(pick(m).path, pick([-1, 1] as const)); },
    () => { void roots.refresh(); },
  ];
  let events = 0;
  const step = async () => {
    const i = Math.floor(r() * pending.length);
    const [ev] = pending.splice(i, 1);
    const before = genOf(); ev!.run(); await flush(); delivering = null; bumps += Math.max(0, genOf() - before); events += 1;
  };
  actions[0]!(); await flush();
  for (let s = 0; s < opts.steps; s += 1) {
    const actProb = opts.storm ? 0.7 : 0.3;
    if (r() < actProb || pending.length === 0) { const before = genOf(); pick(actions)(); await flush(); bumps += Math.max(0, genOf() - before); }
    else await step();
  }
  // Quiescence: no more actions; drain. Must terminate.
  let drained = 0; let livelock = false;
  while (pending.length) { await step(); drained += 1; if (drained > 2000) { livelock = true; break; } }
  const st = roots.getState();
  const sel = anyRoots.selection?.hostIdentity ?? null;
  if (!livelock && sel) {
    if (st.status === 'loading') violations.push(`seed ${seed}: stuck loading`);
    if (st.mutating) violations.push(`seed ${seed}: stuck mutating`);
    const truth = JSON.stringify(registry.get(sel));
    const shown = JSON.stringify(st.memberships?.map((w) => w.path));
    if (st.status !== 'error' && shown !== truth && !(opts.errors && st.mutationError)) violations.push(`seed ${seed}: quiescent rows ${shown} != host ${truth} (status ${st.status})`);
    if (!opts.errors && shown !== truth) violations.push(`seed ${seed}: quiescent (no errors) rows ${shown} != host ${truth}`);
  }
  if (livelock) violations.push(`seed ${seed}: did not quiesce`);
  return { violations, lists, bumps, events, livelock, final: '' };
}

// ~200 seeds per mode keeps this about a second and a half; FUZZ_SEEDS raises it.
const SEEDS = Number(process.env.FUZZ_SEEDS ?? 200);
describe('r5 randomized interleavings', () => {
  for (const [name, opts] of [['no errors', { steps: 60, errors: false }], ['with errors', { steps: 60, errors: true }], ['action storm', { steps: 120, errors: false, storm: true }]] as const) {
    it(`${name}: every written listing reflects all completed mutations; quiesces to host truth`, async () => {
      const all: string[] = []; let maxRatio = 0; let totalLists = 0; let totalEvents = 0;
      for (let seed = 1; seed <= SEEDS; seed += 1) {
        const res = await scenario(seed, opts);
        all.push(...res.violations);
        totalLists += res.lists; totalEvents += res.events;
      }
      expect(all).toEqual([]);
    }, 600_000);
  }
});
