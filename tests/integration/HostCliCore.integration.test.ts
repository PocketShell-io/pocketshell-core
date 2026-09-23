import { afterAll, beforeAll, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import {
  HostCliCore,
  HostCliFailed,
  type HostCliExecOutcome,
  type HostCliTransport,
} from '../../src/index';
import { connectSsh, describeDocker, type SshHandle } from './helpers';

/** The Android host-cli boundary, driven through SSH to the pinned real CLI image. */
function sshHostCliTransport(handle: SshHandle): HostCliTransport {
  return {
    exec(command: string, timeoutMs: number): Promise<HostCliExecOutcome> {
      return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let stream: { close(): void } | undefined;
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          stream?.close();
          resolve({ exitCode: null, stdout, stderr, timedOut: true });
        }, timeoutMs);

        handle.conn.exec(command, (error, channel) => {
          if (settled) {
            channel?.close();
            return;
          }
          if (error) {
            settled = true;
            clearTimeout(timer);
            reject(error);
            return;
          }
          stream = channel;
          channel.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
          channel.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
          channel.on('close', (exitCode: number | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ exitCode, stdout, stderr });
          });
        });
      });
    },
  };
}

async function expectPinnedCliVersion(transport: HostCliTransport): Promise<void> {
  const outcome = await transport.exec('pocketshell --version', 5_000);
  expect(outcome.exitCode).toBe(0);
  expect(outcome.stdout.trim()).toBe('pocketshell, version 0.5.8');
}

describeDocker('HostCliCore integration (core-owned image, published pocketshell 0.5.8)', () => {
  let container: StartedTestContainer | undefined;
  let handle: SshHandle | undefined;
  let core: HostCliCore;
  let transport: HostCliTransport;

  beforeAll(async () => {
    container = await new GenericContainer('pocketshell-core-test:helper')
      .withExposedPorts(22)
      .start();
    handle = await connectSsh(container.getHost(), container.getMappedPort(22));
    transport = sshHostCliTransport(handle);
    core = new HostCliCore(transport);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }, 120_000);

  afterAll(async () => {
    handle?.close();
    if (container) await container.stop();
  });

  it('lists the real seeded sessions, preserves create idempotency, and kills by exact display name', async () => {
    await expectPinnedCliVersion(transport);
    const listing = await core.listSessions();
    const names = listing.sessions.map((session) => session.name);
    expect(names).toEqual(expect.arrayContaining(['testuser:main', 'testuser:build']));
    expect(listing.errors).toEqual([]);

    const reused = await core.createSession('main', { cwd: '/home/testuser' });
    expect(reused).toMatchObject({ name: 'testuser:main', created: false });
    expect(reused.id).toBeTruthy();

    // The name begins with an option marker. The real CLI must receive it as
    // a positional session name, then return its structured create failure
    // (this image intentionally has no systemd user manager).
    await expect(core.createSession('--help', { cwd: '/home/testuser' }))
      .rejects.toMatchObject<Partial<HostCliFailed>>({
        kind: 'failed',
        exitCode: 127,
        message: expect.stringContaining('systemd-run'),
      });

    expect(core.buildAttachCommand("it's a test")).toBe(
      "exec pocketshell sessions attach -- 'it'\\''s a test'",
    );

    await expect(core.listWarnings()).rejects.toMatchObject<Partial<HostCliFailed>>({
      exitCode: 2,
      stderr: expect.stringContaining("No such command 'warnings'"),
    });
    await expect(core.ackWarnings('main')).rejects.toMatchObject<Partial<HostCliFailed>>({
      exitCode: 2,
      stderr: expect.stringContaining("No such command 'ack'"),
    });

    await core.killSession('testuser:main');
    const afterKill = await core.listSessions();
    expect(afterKill.sessions.map((session) => session.name)).not.toContain('testuser:main');
  }, 60_000);

  it('round-trips workspace identity containing quote, newline, Unicode, and shell syntax', async () => {
    await expectPinnedCliVersion(transport);
    const host = "fixture host ' Ω\n$(touch /tmp/hostcli-shell-injection)";
    const path = "/home/testuser/project ' one\nΩ";
    const added = await core.addWorkspace(host, path);
    expect(added.workspaces).toEqual([{ path, displayPath: path }]);

    const listed = await core.listWorkspaces(host);
    expect(listed.workspaces).toEqual([{ path, displayPath: path }]);

    const noInjection = await transport.exec('test ! -e /tmp/hostcli-shell-injection', 5_000);
    expect(noInjection.exitCode).toBe(0);

    expect((await core.removeWorkspace(host, path)).workspaces).toEqual([]);
  }, 30_000);

  it('reads real engine and profile catalogs from the published host CLI', async () => {
    await expectPinnedCliVersion(transport);
    const engines = await core.listEngines();
    expect(engines.map((engine) => engine.id)).toContain('claude');
    expect(engines.find((engine) => engine.id === 'claude')).toMatchObject({
      label: 'Claude',
      available: true,
      availableForCreate: true,
    });

    const profiles = await core.listProfiles();
    expect(profiles).toEqual([]);
  }, 30_000);

});
