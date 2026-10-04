import { afterAll, beforeAll, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import type { ClientChannel } from 'ssh2';
import {
  HostCliCore,
  sessionOutlivedClient,
  sessionRowToSummary,
  type HostCliTransport,
} from '../../src/index';
import { connectSsh, describeDocker, execTransport, type SshHandle } from './helpers';

/**
 * #3039 on a real host: the published pocketshell CLI (0.5.8), real `a`
 * (aplexer) and a real OpenSSH sshd, with ssh2 playing the platform's PTY
 * transport.
 *
 * An aplexer pane's PTY runs an attach CLIENT. When it exits, a killed
 * session and a dropped client look the same from the transport — a clean
 * exit on a healthy connection. The pane's silent re-join (781c52d) took
 * every such exit for a dropped client and re-attached; on a real session
 * end that re-attach raced the dead session's channel teardown into
 * `server_input_channel_req: unknown channel 0` and a full reconnect.
 *
 * Here the two orderings are produced for real and the verdict the pane now
 * uses (`sessionOutlivedClient` over a fresh `sessions list` taken AFTER the
 * client's exit) is checked against each: a kill reads as ended, a client
 * killed under a running session reads as outlived and that session is still
 * attachable. The last spec pins the platform hazard itself — what the host
 * does with a channel request that reaches it after the channel is gone, and
 * that one sent before the client's own CLOSE is harmless — which is the
 * contract every platform's PTY transport must keep (the Android plugin's
 * guard, #3039).
 */

interface AttachedClient {
  channel: ClientChannel;
  /** The server's channel number for this PTY. */
  remoteId: number;
  /** Resolves on the client's first output (aplexer's attach repaint): it is up. */
  ready: Promise<void>;
  /** Resolves once both sides have closed the channel (the client exited). */
  exited: Promise<{ exitCode: number | null; at: number }>;
}

function attachPty(handle: SshHandle, command: string): Promise<AttachedClient> {
  return new Promise((resolve, reject) => {
    handle.conn.exec(command, { pty: { cols: 80, rows: 24, term: 'xterm-256color' } }, (error, channel) => {
      if (error) return reject(error);
      let exitCode: number | null = null;
      const ready = new Promise<void>((up) => channel.once('data', () => up()));
      channel.on('data', () => undefined);
      channel.stderr.on('data', () => undefined);
      channel.on('exit', (code: number | null) => {
        exitCode = code;
      });
      const exited = new Promise<{ exitCode: number | null; at: number }>((done) => {
        channel.on('close', () => done({ exitCode, at: Date.now() }));
      });
      resolve({ channel, remoteId: (channel as unknown as { outgoing: { id: number } }).outgoing.id, ready, exited });
    });
  });
}

function hostCliTransport(handle: SshHandle): HostCliTransport {
  const exec = execTransport(handle);
  return { exec: (command: string) => exec.exec(command) };
}

describeDocker('session-end verdict on a real aplexer host (#3039)', () => {
  let container: StartedTestContainer | undefined;
  let handle: SshHandle;
  let cli: HostCliCore;
  let home: string;

  const run = async (command: string) => execTransport(handle).exec(command);

  /** Start a session of this spec's own and attach a PTY client to it. */
  async function startAndAttach(tag: string): Promise<{ id: string; name: string; client: AttachedClient }> {
    const started = await run(`a start --workspace ${home} --tag ${tag} --json`);
    expect(started.exitCode, started.stderr).toBe(0);
    const id = JSON.parse(started.stdout).id as string;
    expect(id).toBeTruthy();
    const name = `${home.split('/').pop()}:${tag}`;
    const client = await attachPty(handle, cli.buildAttachCommand(name));
    await client.ready;
    return { id, name, client };
  }

  /** The pane's verdict, taken the way the pane takes it: a fresh listing after the exit. */
  async function verdictAfterExit(id: string, tag: string): Promise<boolean> {
    const listing = await cli.listSessions();
    return sessionOutlivedClient(listing.sessions.map(sessionRowToSummary), {
      sessionName: tag,
      workspace: home,
      aplexerId: id,
    });
  }

  beforeAll(async () => {
    container = await new GenericContainer('pocketshell-core-test:helper')
      .withExposedPorts(22)
      .start();
    handle = await connectSsh(container.getHost(), container.getMappedPort(22));
    cli = new HostCliCore(hostCliTransport(handle));
    home = (await run('echo $HOME')).stdout.trim();
    await new Promise((r) => setTimeout(r, 1_500));
  }, 120_000);

  afterAll(async () => {
    handle?.close();
    if (container) await container.stop();
  });

  it('a killed session reads as ENDED at its client exit — every time, so nothing re-attaches', async () => {
    for (let round = 0; round < 3; round += 1) {
      const tag = `end-${round}-${Date.now().toString(36)}`;
      const { id, client } = await startAndAttach(tag);
      const killed = await run(`a kill ${id}`);
      expect(killed.exitCode, killed.stderr).toBe(0);
      const exit = await client.exited;
      // The killed session's client exits cleanly: the exit alone cannot tell.
      expect(exit.exitCode).toBe(0);
      expect(await verdictAfterExit(id, tag)).toBe(false);
    }
  }, 90_000);

  it('probing by attaching cannot tell: an attach to the killed session OPENS, and only then exits', async () => {
    // 781c52d's verdict was "attach again and see": a failure to open meant
    // the session was gone. On a real host the PTY of a dead session's
    // attach opens fine — the transport cannot know — and its client exits a
    // moment later, which is the window the pane pushed geometry into.
    const tag = `probe-${Date.now().toString(36)}`;
    const { id, name, client } = await startAndAttach(tag);
    await run(`a kill ${id}`);
    await client.exited;
    const ghost = await attachPty(handle, cli.buildAttachCommand(name));
    expect(ghost.remoteId).toBeGreaterThanOrEqual(0);
    const ghostExit = await ghost.exited;
    expect(ghostExit.exitCode).not.toBe(0);
    expect(await verdictAfterExit(id, tag)).toBe(false);
  }, 60_000);

  it('a client killed under a running session reads as OUTLIVED, and the session is still attachable', async () => {
    const tag = `drop-${Date.now().toString(36)}`;
    const { id, name, client } = await startAndAttach(tag);
    // Only the viewer dies: the `a attach` relay the CLI exec'd into.
    const dropped = await run(`pkill -KILL -f -- '[a]ttach --no-status ${id}'`);
    expect(dropped.exitCode, dropped.stderr).toBe(0);
    await client.exited;
    expect(await verdictAfterExit(id, tag)).toBe(true);

    // The re-join the verdict allows really reaches the live workload.
    const again = await attachPty(handle, cli.buildAttachCommand(name));
    const marker = `PS3039_${Date.now().toString(36)}`;
    let screen = '';
    again.channel.on('data', (chunk: Buffer) => {
      screen += chunk.toString('utf8');
    });
    await again.ready;
    again.channel.write(`echo ${marker}_$((6*7))\r`);
    for (let i = 0; i < 100 && !screen.includes(`${marker}_42`); i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(screen).toContain(`${marker}_42`);
    again.channel.close();
    await again.exited;
    await run(`a kill ${id}`);
  }, 60_000);

  it('pins the platform hazard: a channel request after the channel is gone drops the whole connection', async () => {
    // A second connection of its own: this spec ends it on purpose.
    const victim = await connectSsh(container!.getHost(), container!.getMappedPort(22));
    const errors: string[] = [];
    victim.conn.on('error', (error: Error) => errors.push(error.message));
    const closed = new Promise<void>((resolve) => victim.conn.on('close', () => resolve()));
    const protocol = (victim.conn as unknown as {
      _protocol: { windowChange(id: number, rows: number, cols: number, h: number, w: number): void; channelClose(id: number): void };
    })._protocol;

    // 1. Between the host's CLOSE and ours the channel still exists on the
    //    host: a window-change sent there is harmless.
    const tagEarly = `early-${Date.now().toString(36)}`;
    const early = await startAndAttachOn(victim, tagEarly);
    const realClose = protocol.channelClose.bind(protocol);
    let sentBeforeOurClose = false;
    protocol.channelClose = (id: number) => {
      protocol.windowChange(early.remoteId, 30, 100, 0, 0);
      sentBeforeOurClose = true;
      realClose(id);
    };
    await run(`a kill ${early.id}`);
    await early.client.exited;
    protocol.channelClose = realClose;
    expect(sentBeforeOurClose).toBe(true);
    const stillUp = await execTransport(victim).exec('echo alive');
    expect(stillUp.stdout.trim()).toBe('alive');
    expect(errors).toEqual([]);

    // 2. After both CLOSEs the host has freed the channel: the same request
    //    now ends the connection — #3039's exact reconnect reason.
    const tagLate = `late-${Date.now().toString(36)}`;
    const late = await startAndAttachOn(victim, tagLate);
    await run(`a kill ${late.id}`);
    await late.client.exited;
    protocol.windowChange(late.remoteId, 30, 100, 0, 0);
    await closed;
    expect(errors.join('\n')).toMatch(/server_input_channel_req: unknown channel \d+/);
  }, 60_000);

  async function startAndAttachOn(
    on: SshHandle,
    tag: string,
  ): Promise<{ id: string; client: AttachedClient; remoteId: number }> {
    const started = await run(`a start --workspace ${home} --tag ${tag} --json`);
    expect(started.exitCode, started.stderr).toBe(0);
    const id = JSON.parse(started.stdout).id as string;
    const client = await attachPty(on, cli.buildAttachCommand(`${home.split('/').pop()}:${tag}`));
    await client.ready;
    return { id, client, remoteId: client.remoteId };
  }
});
