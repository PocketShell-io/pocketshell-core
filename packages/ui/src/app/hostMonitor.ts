/**
 * The host monitor's data contract: the ONE remote command a monitor poll
 * runs, and the pure parsers that turn its output into the sample a view
 * draws. Everything here is sync and side-effect-free so the poll loop
 * (`useHostMonitor.ts`) and the panel stay thin, and the whole contract can
 * be held to fixed transcripts in tests. docs/MONITOR.md is the feature's
 * decision record; this header only states the transport-shaped ones.
 *
 * One exec per sample, not a stream. The monitor is a panel the user opens
 * to look at a host for a minute; a request/response the panel can pause,
 * and that dies with the connection like every other exec, costs less
 * machinery than a push channel main would have to own per open panel. The
 * renderer already holds `api.ssh.exec` — the same seam
 * `stores/workspaceRoots.ts` builds on — so no new IPC verb exists for this
 * feature, and any client that can exec gets the monitor.
 *
 * One command for the whole sample. A poll that ran one exec per section
 * would show a memory bar and a process list sampled seconds apart; the
 * sections below arrive in a single stdout, under literal `==name==`
 * markers, so one parse sees one instant. `ps` is emitted FIRST because it
 * is the only section a non-Linux host can answer — on a macOS box the
 * /proc cats fail, the marker sections come back empty, and the panel still
 * gets a process table (without the bars) rather than nothing.
 *
 * `LC_ALL=C` on the ps call: pcpu/pmem are decimal numbers, and a host with
 * a comma decimal locale would otherwise hand back `12,5` — parseable only
 * by guessing. The locale is pinned for the one section that parses numbers.
 *
 * CPU percentages are computed from TICK DELTAS between samples, client
 * side, not from a remote `sleep 1 && cat /proc/stat` pair. A sleep inside
 * the command would put its own latency under every poll and double the
 * channel cost to answer a question the previous sample already half
 * knows; the first sample a panel receives has no previous to diff against,
 * so `cpuPercent` answers null and the view shows an unset bar until the
 * second one lands. This is also why the raw ticks, not ready percentages,
 * are the type the parser returns.
 *
 * Process kills travel the same exec seam with a WHITELISTED signal name
 * and a validated pid (`killCommand`) — the pid arrives from our own parse
 * of `ps` output, and the builder re-proves it an integer before it
 * touches a command string, so nothing remote can shape what we run.
 */

import { formatBytes } from '@pocketshell/core';

/** Cumulative CPU ticks from one `/proc/stat` `cpu` line. */
export interface CpuTicks {
  /** `idle` + `iowait` — ticks the kernel had nothing ready to run in. */
  idle: number;
  /** The first eight tick fields summed — every tick the counter saw. */
  total: number;
}

/** `/proc/meminfo` memory figures, in the kB the kernel reports (KiB). */
export interface MemorySample {
  totalKib: number;
  /** `MemAvailable`, with the buffers/cached fallback for old kernels. */
  availableKib: number;
  swapTotalKib: number;
  swapFreeKib: number;
}

/** `/proc/loadavg` — the three averages plus the running/total task counts. */
export interface LoadSample {
  one: number;
  five: number;
  fifteen: number;
  running: number;
  tasks: number;
}

/** One `ps -eo …` row. `timeS` is the process's cumulative CPU time. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  user: string;
  /** Lifetime CPU percent, as `ps` reports it — not the instantaneous rate. */
  cpu: number;
  mem: number;
  timeS: number;
  command: string;
}

/**
 * One monitor sample: a process table plus whatever header sections the
 * host could answer. Every /proc-derived member is nullable — a macOS host,
 * a container without /proc mounted, or a hardened kernel each leave the
 * section empty, and the panel says so per section rather than failing the
 * whole sample the one absent quarter would kill.
 */
export interface MonitorSample {
  /** Wall-clock at parse (`Date.now()`), the x of any sparkline later. */
  at: number;
  processes: ProcessRow[];
  /**
   * `[0]` is the all-core aggregate, `[1..]` one entry per core in kernel
   * order. Empty when `/proc/stat` was unreadable — the bars' "no data".
   */
  cpus: CpuTicks[];
  memory: MemorySample | null;
  load: LoadSample | null;
  uptimeS: number | null;
}

/**
 * The whole sample in one command. Section markers are literals the parser
 * splits on; the per-cat `2>/dev/null` keeps a missing file from writing
 * usage noise into stderr the result object would carry for nothing. `ps`
 * runs under `LC_ALL=C` (module header); `ps -eo` field choice is the
 * common denominator of procps and BusyBox.
 */
export const MONITOR_SNAPSHOT_COMMAND =
  "echo '==ps=='; LC_ALL=C ps -eo pid,ppid,user,pcpu,pmem,time,args; " +
  "echo '==stat=='; cat /proc/stat 2>/dev/null; " +
  "echo '==mem=='; cat /proc/meminfo 2>/dev/null; " +
  "echo '==load=='; cat /proc/loadavg 2>/dev/null; " +
  "echo '==up=='; cat /proc/uptime 2>/dev/null";

/** The literal a section starts under — also the next section's boundary. */
const MARKER = /^==([a-z]+)==\s*$/m;

/** The body of one marked section, or '' when the host never emitted it. */
function section(stdout: string, name: string): string {
  const open = new RegExp(`^==${name}==\\s*$`, 'm').exec(stdout);
  if (!open) return '';
  const rest = stdout.slice(open.index + open[0].length);
  const next = MARKER.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

/** `MM:SS`, `HH:MM:SS`, or `DD-HH:MM:SS` — procps's `TIME` spellings. */
export function parseProcessTime(text: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!m) return 0;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  return ((days * 24 + hours) * 60 + Number(m[3])) * 60 + Number(m[4]);
}

/**
 * One `ps` body line, fixed field order `pid ppid user pcpu pmem time args`.
 * The command takes EVERYTHING after the sixth field, spaces included — a
 * process is named by its argv, and argv is not ours to trim words from.
 * Returns null for whatever is not a data row (the header, a mangled line).
 */
function parseProcessLine(line: string): ProcessRow | null {
  const m =
    /^(\d+)\s+(\d+)\s+(\S+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\S+)\s?(.*)$/.exec(line);
  if (!m) return null;
  // Every group participates in a match (only the command may be empty), so
  // the `?? ''` is the noUncheckedIndexedAccess guard, not a real fallback.
  const g = (i: number): string => m[i] ?? '';
  return {
    pid: Number(g(1)),
    ppid: Number(g(2)),
    user: g(3),
    cpu: Number(g(4)),
    mem: Number(g(5)),
    timeS: parseProcessTime(g(6)),
    command: g(7),
  };
}

function parseStat(body: string): CpuTicks[] {
  const aggregate: CpuTicks[] = [];
  const cores: CpuTicks[] = [];
  for (const line of body.split('\n')) {
    const m = /^cpu(\d*)\s+(.+)$/.exec(line);
    if (!m) continue;
    const body = m[2] ?? '';
    const fields = body.trim().split(/\s+/).map(Number).filter((n) => Number.isFinite(n));
    if (fields.length < 4) continue;
    const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
    const total = fields.slice(0, 8).reduce((a, b) => a + b, 0);
    const ticks = { idle, total };
    if (m[1] === '') aggregate.push(ticks);
    else cores[Number(m[1])] = ticks;
  }
  // Core holes (a kernel hot-unplugging a cpu) collapse out; the aggregate
  // keeps its slot 0 either way.
  return [...aggregate, ...cores.filter(Boolean)];
}

function parseMemInfo(body: string): MemorySample | null {
  const kib = new Map<string, number>();
  for (const line of body.split('\n')) {
    const m = /^(\w+):\s+(\d+)\s+kB\s*$/.exec(line);
    if (m) kib.set(m[1] ?? '', Number(m[2]));
  }
  const total = kib.get('MemTotal');
  if (total === undefined) return null;
  const freeFallback =
    total -
    (kib.get('MemFree') ?? 0) -
    (kib.get('Buffers') ?? 0) -
    (kib.get('Cached') ?? 0);
  return {
    totalKib: total,
    availableKib: kib.get('MemAvailable') ?? Math.max(0, freeFallback),
    swapTotalKib: kib.get('SwapTotal') ?? 0,
    swapFreeKib: kib.get('SwapFree') ?? 0,
  };
}

function parseLoad(body: string): LoadSample | null {
  const m = /^([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\/(\d+)\s+\d+/.exec(body);
  if (!m) return null;
  return {
    one: Number(m[1]),
    five: Number(m[2]),
    fifteen: Number(m[3]),
    running: Number(m[4]),
    tasks: Number(m[5]),
  };
}

/** Parse one snapshot's stdout. Never throws: a section it cannot read is null/empty. */
export function parseMonitorSample(stdout: string, now: number = Date.now()): MonitorSample {
  return {
    at: now,
    processes: section(stdout, 'ps')
      .split('\n')
      // procps pads its columns, so a data row opens with spaces — trim
      // before the anchored match, or every row dies at `^(\d+)`.
      .map((line) => parseProcessLine(line.trim()))
      .filter((row): row is ProcessRow => row !== null),
    cpus: parseStat(section(stdout, 'stat')),
    memory: parseMemInfo(section(stdout, 'mem')),
    load: parseLoad(section(stdout, 'load')),
    uptimeS: (() => {
      const up = Number(section(stdout, 'up').split(/\s+/)[0]);
      return Number.isFinite(up) && up > 0 ? up : null;
    })(),
  };
}

/**
 * Busy percent between two tick snapshots of the same counter — null when
 * the counter did not move (a first sample, a suspended guest, a wrap so
 * tight the delta vanished): an unset bar, never a fabricated 0%.
 */
export function cpuPercent(previous: CpuTicks, current: CpuTicks): number | null {
  const total = current.total - previous.total;
  if (total <= 0) return null;
  const idle = current.idle - previous.idle;
  return Math.min(100, Math.max(0, (1 - idle / total) * 100));
}

/**
 * Per-core busy percentages between samples, `null`-padded where either
 * side has no matching core (the first sample; a core count that changed
 * under us). `[0]` is the aggregate's percent.
 */
export function cpuPercentages(
  previous: readonly CpuTicks[] | null,
  current: readonly CpuTicks[],
): (number | null)[] {
  if (!previous) return current.map(() => null);
  return current.map((ticks, i) => {
    const prev = previous[i];
    return prev ? cpuPercent(prev, ticks) : null;
  });
}

/**
 * The kill command for a parsed row's pid — or null when the pid is not a
 * positive integer, which is the whole validation. The signal is one of
 * two literals, so the command string has no other movable part.
 */
export function killCommand(pid: number, signal: 'TERM' | 'KILL'): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return `kill -${signal} ${pid}`;
}

/**
 * The columns the process table can be ordered by, in header order — the
 * `ProcessRow` field names themselves, so a key can never decouple from
 * the field it sorts (the column LABEL is the view's business).
 */
export const PROCESS_SORT_KEYS = ['cpu', 'mem', 'timeS', 'pid', 'user', 'command'] as const;
export type ProcessSortKey = (typeof PROCESS_SORT_KEYS)[number];

/**
 * A sorted COPY — the table re-sorts per keystroke and the previous order
 * is what a flipped sort arrow must be derived from, so the input array is
 * never reordered in place.
 */
export function sortProcesses(
  rows: readonly ProcessRow[],
  key: ProcessSortKey,
  descending: boolean,
): ProcessRow[] {
  const dir = descending ? -1 : 1;
  return [...rows].sort((a, b) => {
    const va = a[key];
    const vb = b[key];
    const cmp =
      typeof va === 'string' && typeof vb === 'string'
        ? va.localeCompare(vb)
        : Number(va) - Number(vb);
    return cmp * dir || a.pid - b.pid;
  });
}

/**
 * `1234567` → `1.2 GB`; meminfo speaks KiB and `formatBytes` speaks bytes.
 * The ONE byte ladder the app formats with (`@pocketshell/core`'s
 * byteSize.ts) — a monitor bar and a Files row must never disagree about
 * how big the same memory figure is.
 */
export function formatKib(kib: number): string {
  return formatBytes(kib * 1024);
}

/** Seconds elapsed → `5d 3h`, `2h 15m`, `8m 40s`, `42s` — two units, no zeros. */
export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Cumulative CPU seconds → procps's own `[dd-]hh:mm:ss` spelling, back again. */
export function formatProcessTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const hh = String(hours).padStart(2, '0');
  const mm = String(mins).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  const core = days > 0 ? `${days}-${hh}:${mm}:${ss}` : hours > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
  return core;
}
