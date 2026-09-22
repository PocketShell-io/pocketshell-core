import { afterAll, beforeAll, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { AplexerCore } from '../../src/aplexerClientCore';
import { connectSsh, describeDocker, execTransport, type SshHandle } from './helpers';

/**
 * Integration tests for core's `AplexerCore` against the real
 * `pocketshell-test:helper` image (which installs the real `a` — aplexer —
 * plus tmux and the stub agents, and seeds live `main`/`build` sessions at
 * boot). The same contract pocketshell-desktop's PocketshellClient suite
 * exercises, driven through core's client over core's one-method transport —
 * the contract tests live where the contract lives.
 */
describeDocker('AplexerCore integration', () => {
  let container: StartedTestContainer | undefined;
  let handle: SshHandle;
  let client: AplexerCore;
  let home: string;

  beforeAll(async () => {
    container = await new GenericContainer('pocketshell-test:helper')
      .withExposedPorts(22)
      .start();
    handle = await connectSsh(container.getHost(), container.getMappedPort(22));
    client = new AplexerCore(execTransport(handle));
    // `a snapshot` answers from the entrypoint's seeds; give them a beat.
    const who = await execTransport(handle).exec('echo $HOME');
    home = who.stdout.trim();
    await new Promise((r) => setTimeout(r, 1500));
  }, 120_000);

  afterAll(async () => {
    handle?.close();
    if (container) await container.stop();
  });

  it('isAvailable probes true — the helper image has `a` on PATH', async () => {
    expect(await client.isAvailable()).toBe(true);
  });

  it('listSessions returns the seeded main/build sessions as summaries', async () => {
    const sessions = await client.listSessions();
    expect(sessions).not.toBeNull();
    const names = sessions!.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['main', 'build']));
    for (const s of sessions!) {
      expect(typeof s.created).toBe('number');
      expect(typeof s.activity).toBe('number');
      expect(typeof s.attached).toBe('boolean');
    }
  });

  it('snapshotRecords carries the stable selectors (id, workspace, tag)', async () => {
    const records = await client.snapshotRecords();
    expect(records.length).toBeGreaterThanOrEqual(2);
    for (const r of records) {
      expect(r.id).toBeTruthy();
      expect(r.workspace).toBeTruthy();
      expect(r.tag).toBeTruthy();
    }
  });

  it('start → find → rename → kill round-trips a real session', async () => {
    const tag = `core-test-${Date.now()}`;
    const started = await client.startSession({ workspace: home, tag });
    expect(started.ok).toBe(true);
    expect(started.error).toBeNull();
    expect(started.id).toBeTruthy();
    expect(started.tag).toBe(tag);
    const id = started.id!;

    // Identity discipline: the UUID is the stable selector; the tag is not.
    const found = await client.findSession(home, tag);
    expect(found?.id).toBe(id);

    const renamed = await client.renameSession(id, `${tag}-renamed`);
    expect(renamed.ok).toBe(true);
    expect(renamed.notFound).toBe(false);
    expect(await client.findSession(home, tag)).toBeNull();
    expect((await client.findSession(home, `${tag}-renamed`))?.id).toBe(id);

    const killed = await client.killSession(id);
    expect(killed.ok).toBe(true);
    expect(await client.findSession(home, `${tag}-renamed`)).toBeNull();
  });

  it('killSession of a dead id is the ordinary notFound race, not a failure', async () => {
    const dead = await client.killSession('00000000-0000-0000-0000-000000000000');
    expect(dead.ok).toBe(false);
    expect(dead.notFound).toBe(true);
  });

  it('evict() forgets the caches and the next probe re-answers', async () => {
    expect(await client.isAvailable()).toBe(true);
    client.evict();
    expect(await client.isAvailable()).toBe(true);
  });

  it('listWarnings is total — a list, never a throw', async () => {
    const warnings = await client.listWarnings();
    expect(Array.isArray(warnings)).toBe(true);
  });
});
