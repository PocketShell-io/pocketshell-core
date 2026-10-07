import { afterAll, beforeAll, expect, it } from 'vitest';
import { GenericContainer, type ExecResult, type StartedTestContainer } from 'testcontainers';
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
 *
 * Five more specs pin the fixture lifecycle this file owns: a container
 * start that resolves only after its teardown bound still gets stopped by
 * the retained late-start finalizer; an exec that outlives its bound is
 * terminated for real — the fixture owning the process stopped, the
 * outstanding RPC tracked to settlement — because a raced bound cancels
 * nothing; and a fixture's stop request is ONE memoized attempt whose
 * ACTUAL outcome every caller shares — a stop that failed stays a failure
 * for the repeated cleanup, concurrent callers wait out the pending attempt
 * instead of being handed a fabricated ok, and a request that arrives
 * before the start resolved waits for the real container instead of
 * inventing an answer and stranding it. The controlled-stop regressions
 * never let a controlled outcome hold the real cleanup hostage: each has a
 * PHYSICAL owner over the same real startup — registered with afterAll
 * before the start is even awaited, stopping with the real stop RPC — and
 * an exit guard that runs on EVERY path, so a controlled failure, a held
 * stop, an assertion abort, or a start that outlives its spec still ends
 * with the real container stopped. Two specs drive that guard with a
 * simulated assertion abort — one before a held stop is released, one
 * while the startup is still pending — and prove the real outcome: the
 * owned fixture gone, refusing execs.
 */

/** The test-only debug sshd's -E log and pidfile inside its own container. */
const DEBUG_SSHD_LOG = '/tmp/sshd-3039-debug.log';
const DEBUG_SSHD_PIDFILE = '/tmp/sshd-3039.pid';

/**
 * Stage budgets (ms). Every await in the platform-hazard spec is one bounded,
 * named stage, and the spec's total timeout is the mechanical sum of its
 * stage budgets (`HAZARD_STAGE_BUDGET_TOTAL` below) — so no stage, a cold
 * container start included, can outrun the total and die mid-flight. The old
 * shape (a 60s spec total containing a 60s container-start stage) let a cold
 * start eat the whole budget with the fixture never assigned and never
 * stopped; this shape cannot, and the afterAll cleanup budget is separate
 * from the spec total.
 */
const CONTAINER_START_BUDGET = 45_000; // any test-container cold start (primary helper, debug sshd)
const DEBUG_CAPTURE_BUDGET = 15_000; // fixture versions, debug home, shell ppid, ancestor chain, listener pidfile, final log
const SSH_CONNECT_BUDGET = 15_000; // each victim/controller ssh connection
const SESSION_START_BUDGET = 15_000; // each `a start`
const ATTACH_OPEN_BUDGET = 15_000; // each attach channel opening
const ATTACH_PAINT_BUDGET = 15_000; // each attach readiness repaint
const KILL_BUDGET = 15_000; // each `a kill`
const CHANNEL_EXIT_BUDGET = 20_000; // each channel close observed client-side
const HEALTHY_PROBE_BUDGET = 10_000; // the early half's post-injection probe
const VICTIM_CLOSE_BUDGET = 5_000; // per endVictimConnection attempt (graceful, then forced)
const OBSERVE_FREE_BUDGET = 30_000; // the free-observation poller's internal deadline
const DEBUG_EXEC_BUDGET = 10_000; // each docker exec inside the poller, clamped to the deadline's remainder
const DEBUG_EXEC_FLOOR = 1_000; // never start a poll exec with less left than this: below it the deadline fires
const DISCONNECT_BUDGET = 15_000; // the pinned unknown-channel drop
const NEGATIVE_DEADLINE_BUDGET = 2_000; // the deadline the negative regression must see honored
const NEGATIVE_GUARD_BUDGET = 10_000; // outer guard: a reverted unbounded poller fails here in seconds
const CLEANUP_STAGE_BUDGET = 20_000; // each bounded afterAll step (settle a start, stop a container)
const EXEC_STRAGGLER_SETTLE_BUDGET = 10_000; // bounded settle of execs still outstanding once their fixture was stopped
const TEARDOWN_PROOF_BOUND_MS = 50; // the late-start regression's deliberately-early teardown settle bound
const FINALIZER_RECORD_BUDGET = 15_000; // the retained late-start finalizer's bounded stop, observed via its note
const EXEC_TIMEOUT_REGRESSION_DEADLINE = 5_000; // the exec-timeout regression's poller deadline (the wedged sleep outlives it)
/** Explicit slack over the exec-timeout guard's composed worst path: the
 * poll loop's own overhead (poll sleeps, RPC latencies inside their bounds)
 * on top of the named budgets the guard is composed from. */
const EXEC_TIMEOUT_GUARD_SLACK = 5_000;
/** Outer guard around the exec-timeout regression's self-bounding poller,
 * COMPOSED from the poller's full permitted path — its own deadline (the
 * stage bound that fires) plus the abnormal-path cleanup it is then
 * PERMITTED to run (the owning fixture's stop, the bounded settle of the
 * outstanding execs) — plus explicit slack. A guard set below that sum is
 * exactly the outer race it exists to prevent: it returns while a permitted
 * cleanup observer is still running. (The old 20s literal sat below the
 * permitted 5+20+10=35s — that inversion is why this is composed, never
 * restated as a literal.) */
const EXEC_TIMEOUT_GUARD_BUDGET =
  EXEC_TIMEOUT_REGRESSION_DEADLINE + CLEANUP_STAGE_BUDGET + EXEC_STRAGGLER_SETTLE_BUDGET + EXEC_TIMEOUT_GUARD_SLACK;
const STOP_MEMOIZATION_HOLD_MS = 500; // how long the controlled stop RPC is held pending before its real outcome is released
const STOP_MEMOIZATION_PROBE_BUDGET = 2_000; // the bounded proof that concurrent stop callers are still waiting while the RPC is held
/** The regression exit guard's worst path: a start still pending when the
 * body aborted (its full start budget), then the bounded physical stop. */
const REGRESSION_EXIT_GUARD_BUDGET = CONTAINER_START_BUDGET + CLEANUP_STAGE_BUDGET;
const APLEXER_SETTLE_MS = 1_500; // the pre-existing settle sleep after the primary ssh is up

/** The hazard spec's total: the exact sum of the stage budgets its body can
 * spend — a stage can never exceed the total, and the total exists only so
 * every stage gets its full bound before vitest would kill the spec. */
const HAZARD_STAGE_BUDGET_TOTAL =
  CONTAINER_START_BUDGET + // the debug sshd container's cold start
  6 * DEBUG_CAPTURE_BUDGET + // fixture versions, debug home, shell ppid, ancestor chain, listener pidfile, final log
  3 * SSH_CONNECT_BUDGET + // early victim, debug controller, late victim
  2 * SESSION_START_BUDGET + // `a start` on the primary, `a start` on the debug sshd
  2 * ATTACH_OPEN_BUDGET + // early attach, late attach
  2 * ATTACH_PAINT_BUDGET + // early repaint, late repaint
  2 * KILL_BUDGET + // `a kill` on the primary, `a kill` on the victim connection
  2 * CHANNEL_EXIT_BUDGET + // early channel, late channel
  HEALTHY_PROBE_BUDGET + // the early half's healthy probe
  6 * VICTIM_CLOSE_BUDGET + // three victim connections, each graceful + forced worst case
  OBSERVE_FREE_BUDGET + // the poller's internal deadline
  DISCONNECT_BUDGET + // the pinned unknown-channel drop
  NEGATIVE_DEADLINE_BUDGET + NEGATIVE_GUARD_BUDGET + // the negative timeout regression
  2 * (DEBUG_EXEC_BUDGET + CLEANUP_STAGE_BUDGET + EXEC_STRAGGLER_SETTLE_BUDGET); // each free-observation's worst abnormal path, in full: an exec stage bound (≤ DEBUG_EXEC_BUDGET) fires, the owned fixture is stopped (CLEANUP_STAGE_BUDGET), and the outstanding execs settle (EXEC_STRAGGLER_SETTLE_BUDGET) — the main observation and the negative regression can each pay this

/** The late-start regression's total: the exact sum of the stages its body can spend. */
const LATE_START_REGRESSION_TOTAL =
  TEARDOWN_PROOF_BOUND_MS + // the teardown settle bound that fires before the real start can resolve
  CONTAINER_START_BUDGET + // the real start, awaited only after the bound fired
  FINALIZER_RECORD_BUDGET + // the retained finalizer's bounded stop, observed via its note
  DEBUG_CAPTURE_BUDGET; // the exec-must-refuse outcome proof

/** The exec-timeout regression's total: the exact sum of the stages its body can spend. The
 * poller's abnormal path is NOT restated here — the guard above is already composed from the
 * full permitted path (deadline + stop + settle + slack), so restating its parts would
 * double-count them. */
const EXEC_TIMEOUT_REGRESSION_TOTAL =
  CONTAINER_START_BUDGET + // the regression's own container
  EXEC_TIMEOUT_GUARD_BUDGET + // outer guard around the self-bounding poller: its deadline, permitted stop+settle, and slack
  DEBUG_CAPTURE_BUDGET; // the exec-must-refuse outcome proof

/** The failed-stop regression's total: the exact sum of the stages its body can spend. The
 * memoized repeats (repeated/after-the-fact callers, the teardown's view) are the same settled
 * promise — no stage of their own to budget. */
const FAILED_STOP_REGRESSION_TOTAL =
  CONTAINER_START_BUDGET + // the start stage
  CLEANUP_STAGE_BUDGET + // the controlled stop attempt's bounded stage (its injected RPC rejects there)
  REGRESSION_EXIT_GUARD_BUDGET + // the exit guard: the physical stop, or a pending start + stop on an abort path
  DEBUG_CAPTURE_BUDGET; // the exec-must-refuse outcome proof

/** The held-stop regression's total: the exact sum of the stages its body can spend. */
const HELD_STOP_REGRESSION_TOTAL =
  CONTAINER_START_BUDGET + // the start stage
  STOP_MEMOIZATION_PROBE_BUDGET + // the bounded while-held probe
  CLEANUP_STAGE_BUDGET + // the released attempt's settle stage (the physical owner's real stop)
  REGRESSION_EXIT_GUARD_BUDGET + // the exit guard: release (idempotent) + the physical stop
  DEBUG_CAPTURE_BUDGET; // the exec-must-refuse outcome proof

/** The abort-before-release regression's total: the exact sum of the stages its body can spend. */
const ABORT_BEFORE_RELEASE_REGRESSION_TOTAL =
  CONTAINER_START_BUDGET + // the start stage
  STOP_MEMOIZATION_PROBE_BUDGET + // the bounded while-held probe (the abort fires inside it)
  REGRESSION_EXIT_GUARD_BUDGET + // the exit guard: release + the physical stop, under an aborting body
  CLEANUP_STAGE_BUDGET + // both held callers settling at the released outcome, observed after the abort propagated
  DEBUG_CAPTURE_BUDGET; // the exec-must-refuse outcome proof

/** The startup-after-abort regression's total: the exact sum of the stages its body can spend.
 * The exit guard IS the spec's wait — it rides out the pending start, then stops. */
const STARTUP_AFTER_ABORT_REGRESSION_TOTAL =
  REGRESSION_EXIT_GUARD_BUDGET + // the abort, then the guard's pending-start ride-out + bounded stop
  DEBUG_CAPTURE_BUDGET; // the exec-must-refuse outcome proof

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
 *
 * The race CANCELS NOTHING. When the bound fires, `pending` keeps running to
 * whatever its natural end is — for a docker exec that is an RPC nobody can
 * revoke — and the `.catch` below is suppression of a late REJECTION, not
 * termination: it exists so a race loser can never surface as an unhandled
 * rejection, nothing more. Actual termination of an owned process happens by
 * real means elsewhere: an in-container `timeout` around the poller's
 * commands, and the owning fixture stopped when an exec's stage bound fires.
 */
async function waitFor<T>(what: string, pending: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for: ${what}`)), ms);
  });
  // Marks a possible race loser handled — a late rejection must never become
  // an unhandled one. This does NOT stop the loser; see above.
  pending.catch(() => undefined);
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
    await waitFor('the victim connection to close', closed, VICTIM_CLOSE_BUDGET);
  } catch {
    conn.destroy();
    await waitFor('the victim connection to close after socket destroy', closed, VICTIM_CLOSE_BUDGET);
  }
}

/** What a stop request concluded, always spelled out — never swallowed. */
interface OwnedStop {
  ok: boolean;
  note: string;
}

/**
 * The stop RPC a fixture's `requestStop` invokes once: the real container
 * stop by default; the controlled-stop regressions inject one with a
 * controlled ACTUAL outcome — a genuine failure, or the real stop released
 * late — so the memoization contract can be pinned without harming the
 * daemon. The container itself is never a mock: only the stop RPC's outcome
 * is the controlled variable.
 */
interface OwnedFixtureOps {
  stopRpc(up: StartedTestContainer): Promise<unknown>;
}

/**
 * One container this file started, owned from the moment its (real) start
 * promise exists — not from the moment it came up. `requestStop` is the
 * fixture's single stop attempt: whoever asks first (teardown cleanup, the
 * poller terminating a wedged exec, the retained finalizer) names the
 * reason, the attempt is bounded, and its ACTUAL outcome — the memoized
 * `OwnedStop`, success or failure alike — is what EVERY caller awaits. So a
 * stop that failed stays a failure for the repeated cleanup (afterAll
 * reports the leak admission it is, never a fabricated ok), a caller
 * arriving while the attempt is still pending waits for its real outcome,
 * and a request that arrives before the start resolved invents nothing: the
 * attempt waits for the real container and stops it once it is up.
 */
interface OwnedFixture {
  what: string;
  /** The container's REAL start promise, kept even when every await on it
   * has already timed out: the retained finalizer still owns it. */
  startup: Promise<StartedTestContainer>;
  /** The container, once its start resolved (set by whoever awaited it, and
   * by the stop attempt once the start settled under it). */
  up: StartedTestContainer | undefined;
  /** True from the moment the single stop attempt EXISTS — not proof that
   * the stop succeeded, or even that it has finished. */
  stopRequested: boolean;
  /** The retained finalizer's outcome once it ran (undefined until then). */
  finalizerNote: string | undefined;
  requestStop(reason: string): Promise<OwnedStop>;
}

function ownFixture(what: string, startup: Promise<StartedTestContainer>, ops?: OwnedFixtureOps): OwnedFixture {
  const fixture: OwnedFixture = {
    what,
    startup,
    up: undefined,
    stopRequested: false,
    finalizerNote: undefined,
    requestStop,
  };
  // The ONE real stop attempt, created by the first requestStop and memoized:
  // every later caller is handed this same promise, so all of them await the
  // same actual outcome. The attempt carries the first requester's reason.
  let stopAttempt: Promise<OwnedStop> | undefined;
  function requestStop(reason: string): Promise<OwnedStop> {
    if (stopAttempt) {
      return stopAttempt;
    }
    fixture.stopRequested = true;
    stopAttempt = (async (): Promise<OwnedStop> => {
      // A request that arrives before the start resolved waits for the real
      // container instead of answering on the spot: a pre-startup answer
      // would either invent an outcome or mark the request served and strand
      // the container that eventually comes up. A start that REJECTED is
      // said plainly: nothing came up, nothing could be stopped.
      let up: StartedTestContainer;
      try {
        up = fixture.up ?? (await fixture.startup);
      } catch (error) {
        return {
          ok: false,
          note: `${what}: stop requested (${reason}) but its start rejected, so nothing came up to stop: ${(error as Error).message}`,
        };
      }
      fixture.up = up;
      try {
        await waitFor(`${what} to stop (${reason})`, (ops?.stopRpc ?? ((upContainer: StartedTestContainer) => upContainer.stop()))(up), CLEANUP_STAGE_BUDGET);
        return { ok: true, note: `${what}: stopped (${reason})` };
      } catch (error) {
        return { ok: false, note: `${what}: stop FAILED (${reason}): ${(error as Error).message}` };
      }
    })();
    return stopAttempt;
  }
  return fixture;
}

/**
 * The retained late-start finalizer. Attached only when teardown's settle
 * bound fired while the start was still pending (or had rejected): whenever
 * the start EVENTUALLY settles — long after the hook returned — the container
 * still gets its stop requested, and the outcome is recorded under the
 * fixture's ownership label instead of leaking silently. Best effort by
 * nature, stated plainly: it runs while this runner is alive to observe the
 * settle; the stop itself is bounded (CLEANUP_STAGE_BUDGET) and one that
 * never completes is recorded as the leak it is — under a permanently
 * unresponsive docker daemon no in-test mechanism can force a stop RPC
 * through, and none is claimed.
 */
function retainLateStartFinalizer(fixture: OwnedFixture): void {
  fixture.startup.then(
    async (up) => {
      fixture.up = up;
      const stop = await fixture.requestStop(
        'the retained late-start finalizer: the start resolved after its cleanup bound had fired',
      );
      fixture.finalizerNote = stop.note;
      (stop.ok ? console.log : console.error)(`[#3039 owned fixture | late-start finalizer] ${stop.note}`);
    },
    (error) => {
      fixture.finalizerNote = `${fixture.what}: the retained start rejected, so nothing came up to stop: ${(error as Error).message}`;
      console.error(`[#3039 owned fixture | late-start finalizer] ${fixture.finalizerNote}`);
    },
  );
}

/**
 * afterAll's per-fixture step: settle the start within `boundMs`, then stop
 * what came up — both bounded, both spelled out. If the settle bound fires
 * first, the retained late-start finalizer takes ownership of the eventual
 * settle and the returned note says so: the hook still fails, and the
 * container that comes up later cannot become a silent leak.
 */
async function settleAndStopWithin(fixture: OwnedFixture, boundMs: number): Promise<string> {
  let up: StartedTestContainer;
  try {
    up = await waitFor(`${fixture.what} to come up for its cleanup`, fixture.startup, boundMs);
  } catch (error) {
    retainLateStartFinalizer(fixture);
    return `${fixture.what} cleanup: did not come up in time for its cleanup (${(error as Error).message}); ` +
      'the retained late-start finalizer now owns its eventual settle';
  }
  fixture.up = up;
  const stop = await fixture.requestStop('the teardown cleanup');
  return stop.ok ? '' : `${fixture.what} cleanup: ${stop.note}`;
}

/**
 * The controlled-stop regressions' held stop: a seam whose stop RPC is a
 * controlled operation that stays PENDING until released — and whose
 * release hands the waiting callers the physical owner's REAL stop outcome
 * (rejecting if it failed), so the one real stop RPC belongs to the
 * physical owner and the controlled callers share its actual outcome
 * instead of starting a second stop RPC of their own. `releaseOnce` is
 * idempotent: a body that already released and an exit guard releasing on
 * the way out compose into exactly one release.
 */
interface HeldStopSeam {
  stopRpc(up: StartedTestContainer): Promise<unknown>;
  releaseOnce(): void;
}

function heldStopSeam(physical: OwnedFixture, onInvoke: () => void): HeldStopSeam {
  let releaseHeld: (outcome: Promise<unknown>) => void = () => undefined;
  const held = new Promise<unknown>((resolve) => {
    releaseHeld = resolve;
  });
  let released = false;
  return {
    stopRpc: () => {
      onInvoke();
      return held;
    },
    releaseOnce: () => {
      if (released) {
        return;
      }
      released = true;
      releaseHeld(
        physical.requestStop('the real stop the held controlled callers share').then((outcome) => {
          if (!outcome.ok) {
            throw new Error(outcome.note);
          }
          return outcome;
        }),
      );
    },
  };
}

/**
 * The regression exit guard, ALWAYS on the way out of a controlled-stop
 * regression — body failure or not. It requests the physical owner's stop
 * (memoized: the guard, a release, and afterAll all await the SAME
 * attempt, so no path can race into a second stop RPC), releases any held
 * controlled operation, and awaits the attempt under a bound covering its
 * worst path — a start still pending when the body aborted, then the
 * bounded stop.
 *
 * Failure honesty: when the body FAILED, the guard never throws — the
 * body's error (the injected failure under test) must stay the spec's
 * failure, and a physical stop that failed or outlived its bound is
 * recorded loudly here AND re-reported by afterAll, which owns the same
 * memoized attempt. When the body SUCCEEDED, a failed guard throws: a
 * real leak may never read as green.
 */
async function regressionExitGuard(physical: OwnedFixture, bodyFailure: unknown, releaseHeld?: () => void): Promise<void> {
  const stopAttempt = physical.requestStop('the regression exit guard');
  releaseHeld?.();
  let outcome: OwnedStop;
  try {
    outcome = await waitFor(`the exit guard's physical stop of ${physical.what}`, stopAttempt, REGRESSION_EXIT_GUARD_BUDGET);
  } catch (boundError) {
    const admission = `${physical.what}: the exit guard's bounded stop did not settle within ` +
      `${REGRESSION_EXIT_GUARD_BUDGET}ms (${(boundError as Error).message}); afterAll owns the same memoized attempt`;
    if (bodyFailure === undefined) {
      throw new Error(admission);
    }
    console.error(`[#3039 owned fixture | exit guard] ${admission}`);
    return;
  }
  if (outcome.ok) {
    return;
  }
  const admission = `${physical.what}: the exit guard's physical stop FAILED — the container leaked: ${outcome.note}`;
  if (bodyFailure === undefined) {
    throw new Error(admission);
  }
  console.error(`[#3039 owned fixture | exit guard] ${admission} (afterAll owns the same memoized attempt)`);
}

function hostCliTransport(handle: SshHandle): HostCliTransport {
  const exec = execTransport(handle);
  return { exec: (command: string) => exec.exec(command) };
}

describeDocker('session-end verdict on a real aplexer host (#3039)', () => {
  let container: StartedTestContainer | undefined;
  /** The primary container's ownership record: its REAL start promise is
   * kept even if a budget fires mid-start, afterAll settles it and stops
   * what came up, and — if the settle bound fires first — a retained
   * late-start finalizer owns the eventual settle. */
  let primaryFixture: OwnedFixture | undefined;
  let handle: SshHandle;
  let cli: HostCliCore;
  let home: string;
  let debugSshd: StartedTestContainer | undefined;
  /** Same for the debug sshd: a cold start can no longer bypass its cleanup. */
  let debugSshdFixture: OwnedFixture | undefined;
  /** Fixtures the lifecycle regressions stand up; afterAll owns their
   * cleanup too, whatever happened to the spec that created them. */
  const regressionFixtures: OwnedFixture[] = [];

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
    const starting = new GenericContainer('pocketshell-core-test:helper')
      .withExposedPorts(22)
      .withLabels({ 'ps3039.owned-fixture': 'primary-helper' })
      .start();
    primaryFixture = ownFixture('the primary helper container', starting);
    container = await waitFor('the primary helper container to start', starting, CONTAINER_START_BUDGET);
    primaryFixture.up = container;
    handle = await connectSsh(container.getHost(), container.getMappedPort(22));
    cli = new HostCliCore(hostCliTransport(handle));
    home = (await waitFor('the primary home capture', run('echo $HOME'), DEBUG_CAPTURE_BUDGET)).stdout.trim();
    await new Promise((r) => setTimeout(r, APLEXER_SETTLE_MS));
  }, CONTAINER_START_BUDGET + SSH_CONNECT_BUDGET + DEBUG_CAPTURE_BUDGET + APLEXER_SETTLE_MS);

  afterAll(async () => {
    handle?.close();
    // Every step bounded, named, and failure-collecting: a start still in
    // flight when a spec died is settled first so whatever came up is
    // stopped, one failed step never skips the rest, and nothing is
    // swallowed — collected failures fail the hook. When a start does NOT
    // settle inside its bound, cleanup does not give up on it: the settle
    // leaves a retained late-start finalizer on the real start promise, so
    // ANY eventual resolve — seconds or minutes after this hook returned —
    // still gets its stop requested, and a late rejection is recorded under
    // the fixture's ownership label instead of leaking silently.
    const failures: string[] = [];
    const settleAndCollect = async (fixture: OwnedFixture) => {
      const failure = await settleAndStopWithin(fixture, CLEANUP_STAGE_BUDGET);
      if (failure) failures.push(failure);
    };
    if (debugSshdFixture) await settleAndCollect(debugSshdFixture);
    if (primaryFixture) await settleAndCollect(primaryFixture);
    for (const fixture of regressionFixtures) await settleAndCollect(fixture);
    if (failures.length > 0) {
      throw new Error(`owned fixture cleanup failed, ${failures.length} step(s):\n  ${failures.join('\n  ')}`);
    }
    // Settle+stop for every fixture this file can own — the primary, the
    // debug sshd, and the seven registered regression fixtures (late-start,
    // exec-timeout, the failed-stop and concurrent-stop regressions'
    // PHYSICAL owners, both abort regressions' physical owners, and the
    // pre-startup fixture) — two bounded steps each. The controlled-operation
    // seams are deliberately NOT registered: their memoized outcomes — a
    // controlled failure, a held-then-released stop — are the specs'
    // observations, never this hook's bookkeeping. The physical owners carry
    // the real cleanup, so a fake controlled failure cannot taint this hook,
    // and a real physical failure cannot hide behind a controlled success.
  }, 18 * CLEANUP_STAGE_BUDGET);

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

  it('a fixture whose start resolves after its teardown bound is stopped by the retained late-start finalizer', async () => {
    // The teardown cleanup's settle bound fires long before a real docker
    // start can resolve — the exact state the old afterAll left behind: a
    // pending start promise nobody owned, whose container would come up into
    // a dead teardown and leak. The seam under test is the real one
    // (settleAndStopWithin → retainLateStartFinalizer → requestStop) and the
    // container is a real one: whatever the finalizer does happens to a live
    // docker container, never to a mock.
    const startup = new GenericContainer('pocketshell-core-test:helper')
      .withCommand(['/bin/sh', '-c', 'exec sleep 300'])
      .withLabels({ 'ps3039.owned-fixture': 'late-start-regression' })
      .start();
    const fixture = ownFixture('the late-start regression container', startup);
    regressionFixtures.push(fixture);
    const note = await settleAndStopWithin(fixture, TEARDOWN_PROOF_BOUND_MS);
    expect(note, note).toMatch(/late-start finalizer/);
    expect(fixture.stopRequested, 'the bound fired before any container existed, so nothing could be stopped yet').toBe(false);
    // The start resolves for real; the retained finalizer must stop it.
    const up = await waitFor('the late-start regression container to come up after the teardown bound fired', startup, CONTAINER_START_BUDGET);
    await waitFor(
      'the retained late-start finalizer to record its outcome',
      (async () => {
        while (fixture.finalizerNote === undefined) {
          await new Promise((r) => setTimeout(r, 100));
        }
      })(),
      FINALIZER_RECORD_BUDGET,
    );
    expect(fixture.finalizerNote, fixture.finalizerNote).toMatch(/stopped \(the retained late-start finalizer/);
    // The real outcome, independent of the fixture's own bookkeeping: the
    // finalizer's stop removed the container — it can no longer exec.
    await expect(up.exec(['echo', 'still up?']), 'a container the finalizer stopped must refuse execs').rejects.toThrow();
  }, LATE_START_REGRESSION_TOTAL);

  it('an exec that outlives its bound terminates the owned process: the fixture stops and the exec settles', async () => {
    // The real poller, driven through its ops seam against a real container:
    // the "log read" is a genuinely wedged docker exec (a sleep far beyond
    // any bound), so its stage bound fires the way it fires when a daemon
    // stalls — and the only real termination available, stopping the fixture
    // that owns the process, must actually happen and actually work: the
    // wedged exec must settle (the container kill ended it) and a further
    // exec on the fixture must refuse. A raced bound cancels nothing; this
    // spec pins what does.
    const startup = new GenericContainer('pocketshell-core-test:helper')
      .withCommand(['/bin/sh', '-c', 'exec sleep 300'])
      .withLabels({ 'ps3039.owned-fixture': 'exec-timeout-regression' })
      .start();
    const fixture = ownFixture('the exec-timeout regression container', startup);
    regressionFixtures.push(fixture);
    const up = await waitFor('the exec-timeout regression container to start', startup, CONTAINER_START_BUDGET);
    fixture.up = up;
    let wedgedSettled = false;
    const wedged = up.exec(['sh', '-c', 'sleep 120']);
    wedged.then(
      () => {
        wedgedSettled = true;
      },
      () => {
        wedgedSettled = true; // a container kill surfaces as a rejection; settled either way
      },
    );
    const error: Error = await waitFor(
      'the poller to reject its wedged exec stage at the bound',
      observeServerChannelFreeInLog(7, {
        label: 'the exec-timeout regression container to log channel 7 freed (the exec wedges before any evidence could arrive)',
        deadlineMs: EXEC_TIMEOUT_REGRESSION_DEADLINE,
      }, {
        readLog: () => wedged,
        readEstablished: () => up.exec(['sh', '-c', 'true']),
        terminateOwnedFixture: (reason) => fixture.requestStop(reason),
      }).then(
        () => {
          throw new Error('the poller resolved, but its exec was wedged far beyond its bound');
        },
        (rejection: Error) => rejection,
      ),
      EXEC_TIMEOUT_GUARD_BUDGET,
    );
    expect(error.message).toMatch(new RegExp(`exceeded its ${EXEC_TIMEOUT_REGRESSION_DEADLINE}ms bound`));
    expect(error.message).toMatch(/the owned fixture was stopped to terminate the outstanding process/);
    expect(error.message, error.message).toMatch(/stopped \(an exec of "/);
    expect(error.message).toMatch(/All 1 outstanding exec\(s\) settled once the fixture stopped/);
    expect(wedgedSettled, 'the wedged exec must settle once its container was killed').toBe(true);
    // The real outcome again, independent of any bookkeeping: the stopped
    // (and removed) fixture can no longer exec.
    await expect(up.exec(['echo', 'still up?']), 'a fixture stopped over a wedged exec must refuse execs').rejects.toThrow();
  }, EXEC_TIMEOUT_REGRESSION_TOTAL);

  it('a stop that FAILED stays a failure for every later caller: the memoized actual outcome, never a fabricated ok', async () => {
    // The controlled-operation seam: a real container, but its stop RPC is a
    // controlled operation that genuinely FAILS (the daemon is untouched —
    // the failing attempt stops nothing). This is the exact state the old
    // requestStop misreported: a caller arriving after a failed attempt got
    // {ok: true, "already requested"}, so a repeated cleanup — afterAll's
    // included — reported a successful stop that never happened. The
    // memoized contract: the one attempt's actual outcome is what every
    // caller awaits, so the failure stays the failure it is.
    //
    // The container's PHYSICAL cleanup is a separate owner over the same
    // real startup, registered with afterAll BEFORE the start is even
    // awaited: the poisoned seam's memoized failure is this spec's
    // observation, never the hook's bookkeeping — and no assertion failure
    // or start timeout can bypass the one real stop, because the exit guard
    // below runs on every path.
    let stopAttempts = 0;
    const startup = new GenericContainer('pocketshell-core-test:helper')
      .withCommand(['/bin/sh', '-c', 'exec sleep 300'])
      .withLabels({ 'ps3039.owned-fixture': 'failed-stop-memoization' })
      .start();
    const physical = ownFixture('the failed-stop regression container (physical owner)', startup);
    regressionFixtures.push(physical);
    const controlled = ownFixture('the failed-stop memoization container', startup, {
      stopRpc: () => {
        stopAttempts += 1;
        return Promise.reject(new Error('controlled stop failure: the injected stop RPC rejected'));
      },
    });
    let bodyFailure: unknown;
    try {
      const up = await waitFor('the failed-stop memoization container to start', startup, CONTAINER_START_BUDGET);
      physical.up = up;
      controlled.up = up;
      const first = await waitFor('the injected stop attempt to fail', controlled.requestStop('the first cleanup'), CLEANUP_STAGE_BUDGET);
      expect(first.ok, first.note).toBe(false);
      expect(first.note, first.note).toMatch(/stop FAILED \(the first cleanup\): .*controlled stop failure/);
      const repeated = await controlled.requestStop('the repeated cleanup');
      expect(repeated, 'the repeated cleanup must see the memoized failure, not a fabricated ok').toEqual(first);
      const afterTheFact = await controlled.requestStop('a cleanup arriving after the failure had settled');
      expect(afterTheFact, 'even a later cleanup sees the same actual outcome').toEqual(first);
      expect(stopAttempts, 'the single controlled attempt must have run exactly once').toBe(1);
    } catch (error) {
      bodyFailure = error;
      throw error;
    } finally {
      // EVERY path: the one real stop — the physical owner's memoized
      // attempt, which the guard, a repeat caller, and afterAll all share.
      await regressionExitGuard(physical, bodyFailure);
    }
    // Reached only when the body AND the guard succeeded: the real outcome,
    // independent of any bookkeeping — the stopped (and removed) container
    // can no longer exec.
    await expect(
      physical.up!.exec(['echo', 'still up?']),
      'a container the exit guard physically stopped must refuse execs',
    ).rejects.toThrow();
    // The teardown's view is the SAME memoized success: the controlled
    // failure never taints it, and the physical stop is not repeated.
    const teardownView = await physical.requestStop("a later cleanup (the teardown's view)");
    expect(teardownView.ok, teardownView.note).toBe(true);
  }, FAILED_STOP_REGRESSION_TOTAL);

  it('concurrent stop requests share the one attempt: while it is pending they wait, and all get its actual outcome', async () => {
    // The controlled-operation seam again: the stop RPC is a controlled
    // operation held pending until released — and the release hands the
    // waiting callers the PHYSICAL owner's real stop outcome, so the actual
    // outcome they eventually share is the real stop's, with exactly one
    // real stop RPC. The old requestStop answered a caller arriving during
    // a pending attempt on the spot with a fabricated {ok: true}, whatever
    // the attempt then concluded.
    //
    // The physical owner is registered with afterAll BEFORE the start is
    // awaited, and the exit guard below runs on EVERY path — so a failure
    // before the release can no longer leave the held operation pending
    // forever with the real container unstopped: the guard releases it and
    // stops the container for real.
    let stopInvocations = 0;
    const startup = new GenericContainer('pocketshell-core-test:helper')
      .withCommand(['/bin/sh', '-c', 'exec sleep 300'])
      .withLabels({ 'ps3039.owned-fixture': 'concurrent-stop-memoization' })
      .start();
    const physical = ownFixture('the concurrent-stop regression container (physical owner)', startup);
    regressionFixtures.push(physical);
    const seam = heldStopSeam(physical, () => {
      stopInvocations += 1;
    });
    const controlled = ownFixture('the concurrent-stop memoization container', startup, { stopRpc: seam.stopRpc });
    let bodyFailure: unknown;
    let up: StartedTestContainer | undefined;
    try {
      up = await waitFor('the concurrent-stop memoization container to start', startup, CONTAINER_START_BUDGET);
      physical.up = up;
      controlled.up = up;
      const first = controlled.requestStop('the first cleanup (held pending by the controlled seam)');
      const concurrent = controlled.requestStop('a concurrent cleanup arriving while the attempt was pending');
      // While the operation is held, NEITHER caller may be answered: a
      // fabricated immediate ok would surface right here.
      const whileHeld = await waitFor(
        'the concurrent callers to still be waiting while the stop operation is held',
        Promise.race([
          Promise.all([first, concurrent]).then(() => 'answered early'),
          new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), STOP_MEMOIZATION_HOLD_MS)),
        ]),
        STOP_MEMOIZATION_PROBE_BUDGET,
      );
      expect(whileHeld, 'no caller may be answered while the single attempt is still pending').toBe('still waiting');
      // Release: both callers — and any later one — are handed the physical
      // owner's single real stop and share its actual outcome.
      seam.releaseOnce();
      const [firstOutcome, concurrentOutcome] = await waitFor(
        'both concurrent stop callers to settle at the actual stop outcome',
        Promise.all([first, concurrent]),
        CLEANUP_STAGE_BUDGET,
      );
      expect(firstOutcome, firstOutcome.note).toEqual(concurrentOutcome);
      expect(firstOutcome.ok, firstOutcome.note).toBe(true);
      expect(firstOutcome.note, firstOutcome.note).toMatch(/stopped \(the first cleanup/);
      expect(stopInvocations, 'the single controlled attempt must have run exactly once').toBe(1);
      const later = await controlled.requestStop('a cleanup arriving after the outcome had settled');
      expect(later, 'a later cleanup sees the same memoized outcome').toEqual(firstOutcome);
      expect(stopInvocations).toBe(1);
    } catch (error) {
      bodyFailure = error;
      throw error;
    } finally {
      // EVERY path: the held operation is released (idempotent — a body
      // that already released is a no-op) and the physical owner's one real
      // stop is awaited under a bound.
      await regressionExitGuard(physical, bodyFailure, seam.releaseOnce);
    }
    // Reached only when the body AND the guard succeeded: the real outcome.
    await expect(
      up!.exec(['echo', 'still up?']),
      'a container whose single real stop every caller shared must refuse execs',
    ).rejects.toThrow();
    // The teardown's view: the physical owner's memoized success — the held
    // controlled operation never touched this hook's bookkeeping.
    const teardownView = await physical.requestStop("a later cleanup (the teardown's view)");
    expect(teardownView.ok, teardownView.note).toBe(true);
  }, HELD_STOP_REGRESSION_TOTAL);

  it('a stop requested before the start resolved invents nothing: it waits for the real container and stops it once up', async () => {
    // The old shape answered a pre-startup request on the spot with
    // {ok: false, "start never produced a container"} — and marked the
    // request served, so the container that DID come up was never stopped: a
    // later caller got the fabricated {ok: true, "already requested"}. The
    // memoized attempt instead waits for the real start and stops the real
    // container once it is up — one attempt, actual outcome. Production seam
    // throughout: the real stop, counted.
    let stopInvocations = 0;
    const startup = new GenericContainer('pocketshell-core-test:helper')
      .withCommand(['/bin/sh', '-c', 'exec sleep 300'])
      .withLabels({ 'ps3039.owned-fixture': 'pre-startup-stop' })
      .start();
    const fixture = ownFixture('the pre-startup-stop container', startup, {
      stopRpc: (upContainer) => {
        stopInvocations += 1;
        return upContainer.stop();
      },
    });
    regressionFixtures.push(fixture);
    const requested = fixture.requestStop('the pre-startup stop regression');
    expect(fixture.stopRequested, 'the request is recorded the moment it arrives').toBe(true);
    const outcome = await waitFor(
      'the pre-startup stop to complete once the container came up',
      requested,
      CONTAINER_START_BUDGET + CLEANUP_STAGE_BUDGET,
    );
    expect(outcome.ok, outcome.note).toBe(true);
    expect(outcome.note, outcome.note).toMatch(/stopped \(the pre-startup stop regression/);
    expect(stopInvocations, 'the single stop attempt must have run exactly once, after the start resolved').toBe(1);
    const later = await fixture.requestStop('a cleanup arriving after the outcome had settled');
    expect(later, 'a later cleanup sees the same memoized outcome').toEqual(outcome);
    expect(stopInvocations).toBe(1);
    // The real outcome, independent of the fixture's bookkeeping.
    expect(fixture.up).toBeDefined();
    await expect(fixture.up!.exec(['echo', 'still up?']), 'a container the pre-startup request stopped must refuse execs').rejects.toThrow();
  }, CONTAINER_START_BUDGET + CLEANUP_STAGE_BUDGET + DEBUG_CAPTURE_BUDGET);

  it('a simulated assertion abort BEFORE the held stop is released: the exit guard still releases it and stops the real container', async () => {
    // The held-stop regression's abort path, driven for real: the body
    // fails — a simulated assertion error — while the single attempt is
    // still pending on the held operation and BEFORE any release. That is
    // the exact state the pre-fix spec left behind: the held RPC never
    // released, afterAll waiting out its timeout while the real container
    // stayed up. The exit guard here is the SAME code every controlled-stop
    // regression runs on its way out — the production cleanup path under an
    // abort, not a mirror of it — and the proof is the real outcome: the
    // abort propagated (never masked by the cleanup's success), the held
    // callers settled at the real stop's outcome, and the container refuses
    // execs.
    let stopInvocations = 0;
    const startup = new GenericContainer('pocketshell-core-test:helper')
      .withCommand(['/bin/sh', '-c', 'exec sleep 300'])
      .withLabels({ 'ps3039.owned-fixture': 'abort-before-release' })
      .start();
    const physical = ownFixture('the abort-before-release regression container (physical owner)', startup);
    regressionFixtures.push(physical);
    const seam = heldStopSeam(physical, () => {
      stopInvocations += 1;
    });
    const controlled = ownFixture('the abort-before-release memoization container', startup, { stopRpc: seam.stopRpc });
    let first: Promise<OwnedStop> | undefined;
    let concurrent: Promise<OwnedStop> | undefined;
    let bodyFailure: unknown;
    const abortingBody = async (): Promise<void> => {
      try {
        const up = await waitFor('the abort-before-release container to start', startup, CONTAINER_START_BUDGET);
        physical.up = up;
        controlled.up = up;
        first = controlled.requestStop("the abort regression's first cleanup (held pending)");
        concurrent = controlled.requestStop('a concurrent cleanup (held pending)');
        const whileHeld = await waitFor(
          'the held callers to still be waiting when the abort fires',
          Promise.race([
            Promise.all([first, concurrent]).then(() => 'answered early'),
            new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), STOP_MEMOIZATION_HOLD_MS)),
          ]),
          STOP_MEMOIZATION_PROBE_BUDGET,
        );
        expect(whileHeld, 'the abort must fire while the single attempt is genuinely held').toBe('still waiting');
        // THE ABORT, before any release — the failure an assertion raises:
        throw new Error('simulated assertion abort before the held stop was released');
      } catch (error) {
        bodyFailure = error;
        throw error;
      } finally {
        await regressionExitGuard(physical, bodyFailure, seam.releaseOnce);
      }
    };
    const failure: Error = await waitFor(
      'the simulated abort to propagate through the exit guard',
      abortingBody().then(
        () => {
          throw new Error('the aborting body resolved instead of propagating its abort');
        },
        (error: Error) => error,
      ),
      CONTAINER_START_BUDGET + STOP_MEMOIZATION_PROBE_BUDGET + REGRESSION_EXIT_GUARD_BUDGET,
    );
    expect(failure.message, failure.message).toMatch(/simulated assertion abort/);
    // The guard released the held operation: both callers settled at the
    // real stop's outcome — one controlled invocation, one real stop RPC.
    const [firstOutcome, concurrentOutcome] = await waitFor(
      'both held callers to settle at the released real outcome',
      Promise.all([first!, concurrent!]),
      CLEANUP_STAGE_BUDGET,
    );
    expect(firstOutcome.ok, firstOutcome.note).toBe(true);
    expect(firstOutcome.note, firstOutcome.note).toMatch(/stopped \(the abort regression's first cleanup/);
    expect(concurrentOutcome, concurrentOutcome.note).toEqual(firstOutcome);
    expect(stopInvocations, 'the controlled seam must have been invoked exactly once').toBe(1);
    // The REAL outcome, independent of any bookkeeping: the physically
    // stopped container can no longer exec — the owned fixture is gone.
    await expect(
      physical.up!.exec(['echo', 'still up?']),
      'a container the exit guard stopped after the abort must refuse execs',
    ).rejects.toThrow();
    // The hook's bookkeeping stays clean: the physical owner's memoized
    // outcome is the success afterAll will inherit.
    const teardownView = await physical.requestStop("a later cleanup (the teardown's view)");
    expect(teardownView.ok, teardownView.note).toBe(true);
  }, ABORT_BEFORE_RELEASE_REGRESSION_TOTAL);

  it('a simulated assertion abort while the startup is still pending: the exit guard owns the eventual container', async () => {
    // The abort lands BEFORE the startup resolved — no await of it, no
    // container yet. The physical owner was registered with afterAll before
    // anything was awaited, and the exit guard rides out the real start and
    // stops what came up: a container that comes up after its spec aborted
    // is still owned, still stopped — gone for real.
    const startup = new GenericContainer('pocketshell-core-test:helper')
      .withCommand(['/bin/sh', '-c', 'exec sleep 300'])
      .withLabels({ 'ps3039.owned-fixture': 'startup-after-abort' })
      .start();
    const physical = ownFixture('the startup-after-abort regression container', startup);
    regressionFixtures.push(physical);
    let bodyFailure: unknown;
    let abortAt = 0;
    let upAt = -1;
    startup.then(
      (up) => {
        upAt = Date.now();
        physical.up = up;
      },
      () => undefined,
    );
    const abortingBody = async (): Promise<void> => {
      try {
        // No await of the startup: the abort fires while it is still pending.
        abortAt = Date.now();
        throw new Error('simulated assertion abort while the startup was still pending');
      } catch (error) {
        bodyFailure = error;
        throw error;
      } finally {
        await regressionExitGuard(physical, bodyFailure);
      }
    };
    const failure: Error = await waitFor(
      'the simulated abort to propagate through the exit guard (which rides out the pending startup)',
      abortingBody().then(
        () => {
          throw new Error('the aborting body resolved instead of propagating its abort');
        },
        (error: Error) => error,
      ),
      REGRESSION_EXIT_GUARD_BUDGET,
    );
    expect(failure.message, failure.message).toMatch(/simulated assertion abort/);
    expect(upAt, 'the container came up only after the abort had fired').toBeGreaterThanOrEqual(abortAt);
    // The REAL outcome: the eventual container was stopped — gone.
    expect(physical.up, 'the startup must have produced the container the guard stopped').toBeDefined();
    await expect(
      physical.up!.exec(['echo', 'still up?']),
      'a container that came up after its spec aborted must have been stopped by the exit guard',
    ).rejects.toThrow();
    const teardownView = await physical.requestStop("a later cleanup (the teardown's view)");
    expect(teardownView.ok, teardownView.note).toBe(true);
  }, STARTUP_AFTER_ABORT_REGRESSION_TOTAL);

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
    debugSshdFixture = ownFixture('the dedicated debug sshd container', new GenericContainer('pocketshell-core-test:helper')
      .withExposedPorts(22)
      .withCommand(['/bin/sh', '-c',
        `exec /usr/sbin/sshd -D -E ${DEBUG_SSHD_LOG} -o LogLevel=DEBUG3 -o PidFile=${DEBUG_SSHD_PIDFILE}`])
      .withLabels({ 'ps3039.owned-fixture': 'debug-sshd' })
      .start());
    // The start promise is retained on the suite even if this stage's budget
    // fires mid-start: afterAll settles it and stops whatever came up, and —
    // if the settle bound fires first — leaves the retained late-start
    // finalizer owning the eventual settle, so a cold start can no longer
    // eat the spec total and bypass the cleanup.
    debugSshd = await waitFor('the dedicated debug sshd container to start', debugSshdFixture.startup, CONTAINER_START_BUDGET);
    debugSshdFixture.up = debugSshd;
    const debugHost = debugSshd.getHost();
    const debugPort = debugSshd.getMappedPort(22);
    const fixture = await waitFor(
      'the debug sshd fixture version capture',
      debugSshd.exec(['sh', '-c',
        'apk list --installed 2>/dev/null | grep -m1 ^openssh-server-; cat /etc/alpine-release; a --version 2>&1 | head -1; cat ' + DEBUG_SSHD_PIDFILE]),
      DEBUG_CAPTURE_BUDGET,
    );
    console.log('[#3039] debug sshd fixture (openssh-server / alpine / a / listener pid):\n' + fixture.stdout.trim());

    // 1. Between the host's CLOSE and ours the channel still exists on the
    //    host: a window-change sent there is harmless.
    const earlyVictim = await waitFor(
      'the early-phase victim connection to open',
      connectSsh(container!.getHost(), container!.getMappedPort(22)),
      SSH_CONNECT_BUDGET,
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
        await waitFor(`a kill ${early.id} to complete`, run(`a kill ${early.id}`), KILL_BUDGET);
        await waitFor('the early channel to close client-side', early.client.exited, CHANNEL_EXIT_BUDGET);
      } finally {
        // The override exists only for the early channel's teardown — never
        // leak it into the late half, on a failure path either.
        earlyProtocol.channelClose = earlyRealClose;
      }
      expect(sentBeforeOurClose).toBe(true);
      const stillUp = await waitFor('the healthy probe after the early window-change', execTransport(earlyVictim).exec('echo alive'), HEALTHY_PROBE_BUDGET);
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
    const controller = await waitFor('the debug controller connection to open', connectSsh(debugHost, debugPort), SSH_CONNECT_BUDGET);
    const controllerClosed = new Promise<void>((resolve) => controller.conn.on('close', () => resolve()));
    let debugHome = '';
    let lateId = '';
    try {
      debugHome = (await waitFor('the debug home capture', execTransport(controller).exec('echo $HOME'), DEBUG_CAPTURE_BUDGET)).stdout.trim();
      const started = await waitFor(
        `a start --tag ${tagLate} to complete (debug sshd)`,
        execTransport(controller).exec(`a start --workspace ${debugHome} --tag ${tagLate} --json`),
        SESSION_START_BUDGET,
      );
      expect(started.exitCode, started.stderr).toBe(0);
      lateId = JSON.parse(started.stdout).id as string;
      expect(lateId).toBeTruthy();

      // PID correlation: a session shell's sshd ancestor chain must reach the
      // debug sshd itself — the listener whose -E log this spec is about to
      // read is the same process tree serving these connections.
      const shellPpid = (await waitFor('the session shell ppid capture', execTransport(controller).exec('echo $PPID'), DEBUG_CAPTURE_BUDGET)).stdout.trim();
      const chain = await waitFor(
        'the sshd ancestor chain capture',
        debugSshd.exec(['sh', '-c',
          `p=${shellPpid}; for i in 1 2 3 4; do [ -r /proc/$p/status ] || break; ` +
          'echo "$p comm=$(cat /proc/$p/comm 2>/dev/null) ppid=$(awk \'/^PPid:/{print $2}\' /proc/$p/status)"; ' +
          'p=$(awk \'/^PPid:/{print $2}\' /proc/$p/status); [ "$p" -le 1 ] 2>/dev/null && break; done']),
        DEBUG_CAPTURE_BUDGET,
      );
      const listenerPid = (await waitFor('the debug sshd pidfile capture', debugSshd.exec(['cat', DEBUG_SSHD_PIDFILE]), DEBUG_CAPTURE_BUDGET)).stdout.trim();
      const chainLines = chain.stdout.trim().split('\n');
      expect(chainLines.length).toBeGreaterThanOrEqual(1);
      expect(chainLines[chainLines.length - 1]).toMatch(new RegExp(`comm=sshd ppid=${listenerPid}$`));
      expect(chainLines.filter((line) => !line.includes('comm=sshd'))).toEqual([]);
    } finally {
      await endVictimConnection(controller.conn, controllerClosed);
    }

    const lateVictim = await waitFor('the late-phase victim connection to open', connectSsh(debugHost, debugPort), SSH_CONNECT_BUDGET);
    const lateErrors: string[] = [];
    lateVictim.conn.on('error', (error: Error) => lateErrors.push(error.message));
    const lateVictimClosed = new Promise<void>((resolve) => lateVictim.conn.on('close', () => resolve()));
    try {
      const lateName = `${debugHome.split('/').pop()}:${tagLate}`;
      const late = await waitFor(
        'the late attach channel to open',
        attachPty(lateVictim, cli.buildAttachCommand(lateName)),
        ATTACH_OPEN_BUDGET,
      );
      await waitFor(`the late attached client ${tagLate} to paint (attach readiness)`, late.ready, ATTACH_PAINT_BUDGET);
      // The late channel's SERVER-side id: ssh2's outgoing.id is the id the
      // server allocated (CHANNEL_OPEN_CONFIRMATION's sender channel) — the
      // number every sshd debug line for this channel carries.
      const lateRemoteId = late.remoteId;
      const killed = await waitFor(
        `a kill ${lateId} to complete (on the victim connection)`,
        execTransport(lateVictim).exec(`a kill ${lateId}`),
        KILL_BUDGET,
      );
      expect(killed.exitCode, killed.stderr).toBe(0);
      const lateChannelExits = await waitFor('the late channel to close client-side', late.exited, CHANNEL_EXIT_BUDGET);
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
      // The poller carries its own deadline and bounds every exec stage, so
      // it is awaited directly: a closed victim connection or a free that
      // never arrives rejects HERE, at a named stage — no outer race can
      // orphan the poller into background exec polling. (Those bounds are
      // observation bounds: a docker exec RPC cannot be cancelled — the
      // poller's own contract below states what actually terminates one.)
      const observed = await observeServerChannelFreeInLog(lateRemoteId, {
        label: 'the debug sshd to log the late channel freed (rcvd close, then free)',
        deadlineMs: OBSERVE_FREE_BUDGET,
      }, fixtureOpsFor(debugSshd, (reason) => debugSshdFixture!.requestStop(reason)));
      console.log('[#3039] observed server-side reclamation:\n' + observed);

      // Between that log snapshot and this line the spec opens no channel on
      // the victim connection (every read went over docker exec), so no
      // channel can have re-occupied the id: the request must now find the
      // slot gone and drop the connection — the "freed" half of the pin.
      protocolOf(lateVictim.conn).windowChange(lateRemoteId, 30, 100, 0, 0);
      await waitFor('the expected disconnect (unknown-channel drop)', lateVictimClosed, DISCONNECT_BUDGET);
      expect(lateErrors.join('\n')).toMatch(/server_input_channel_req: unknown channel \d+/);

      // The receipt, from the final log: in the victim's region the free sits
      // strictly between the rcvd close and the unknown-channel disconnect,
      // and NOTHING touched the id in between.
      const finalLog = await waitFor('the final debug log capture', debugSshd.exec(['cat', DEBUG_SSHD_LOG]), DEBUG_CAPTURE_BUDGET);
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

      // NEGATIVE TIMEOUT REGRESSION. The deadline above is load-bearing, not
      // decorative: an id the victim connection never allocated can never
      // satisfy the observation, so the only way this settles is the poller's
      // own deadline — rejecting bounded, naming the stage, never polling on
      // in the background. The outer guard is how the regression stays loud
      // if the deadline ever regresses back to an unbounded poll: it fails
      // here in seconds instead of at the spec total.
      const neverId = lateRemoteId + 100;
      await waitFor(
        'the free-observation deadline to reject the never-arriving evidence',
        expect(
          observeServerChannelFreeInLog(neverId, {
            label: `the debug sshd to log channel ${neverId} freed (negative regression: this evidence must never arrive)`,
            deadlineMs: NEGATIVE_DEADLINE_BUDGET,
          }, fixtureOpsFor(debugSshd, (reason) => debugSshdFixture!.requestStop(reason))),
        ).rejects.toThrow(
          new RegExp(`timed out after ${NEGATIVE_DEADLINE_BUDGET}ms waiting for: .*negative regression`),
        ),
        NEGATIVE_GUARD_BUDGET,
      );
    } finally {
      await endVictimConnection(lateVictim.conn, lateVictimClosed);
    }
  }, HAZARD_STAGE_BUDGET_TOTAL);

  async function startAndAttachOn(
    on: SshHandle,
    tag: string,
  ): Promise<{ id: string; client: AttachedClient; remoteId: number }> {
    const started = await waitFor(`a start --tag ${tag} to complete`, run(`a start --workspace ${home} --tag ${tag} --json`), SESSION_START_BUDGET);
    expect(started.exitCode, started.stderr).toBe(0);
    const id = JSON.parse(started.stdout).id as string;
    const client = await waitFor(
      `the attach channel for ${tag} to open`,
      attachPty(on, cli.buildAttachCommand(`${home.split('/').pop()}:${tag}`)),
      ATTACH_OPEN_BUDGET,
    );
    await waitFor(`the attached client ${tag} to paint (attach readiness)`, client.ready, ATTACH_PAINT_BUDGET);
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
 * The poller's fixture operations, as a seam so the exec-timeout regression
 * can drive the REAL poller against a REAL container whose exec genuinely
 * wedges. The production seam (`fixtureOpsFor`) wraps every command in an
 * in-container `timeout` — the actual command-timeout, so the owned process
 * really dies at its bound even though the exec RPC itself cannot be
 * cancelled; the regression's ops deliberately omit the wrapper (a `timeout`
 * there would rescue the command the regression wedges on purpose).
 */
interface PollerFixtureOps {
  /** One docker exec reading the sshd -E log; `execBoundMs` is the stage's bound. */
  readLog(execBoundMs: number): Promise<ExecResult>;
  /** One docker exec listing sshd's ESTABLISHED client ports. */
  readEstablished(execBoundMs: number): Promise<ExecResult>;
  /** Stop the fixture owning these execs' processes: the only real
   * termination for an exec whose stage bound fired. Bounded, idempotent,
   * reason-labeled, outcome spelled out. */
  terminateOwnedFixture(reason: string): Promise<OwnedStop>;
}

function fixtureOpsFor(debugSshd: StartedTestContainer, terminate: (reason: string) => Promise<OwnedStop>): PollerFixtureOps {
  // The in-container timeout leaves ~1s of headroom under the RPC bound so
  // the process dies first; in a healthy run the reads finish in
  // milliseconds and the timeout never fires at all.
  const withCommandTimeout = (execBoundMs: number, command: string): string[] => {
    const secs = Math.max(1, Math.floor(execBoundMs / 1000) - 1);
    return ['sh', '-c', `timeout ${secs} ${command}`];
  };
  return {
    readLog: (execBoundMs) => debugSshd.exec(withCommandTimeout(execBoundMs, `cat ${DEBUG_SSHD_LOG}`)),
    readEstablished: (execBoundMs) => debugSshd.exec(withCommandTimeout(execBoundMs,
      "netstat -tn 2>/dev/null | grep ':22 ' | grep ESTABLISHED")),
    terminateOwnedFixture: terminate,
  };
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
 *
 * The poller owns its deadline: every exec stage is bounded (clamped to the
 * deadline's remainder, never below DEBUG_EXEC_FLOOR) and the loop stops at
 * the deadline, so the caller awaits it directly with no outer race. Stated
 * plainly, such a bound is an OBSERVATION bound: a docker exec RPC cannot be
 * cancelled by anyone. The actual termination paths are: every production
 * command runs under an in-container `timeout` (the process really dies at
 * its bound), and an exec whose STAGE bound fired stops the fixture that owns
 * the process, tracks every exec still outstanding to settlement
 * (EXEC_STRAGGLER_SETTLE_BUDGET), and composes the whole outcome — stop
 * result and stragglers included — into the stage's rejection. Under a
 * permanently unresponsive docker daemon no in-test mechanism can force a
 * stop RPC to complete: the bound still fires, the failure still propagates
 * (failing the spec and the cleanup hook), and anything that leaked is
 * recorded as leaked — an honest limitation, never a claimed guarantee.
 */
async function observeServerChannelFreeInLog(
  remoteId: number,
  budget: { label: string; deadlineMs: number },
  ops: PollerFixtureOps,
): Promise<string> {
  const deadline = Date.now() + budget.deadlineMs;
  let lastState = 'no log read yet';
  // Every exec this poller issues stays tracked here until it SETTLES —
  // resolved or rejected. A stage bound firing does not remove an exec from
  // this map: the bound cancels nothing, and this map is the honest
  // inventory of what is still running against the owned fixture.
  const outstanding = new Map<Promise<unknown>, string>();
  const tracked = <T>(what: string, op: Promise<T>): Promise<T> => {
    outstanding.set(op, what);
    op.then(
      () => {
        outstanding.delete(op);
      },
      () => {
        outstanding.delete(op);
      },
    );
    return op;
  };
  for (;;) {
    // Below the exec floor a clamped exec bound could fire before the exec
    // itself — failing at the bound, not at the deadline. Past this point the
    // only exit for never-arriving evidence is the deadline error.
    const remaining = deadline - Date.now();
    if (remaining < DEBUG_EXEC_FLOOR) {
      throw new Error(
        `timed out after ${budget.deadlineMs}ms waiting for: ${budget.label}; last observed state: ${lastState}`,
      );
    }
    const execBound = Math.min(DEBUG_EXEC_BUDGET, remaining);
    let logRead: ExecResult;
    let established: ExecResult;
    try {
      [logRead, established] = await Promise.all([
        waitFor(`${budget.label} (debug log read)`, tracked('debug log read', ops.readLog(execBound)), execBound),
        waitFor(
          `${budget.label} (established-port read)`,
          tracked('established-port read', ops.readEstablished(execBound)),
          execBound,
        ),
      ]);
    } catch (stageError) {
      throw await failExecStage(stageError, execBound);
    }
    // sshd logs each connection's CLIENT port in its Accepted line; netstat
    // (read server-side, over docker exec) lists that same port for every
    // live connection — the region must be one of the live ones.
    const livePorts = established.stdout
      .split('\n')
      .filter((line) => line.includes('ESTABLISHED'))
      .map((line) => (line.trim().split(/\s+/)[4] ?? '').split(':').pop() ?? '');
    const region = regionOfLastAcceptedConnection(logRead.stdout);
    if (!livePorts.includes(region.port)) {
      lastState = `the region's client port ${region.port} is not among sshd's ESTABLISHED ports ` +
        `(${livePorts.join(', ') || 'none'})`;
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
      lastState = `the victim region (client port ${region.port}, ${region.lines.length} lines) ` +
        `holds no 'channel ${remoteId}: rcvd close' yet`;
      await new Promise((r) => setTimeout(r, 150));
      continue;
    }
    const freeOffset = region.lines.findIndex((line) => line.includes(`channel ${remoteId}: free: `));
    if (freeOffset === -1) {
      lastState = `the victim region (client port ${region.port}) records 'channel ${remoteId}: rcvd close' ` +
        'but no free line yet';
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

  /**
   * An exec stage outlived its bound. The bound is an observation bound and
   * cancels nothing, so: the fixture that owns the wedged process is stopped
   * for real (a container stop kills its exec'd processes), every exec still
   * outstanding gets a bounded chance to settle now that its container is
   * gone, anything still unsettled is handed to a labeled record — never
   * silently dropped — and the whole outcome is composed into the rejection
   * that fails the spec.
   */
  async function failExecStage(stageError: unknown, execBound: number): Promise<Error> {
    const outstandingAtFailure = [...outstanding.values()];
    const stop = await ops.terminateOwnedFixture(
      `an exec of "${budget.label}" outlived its ${execBound}ms bound; the bound cannot cancel the RPC, ` +
      'so the fixture owning the process is stopped to terminate it',
    );
    const settleDeadline = Date.now() + EXEC_STRAGGLER_SETTLE_BUDGET;
    while (outstanding.size > 0 && Date.now() < settleDeadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const unsettled = [...outstanding.entries()];
    for (const [op, what] of unsettled) {
      op.then(
        () => console.log(`[#3039 owned exec] ${what}: settled only after ${budget.label}'s stage had already failed (${stop.note})`),
        (error) => console.error(`[#3039 owned exec] ${what}: rejected after ${budget.label}'s stage had already failed: ${(error as Error).message}`),
      );
      outstanding.delete(op);
    }
    return new Error(
      `${budget.label}: an exec stage exceeded its ${execBound}ms bound (${(stageError as Error).message}). ` +
      `The bound cannot cancel a docker exec, so the owned fixture was stopped to terminate the outstanding ` +
      `process — ${stop.note}. ` +
      (unsettled.length === 0
        ? `All ${outstandingAtFailure.length} outstanding exec(s) settled once the fixture stopped.`
        : `${unsettled.length} of ${outstandingAtFailure.length} exec(s) remained unsettled after ` +
          `${EXEC_STRAGGLER_SETTLE_BUDGET}ms and are handed to labeled records: ` +
          `${unsettled.map(([, what]) => what).join('; ')}`),
    );
  }
}
