/**
 * The monitor's poll loop: one snapshot exec every MONITOR_POLL_MS while a
 * panel is open, the CPU tick deltas folded in as they land, and the kill
 * verb. The parsing is `hostMonitor.ts`'s; this file owns only the
 * REACTIVE half — what a mounted panel needs and when it asks.
 *
 * Pause is panel state, not a store. The monitor has exactly one consumer
 * at a time (the overlay that mounted this composable), so unlike the
 * forwards/usage stores there is nothing for a second surface to share and
 * nothing to keep fresh while the panel is closed: unmounting STOPS the
 * poll, and a closed panel costs the host nothing. For the same reason
 * there is no push channel — a paused panel that comes back asks for one
 * fresh sample immediately (`resume`), it does not replay what it missed.
 *
 * A slow host must not stack samples: `inflight` guards the loop, and a
 * tick that lands while one exec is still on the wire is dropped — the
 * next scheduled tick will find it done. The loop itself is a chained
 * setTimeout rather than an interval for the same reason: the next ask is
 * scheduled from the previous answer, so a 5s exec yields a 5s+2s cadence,
 * never a queue.
 *
 * A hidden window (another app has the user's eyes) skips the exec but
 * keeps the timer, so returning costs one poll at most and the loop needs
 * no visibility lifecycle of its own.
 */
import { onScopeDispose, ref, watch, type Ref } from 'vue';
import { errorMessage } from '@pocketshell/core/shared/errors';
import { api } from './ipc';
import {
  MONITOR_SNAPSHOT_COMMAND,
  cpuPercentages,
  killCommand,
  parseMonitorSample,
  type CpuTicks,
  type MonitorSample,
} from './hostMonitor';

/** One sample every two seconds — htop's default delay, and cheap. */
export const MONITOR_POLL_MS = 2000;

/**
 * One priming poll after the sample that births the CPU deltas: the first
 * sample can only show unset bars (nothing to diff against), and waiting out
 * the full 2s cadence for the second one leaves a freshly opened panel dead
 * for two seconds. One quick follow-up turns the bars live inside ~1s; the
 * normal cadence resumes after it.
 */
export const MONITOR_PRIME_MS = 700;

/** Rendered rows per table, so a 2000-pid host cannot DOM the panel to death. */
export const MONITOR_RENDER_CAP = 300;

/**
 * The host answered with nothing any section could use — no ps, no /proc.
 * Distinguished from a transport error because the panel's copy differs:
 * "this host has nothing to monitor" vs "the link failed".
 */
export const MONITOR_NO_DATA =
  'The host answered nothing the monitor can draw — no process table, no /proc.';

export type MonitorSignal = 'TERM' | 'KILL';

export function useHostMonitor(connectionId: Ref<string | null>): {
  /** The newest sample; null until the first one lands. */
  sample: Ref<MonitorSample | null>;
  /** Per-core busy percentages between the last two samples ([0] aggregate). */
  cpuPercents: Ref<(number | null)[]>;
  /** Transport failure or {@link MONITOR_NO_DATA}; the last sample stays up under it. */
  error: Ref<string | null>;
  /** True until the FIRST sample lands — the quiet holding state. */
  loading: Ref<boolean>;
  /** Paused skips execs entirely; `resume` samples immediately. */
  paused: Ref<boolean>;
  pause: () => void;
  resume: () => void;
  /** One fresh sample now, paused or not. */
  refresh: () => Promise<void>;
  /** `kill -TERM/-KILL pid` over the same exec seam; re-samples right after. */
  kill: (pid: number, signal: MonitorSignal) => Promise<boolean>;
} {
  const sample = ref<MonitorSample | null>(null);
  const cpuPercents = ref<(number | null)[]>([]);
  const error = ref<string | null>(null);
  const loading = ref(false);
  const paused = ref(false);

  /** The previous sample's ticks — the left side of every CPU percentage. */
  let previousCpus: CpuTicks[] | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight = false;
  /** Set by the last `sampleNow` when it fetched the FIRST /proc ticks: the
   * NEXT sample is the one that turns the bars live, so it gets primed. */
  let bornTicks = false;

  function stopTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /** One exec + parse + delta fold. Drops the tick if one is already out. */
  async function sampleNow(): Promise<void> {
    const id = connectionId.value;
    if (!id || inflight) return;
    inflight = true;
    if (sample.value === null) loading.value = true;
    const hadNoTicks = previousCpus === null;
    try {
      const result = await api.ssh.exec(id, MONITOR_SNAPSHOT_COMMAND);
      const next = parseMonitorSample(result.stdout);
      if (next.cpus.length > 0) {
        cpuPercents.value = cpuPercentages(previousCpus, next.cpus);
        previousCpus = next.cpus;
      } else {
        cpuPercents.value = [];
        previousCpus = null;
      }
      bornTicks = hadNoTicks && next.cpus.length > 0;
      sample.value = next;
      error.value =
        next.processes.length === 0 && next.cpus.length === 0 && next.memory === null
          ? MONITOR_NO_DATA
          : null;
    } catch (e) {
      // The last good sample stays on screen under the error — a stale table
      // with a reason beats an empty one (UsageView's ruling, same panel
      // family). Transport drops surface here; the connection store's own
      // banner still tells the link-level story.
      error.value = errorMessage(e);
    } finally {
      inflight = false;
      loading.value = false;
    }
  }

  function schedule(delay: number = MONITOR_POLL_MS): void {
    stopTimer();
    timer = setTimeout(async () => {
      timer = null;
      if (paused.value) return;
      if (typeof document !== 'undefined' && document.hidden) {
        schedule();
        return;
      }
      await sampleNow();
      // The sample that fetched the FIRST /proc ticks cannot show percentages
      // (nothing to diff against) — the NEXT one can. One quick follow-up
      // turns the unset bars live within ~1s of open; the 2s cadence resumes.
      schedule(bornTicks ? MONITOR_PRIME_MS : MONITOR_POLL_MS);
    }, delay);
  }

  /** Schedule the next poll, priming it right after the first tick-bearing sample. */
  function scheduleNext(): void {
    schedule(bornTicks ? MONITOR_PRIME_MS : MONITOR_POLL_MS);
  }

  async function refresh(): Promise<void> {
    await sampleNow();
  }

  function pause(): void {
    paused.value = true;
    stopTimer();
  }

  function resume(): void {
    paused.value = false;
    // A resumed panel wants a sample now, not in two seconds.
    void sampleNow().then(scheduleNext);
  }

  async function kill(pid: number, signal: MonitorSignal): Promise<boolean> {
    const id = connectionId.value;
    const command = killCommand(pid, signal);
    if (!id || !command) return false;
    try {
      await api.ssh.exec(id, command);
    } catch {
      return false;
    }
    await sampleNow();
    return true;
  }

  // A reconnect mints a NEW connection id; the old host's sample and the
  // tick deltas are another machine's. Drop everything and sample fresh.
  watch(connectionId, (id) => {
    stopTimer();
    previousCpus = null;
    bornTicks = false;
    sample.value = null;
    cpuPercents.value = [];
    error.value = null;
    if (id !== null && !paused.value) void sampleNow().then(scheduleNext);
  });
  watch(paused, (isPaused) => {
    if (isPaused) stopTimer();
    else void sampleNow().then(scheduleNext);
  });

  // First mount: the watch above is not immediate.
  if (connectionId.value !== null) void sampleNow().then(scheduleNext);

  onScopeDispose(stopTimer);

  return {
    sample,
    cpuPercents,
    error,
    loading,
    paused,
    pause,
    resume,
    refresh,
    kill,
  };
}
