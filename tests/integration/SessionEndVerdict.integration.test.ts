import { afterAll, beforeAll, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import type { Client, ClientChannel } from 'ssh2';
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

/** The test-only debug sshd's -E log and pidfile inside its own container. */
const DEBUG_SSHD_LOG = '/tmp/sshd-3039-debug.log';
const DEBUG_SSHD_PIDFILE = '/tmp/sshd-3039.pid';

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

/**
 * Wait for `pending`, but never silently: a hang names its stage and fails
 * inside the spec's own timeout instead of burning the whole budget on a
 * bare "Test timed out" with no hint which await never resolved.
 */
async function waitFor<T>(what: string, pending: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for: ${what}`)), ms);
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The ssh2 wire-protocol writer this hazard spec injects channel requests with. */
function protocolOf(conn: Client): {
  windowChange(id: number, rows: number, cols: number, width: number, height: number): void;
  channelClose(id: number): void;
} {
  return (conn as unknown as {
    _protocol: {
      windowChange(id: number, rows: number, cols: number, width: number, height: number): void;
      channelClose(id: number): void;
    };
  })._protocol;
}

/**
 * End a victim connection without leaking it: a graceful `end()` gets a
 * bounded chance; if the timeout fires, the underlying socket is destroyed
 * for real — and if even that leaves the connection open, the error
 * propagates instead of being swallowed.
 */
async function endVictimConnection(conn: Client, closed: Promise<void>): Promise<void> {
  conn.end();
  try {
    await waitFor('the victim connection to close', closed, 5_000);
  } catch {
    conn.destroy();
    await waitFor('the victim connection to close after socket destroy', closed, 5_000);
  }
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
  let debugSshd: StartedTestContainer | undefined;

  const run = async (command: string) => execTransport(handle).exec(command);

  /** Start a session of this spec's own and attach a PTY client to it. */
  async function startAndAttach(tag: string): Promise<{ id: string; name: string; client: AttachedClient }> {
    const started = await waitFor(`a start --tag ${tag} to complete`, run(`a start --workspace ${home} --tag ${tag} --json`), 15_000);
    expect(started.exitCode, started.stderr).toBe(0);
    const id = JSON.parse(started.stdout).id as string;
    expect(id).toBeTruthy();
    const name = `${home.split('/').pop()}:${tag}`;
    const client = await waitFor(`the attach channel for ${name} to open`, attachPty(handle, cli.buildAttachCommand(name)), 15_000);
    await waitFor(`the attached client ${name} to paint (attach readiness)`, client.ready, 15_000);
    return { id, name, client };
  }

  /** The pane's verdict, taken the way the pane takes it: a fresh listing after the exit. */
  async function verdictAfterExit(id: string, tag: string): Promise<boolean> {
    const listing = await waitFor('the fresh sessions listing for the verdict', cli.listSessions(), 15_000);
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
    if (debugSshd) await debugSshd.stop();
    if (container) await container.stop();
  });

  it('a killed session reads as ENDED at its client exit — every time, so nothing re-attaches', async () => {
    for (let round = 0; round < 3; round += 1) {
      const tag = `end-${round}-${Date.now().toString(36)}`;
      const { id, client } = await startAndAttach(tag);
      const killed = await waitFor(`a kill ${id} to complete`, run(`a kill ${id}`), 15_000);
      expect(killed.exitCode, killed.stderr).toBe(0);
      const exit = await waitFor(`round ${round} channel to close at the killed session`, client.exited, 20_000);
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
    await waitFor(`a kill ${id} to complete`, run(`a kill ${id}`), 15_000);
    await waitFor('the attach client to exit at the kill', client.exited, 20_000);
    const ghost = await waitFor('the ghost attach channel to open', attachPty(handle, cli.buildAttachCommand(name)), 15_000);
    expect(ghost.remoteId).toBeGreaterThanOrEqual(0);
    const ghostExit = await waitFor('the ghost attach to exit', ghost.exited, 20_000);
    expect(ghostExit.exitCode).not.toBe(0);
    expect(await verdictAfterExit(id, tag)).toBe(false);
  }, 60_000);

  it('a client killed under a running session reads as OUTLIVED, and the session is still attachable', async () => {
    const tag = `drop-${Date.now().toString(36)}`;
    const { id, name, client } = await startAndAttach(tag);
    // Only the viewer dies: the `a attach` relay the CLI exec'd into.
    const dropped = await waitFor('pkill of the attach relay to complete', run(`pkill -KILL -f -- '[a]ttach --no-status ${id}'`), 15_000);
    expect(dropped.exitCode, dropped.stderr).toBe(0);
    await waitFor('the dropped client channel to close', client.exited, 20_000);
    expect(await verdictAfterExit(id, tag)).toBe(true);

    // The re-join the verdict allows really reaches the live workload.
    const again = await waitFor('the re-joined attach channel to open', attachPty(handle, cli.buildAttachCommand(name)), 15_000);
    const marker = `PS3039_${Date.now().toString(36)}`;
    let screen = '';
    again.channel.on('data', (chunk: Buffer) => {
      screen += chunk.toString('utf8');
    });
    await waitFor('the re-joined attach to paint (attach readiness)', again.ready, 15_000);
    again.channel.write(`echo ${marker}_$((6*7))\r`);
    for (let i = 0; i < 100 && !screen.includes(`${marker}_42`); i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(screen).toContain(`${marker}_42`);
    again.channel.close();
    await waitFor('the re-joined attach to close', again.exited, 20_000);
    await waitFor(`the cleanup a kill ${id} to complete`, run(`a kill ${id}`), 15_000);
  }, 60_000);

  it('pins the platform hazard: a channel request after the channel is gone drops the whole connection', async () => {
    // The late half runs against a disposable TEST-ONLY debug sshd — the same
    // helper image, its sshd started with LogLevel=DEBUG3 and an -E log — so
    // the pinned injection is gated on the SERVER'S OWN `channel N: free`
    // line, not on a channel-id probe. (A probe handed a different id proved
    // only that ANOTHER channel was allocated — the late channel's slot may
    // still exist — and a probe handed the id itself re-occupies it; probe
    // ids seen alternating 1,0,1,0 made exactly that ambiguity visible.)
    // The early half stays on the primary container: it pins the absorbed
    // ordering (request dispatched before our CLOSE) and needs no log.
    debugSshd = await waitFor(
      'the dedicated debug sshd container to start',
      new GenericContainer('pocketshell-core-test:helper')
        .withExposedPorts(22)
        .withCommand(['/bin/sh', '-c',
          `exec /usr/sbin/sshd -D -E ${DEBUG_SSHD_LOG} -o LogLevel=DEBUG3 -o PidFile=${DEBUG_SSHD_PIDFILE}`])
        .start(),
      60_000,
    );
    const debugHost = debugSshd.getHost();
    const debugPort = debugSshd.getMappedPort(22);
    const fixture = await waitFor(
      'the debug sshd fixture version capture',
      debugSshd.exec(['sh', '-c',
        'apk list --installed 2>/dev/null | grep -m1 ^openssh-server-; cat /etc/alpine-release; a --version 2>&1 | head -1; cat ' + DEBUG_SSHD_PIDFILE]),
      15_000,
    );
    console.log('[#3039] debug sshd fixture (openssh-server / alpine / a / listener pid):\n' + fixture.stdout.trim());

    // 1. Between the host's CLOSE and ours the channel still exists on the
    //    host: a window-change sent there is harmless.
    const earlyVictim = await waitFor(
      'the early-phase victim connection to open',
      connectSsh(container!.getHost(), container!.getMappedPort(22)),
      15_000,
    );
    const earlyErrors: string[] = [];
    earlyVictim.conn.on('error', (error: Error) => earlyErrors.push(error.message));
    const earlyVictimClosed = new Promise<void>((resolve) => earlyVictim.conn.on('close', () => resolve()));
    const earlyProtocol = protocolOf(earlyVictim.conn);
    const earlyRealClose = earlyProtocol.channelClose.bind(earlyProtocol);
    try {
      const tagEarly = `early-${Date.now().toString(36)}`;
      const early = await startAndAttachOn(earlyVictim, tagEarly);
      let sentBeforeOurClose = false;
      earlyProtocol.channelClose = (id: number) => {
        earlyProtocol.windowChange(early.remoteId, 30, 100, 0, 0);
        sentBeforeOurClose = true;
        earlyRealClose(id);
      };
      try {
        await waitFor(`a kill ${early.id} to complete`, run(`a kill ${early.id}`), 15_000);
        await waitFor('the early channel to close client-side', early.client.exited, 20_000);
      } finally {
        // The override exists only for the early channel's teardown — never
        // leak it into the late half, on a failure path either.
        earlyProtocol.channelClose = earlyRealClose;
      }
      expect(sentBeforeOurClose).toBe(true);
      const stillUp = await waitFor('the healthy probe after the early window-change', execTransport(earlyVictim).exec('echo alive'), 10_000);
      expect(stillUp.stdout.trim()).toBe('alive');
      expect(earlyErrors).toEqual([]);
    } finally {
      await endVictimConnection(earlyVictim.conn, earlyVictimClosed);
    }

    // 2. After the host reclaims the channel, the same request ends the
    //    connection — #3039's exact reconnect reason. Connections to the
    //    debug sshd are strictly SERIAL so its log regions never interleave:
    //    a controller connection starts the session and hangs up, then the
    //    victim connection carries the attach (its only PTY) and the
    //    `a kill` exec, so the late channel is ONE lifecycle of ONE id inside
    //    the victim's own log region.
    const tagLate = `late-${Date.now().toString(36)}`;
    const controller = await waitFor('the debug controller connection to open', connectSsh(debugHost, debugPort), 15_000);
    const controllerClosed = new Promise<void>((resolve) => controller.conn.on('close', () => resolve()));
    let debugHome = '';
    let lateId = '';
    try {
      debugHome = (await waitFor('the debug home capture', execTransport(controller).exec('echo $HOME'), 15_000)).stdout.trim();
      const started = await waitFor(
        `a start --tag ${tagLate} to complete (debug sshd)`,
        execTransport(controller).exec(`a start --workspace ${debugHome} --tag ${tagLate} --json`),
        15_000,
      );
      expect(started.exitCode, started.stderr).toBe(0);
      lateId = JSON.parse(started.stdout).id as string;
      expect(lateId).toBeTruthy();

      // PID correlation: a session shell's sshd ancestor chain must reach the
      // debug sshd itself — the listener whose -E log this spec is about to
      // read is the same process tree serving these connections.
      const shellPpid = (await waitFor('the session shell ppid capture', execTransport(controller).exec('echo $PPID'), 15_000)).stdout.trim();
      const chain = await waitFor(
        'the sshd ancestor chain capture',
        debugSshd.exec(['sh', '-c',
          `p=${shellPpid}; for i in 1 2 3 4; do [ -r /proc/$p/status ] || break; ` +
          'echo "$p comm=$(cat /proc/$p/comm 2>/dev/null) ppid=$(awk \'/^PPid:/{print $2}\' /proc/$p/status)"; ' +
          'p=$(awk \'/^PPid:/{print $2}\' /proc/$p/status); [ "$p" -le 1 ] 2>/dev/null && break; done']),
        15_000,
      );
      const listenerPid = (await waitFor('the debug sshd pidfile capture', debugSshd.exec(['cat', DEBUG_SSHD_PIDFILE]), 15_000)).stdout.trim();
      const chainLines = chain.stdout.trim().split('\n');
      expect(chainLines.length).toBeGreaterThanOrEqual(1);
      expect(chainLines[chainLines.length - 1]).toMatch(new RegExp(`comm=sshd ppid=${listenerPid}$`));
      expect(chainLines.filter((line) => !line.includes('comm=sshd'))).toEqual([]);
    } finally {
      await endVictimConnection(controller.conn, controllerClosed);
    }

    const lateVictim = await waitFor('the late-phase victim connection to open', connectSsh(debugHost, debugPort), 15_000);
    const lateErrors: string[] = [];
    lateVictim.conn.on('error', (error: Error) => lateErrors.push(error.message));
    const lateVictimClosed = new Promise<void>((resolve) => lateVictim.conn.on('close', () => resolve()));
    try {
      const lateName = `${debugHome.split('/').pop()}:${tagLate}`;
      const late = await waitFor(
        'the late attach channel to open',
        attachPty(lateVictim, cli.buildAttachCommand(lateName)),
        15_000,
      );
      await waitFor(`the late attached client ${tagLate} to paint (attach readiness)`, late.ready, 15_000);
      // The late channel's SERVER-side id: ssh2's outgoing.id is the id the
      // server allocated (CHANNEL_OPEN_CONFIRMATION's sender channel) — the
      // number every sshd debug line for this channel carries.
      const lateRemoteId = late.remoteId;
      const killed = await waitFor(
        `a kill ${lateId} to complete (on the victim connection)`,
        execTransport(lateVictim).exec(`a kill ${lateId}`),
        15_000,
      );
      expect(killed.exitCode, killed.stderr).toBe(0);
      const lateChannelExits = await waitFor('the late channel to close client-side', late.exited, 20_000);
      // The exit is clean (that is the #3039 premise: it cannot tell).
      expect(lateChannelExits.exitCode).toBe(0);

      // THE FREE EVIDENCE, from the server itself. The debug sshd's -E log is
      // polled over docker exec — which opens no SSH channel on the victim,
      // so nothing can re-occupy the id between the observed free and the
      // injection below — until the victim's OWN log region (the LAST
      // "Accepted publickey" region, whose client port sshd itself lists
      // ESTABLISHED) records, for exactly one lifecycle of the late id:
      //     channel <id>: rcvd close    (the host saw the client's CLOSE)
      //     channel <id>: free: ...     (the host reclaimed the slot)
      const observed = await waitFor(
        'the debug sshd to log the late channel freed (rcvd close, then free)',
        observeServerChannelFreeInLog(debugSshd, lateRemoteId),
        30_000,
      );
      console.log('[#3039] observed server-side reclamation:\n' + observed);

      // Between that log snapshot and this line the spec opens no channel on
      // the victim connection (every read went over docker exec), so no
      // channel can have re-occupied the id: the request must now find the
      // slot gone and drop the connection — the "freed" half of the pin.
      protocolOf(lateVictim.conn).windowChange(lateRemoteId, 30, 100, 0, 0);
      await waitFor('the expected disconnect (unknown-channel drop)', lateVictimClosed, 15_000);
      expect(lateErrors.join('\n')).toMatch(/server_input_channel_req: unknown channel \d+/);

      // The receipt, from the final log: in the victim's region the free sits
      // strictly between the rcvd close and the unknown-channel disconnect,
      // and NOTHING touched the id in between.
      const finalLog = await waitFor('the final debug log capture', debugSshd.exec(['cat', DEBUG_SSHD_LOG]), 15_000);
      const finalRegion = regionOfLastAcceptedConnection(finalLog.stdout);
      const rcvdAt = finalRegion.lines.findIndex((line) => line.includes(`channel ${lateRemoteId}: rcvd close`));
      const freeAt = finalRegion.lines.findIndex((line) => line.includes(`channel ${lateRemoteId}: free: `));
      const unknownAt = finalRegion.lines.findIndex((line) => line.includes('unknown channel'));
      expect(rcvdAt, 'the region records the late channel rcvd close').toBeGreaterThanOrEqual(0);
      expect(freeAt, 'the region records the late channel freed').toBeGreaterThan(rcvdAt);
      expect(unknownAt, 'the region records the unknown-channel disconnect').toBeGreaterThan(freeAt);
      const reoccupiedBetweenFreeAndDisconnect = finalRegion.lines
        .slice(freeAt + 1, unknownAt)
        .filter((line) => new RegExp(`channel ${lateRemoteId}: new\\b`).test(line));
      expect(
        reoccupiedBetweenFreeAndDisconnect,
        'no channel was allocated the id between the free and the pinned request',
      ).toEqual([]);
      console.log(
        `[#3039] final ordering in the victim's log region (offsets rcvd@${rcvdAt} < free@${freeAt} < unknown@${unknownAt}):\n` +
        `  ${finalRegion.lines[freeAt].trim()}\n  ${finalRegion.lines[unknownAt].trim()}`,
      );
    } finally {
      await endVictimConnection(lateVictim.conn, lateVictimClosed);
    }
  }, 60_000);

  async function startAndAttachOn(
    on: SshHandle,
    tag: string,
  ): Promise<{ id: string; client: AttachedClient; remoteId: number }> {
    const started = await waitFor(`a start --tag ${tag} to complete`, run(`a start --workspace ${home} --tag ${tag} --json`), 15_000);
    expect(started.exitCode, started.stderr).toBe(0);
    const id = JSON.parse(started.stdout).id as string;
    const client = await waitFor(
      `the attach channel for ${tag} to open`,
      attachPty(on, cli.buildAttachCommand(`${home.split('/').pop()}:${tag}`)),
      15_000,
    );
    await waitFor(`the attached client ${tag} to paint (attach readiness)`, client.ready, 15_000);
    return { id, client, remoteId: client.remoteId };
  }
});

/** The victim connection's log region: the LAST accepted connection to EOF. */
function regionOfLastAcceptedConnection(log: string): { lines: string[]; port: string } {
  const lines = log.split('\n');
  let lastIndex = -1;
  let port = '';
  for (let i = 0; i < lines.length; i += 1) {
    const match = /Accepted publickey for testuser from \S+ port (\d+)/.exec(lines[i]);
    if (match) {
      lastIndex = i;
      port = match[1];
    }
  }
  if (lastIndex === -1) throw new Error('the debug sshd log records no accepted connection');
  return { lines: lines.slice(lastIndex), port };
}

/**
 * Poll the debug sshd's own -E log (always over docker exec, never over the
 * victim's SSH connection) until it holds the exact per-channel reclamation
 * evidence for the late channel in the victim connection's own region:
 *
 *   channel <id>: rcvd close        the host processed the client's CLOSE
 *   channel <id>: free: ...         the host reclaimed the channel's slot
 *
 * with exactly ONE lifecycle of that id in the region, the free AFTER the
 * close, and no fresh allocation of the id after the free (the debug3 status
 * dump the free itself prints names the id too, but allocates nothing). A
 * region whose client port sshd does not list as ESTABLISHED is not the
 * victim's yet — poll on. Anything else — a second lifecycle, a re-allocated
 * id — throws: the proof must be unambiguous, never assumed. The returned
 * string quotes the exact observed lines.
 */
async function observeServerChannelFreeInLog(debugSshd: StartedTestContainer, remoteId: number): Promise<string> {
  for (;;) {
    const [logRead, established] = await Promise.all([
      debugSshd.exec(['cat', DEBUG_SSHD_LOG]),
      debugSshd.exec(['sh', '-c', "netstat -tn 2>/dev/null | grep ':22 ' | grep ESTABLISHED"]),
    ]);
    // sshd logs each connection's CLIENT port in its Accepted line; netstat
    // (read server-side, over docker exec) lists that same port for every
    // live connection — the region must be one of the live ones.
    const livePorts = established.stdout
      .split('\n')
      .filter((line) => line.includes('ESTABLISHED'))
      .map((line) => (line.trim().split(/\s+/)[4] ?? '').split(':').pop() ?? '');
    const region = regionOfLastAcceptedConnection(logRead.stdout);
    if (!livePorts.includes(region.port)) {
      await new Promise((r) => setTimeout(r, 150));
      continue;
    }
    const acceptedCount = region.lines.filter((line) => line.includes('Accepted publickey')).length;
    if (acceptedCount !== 1) {
      throw new Error(`the victim's log region holds ${acceptedCount} accepted connections, expected exactly 1`);
    }
    const rcvd = region.lines
      .map((line, offset) => ({ line, offset }))
      .filter((entry) => entry.line.includes(`channel ${remoteId}: rcvd close`));
    if (rcvd.length > 1) {
      throw new Error(
        `the victim's log region records ${rcvd.length} 'channel ${remoteId}: rcvd close' lines — ` +
        'the id was reused within the region, so the evidence would be ambiguous',
      );
    }
    if (rcvd.length === 0) {
      await new Promise((r) => setTimeout(r, 150));
      continue;
    }
    const freeOffset = region.lines.findIndex((line) => line.includes(`channel ${remoteId}: free: `));
    if (freeOffset === -1) {
      await new Promise((r) => setTimeout(r, 150));
      continue;
    }
    if (freeOffset < rcvd[0].offset) {
      throw new Error(
        `the free line (offset ${freeOffset}) precedes the rcvd close (offset ${rcvd[0].offset}) — ` +
        'a stale lifecycle, not the late channel\'s reclamation',
      );
    }
    // A re-occupation of the slot shows up as a fresh allocation of the id
    // ("channel <id>: new session ..."). The debug3 status dump that the free
    // itself prints ("channel <id>: status: The following connections are
    // open:") names the id but is part of the free event, not a new channel.
    const reoccupied = region.lines
      .slice(freeOffset + 1)
      .filter((line) => new RegExp(`channel ${remoteId}: new\\b`).test(line));
    if (reoccupied.length > 0) {
      throw new Error(
        `the id ${remoteId} was allocated again after its free line: ${JSON.stringify(reoccupied)} — ` +
        'a channel re-occupied the slot before the pinned request',
      );
    }
    return (
      `victim region (client port ${region.port}, ${region.lines.length} lines): ` +
      `rcvd close @${rcvd[0].offset} < free @${freeOffset}; no allocation of id ${remoteId} after the free\n` +
      `  ${rcvd[0].line.trim()}\n  ${region.lines[freeOffset].trim()}`
    );
  }
}
