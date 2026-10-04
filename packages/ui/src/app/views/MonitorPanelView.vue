<script setup lang="ts">
// MonitorPanelView: the host monitor's body — the htop-style read of the
// connected box, drawn from `useHostMonitor`'s polled samples. Embedded in
// the monitor overlay (HostWorkspaceView), never routed to: a route would
// unmount the host workspace and take the terminals' scrollback with it,
// the same ruling the settings panel lives under.
//
// Layout, top to bottom: a slim controls row (the panel's two poll controls
// with the paused chip at their left), the two-column meters — htop's shape:
// the aggregate and per-core CPU bars on the left, memory, swap and the text
// meters (load, uptime, tasks) on the right — and the process table, which
// owns the panel's only scrollbar. The body is a FIXED frame (the settings
// tabs' precedent, DESIGN.md 5.7c): a monitor is a dashboard, and scrolling
// the table must not scroll its meters off the screen.
//
// The poll controls sit at the top of the body rather than in the overlay
// header's action row where Usage's refresh sits, for one reason: this
// panel's pause is not garnish, it is the difference between a live meter
// and a stable number you can read and aim a kill from — so it sits beside
// the things it freezes.
//
// The CPU bars are DELTAS between samples (hostMonitor.ts), primed by one
// quick follow-up poll (useHostMonitor), so the first sample a freshly
// opened panel shows is an unset meter — one dash, not a fabricated 0% —
// and within about a second it is live. The per-process CPU column is ps's
// lifetime average, and says so in its tooltip; per-process instantaneous
// rates would need a /proc/<pid>/stat exec per pid per poll, which is not a
// trade this panel makes.
import { computed, ref } from 'vue';
import AppIcon from '@ui/components/AppIcon.vue';
import MonitorProcessTable from '../components/MonitorProcessTable.vue';
import { useConnectionStore } from '../stores/connection';
import { useHostMonitor } from '../useHostMonitor';
import { formatKibPair, formatUptime } from '../hostMonitor';

const connection = useConnectionStore();

/** The poll loop dies with this component (onScopeDispose in the composable). */
const monitor = useHostMonitor(computed(() => connection.connectionId));
const { sample, cpuPercents, error, loading, paused } = monitor;

/** One manual refresh spinner, separate from the first-sample `loading`. */
const refreshing = ref(false);
async function onRefresh(): Promise<void> {
  refreshing.value = true;
  try {
    await monitor.refresh();
  } finally {
    refreshing.value = false;
  }
}

function togglePolling(): void {
  if (paused.value) monitor.resume();
  else monitor.pause();
}

/** `[0]` is the aggregate; the rest are the cores in kernel order. */
const corePercents = computed(() => cpuPercents.value.slice(1));
const aggregatePercent = computed(() => cpuPercents.value[0] ?? null);
/** The denominator that makes load average readable: cores, not the aggregate. */
const coresCount = computed(() => Math.max(0, (sample.value?.cpus.length ?? 1) - 1));

const uptimeText = computed(() =>
  sample.value?.uptimeS === null || sample.value?.uptimeS === undefined
    ? '–'
    : formatUptime(sample.value.uptimeS),
);
/**
 * Three counts, three sources, one row — the loadavg figure is THREADS
 * (scheduler entities; htop's `12157 thr`), the process count is the ps
 * table's own length, and running is loadavg's first half of the fraction.
 * The old "tasks" label said all three were the same kind of thing.
 */
const processCount = computed(() => sample.value?.processes.length ?? 0);
const threadsCount = computed(() => sample.value?.load?.threads ?? null);
const runningCount = computed(() => sample.value?.load?.running ?? null);
const tasksText = computed(() => {
  const parts = [`${processCount.value} procs`];
  if (threadsCount.value !== null) parts.push(`${threadsCount.value} thr`);
  if (runningCount.value !== null) parts.push(`${runningCount.value} running`);
  return parts.join(' · ');
});

const loadText = computed(() =>
  sample.value?.load
    ? `${sample.value.load.one.toFixed(2)} ${sample.value.load.five.toFixed(2)} ${sample.value.load.fifteen.toFixed(2)}`
    : '–',
);
/**
 * Load against capacity: a box is saturated when the 1-minute average carries
 * one runnable task per core, uncomfortable well before that. Null on hosts
 * that answered no /proc — no core count, no verdict.
 */
const loadTier = computed(() => {
  const load = sample.value?.load;
  const cores = coresCount.value;
  if (!load || cores === 0) return '';
  if (load.one >= cores) return 'crit';
  if (load.one >= cores * 0.7) return 'warn';
  return 'ok';
});

/** Used / total for the memory bars, in one unit, the total's. */
const memoryBar = computed(() => {
  const mem = sample.value?.memory;
  if (!mem || mem.totalKib === 0) return null;
  const used = mem.totalKib - mem.availableKib;
  return {
    label: formatKibPair(used, mem.totalKib),
    percent: Math.min(100, (used / mem.totalKib) * 100),
  };
});
const swapBar = computed(() => {
  const mem = sample.value?.memory;
  if (!mem || mem.swapTotalKib === 0) return null;
  const used = mem.swapTotalKib - mem.swapFreeKib;
  return {
    label: formatKibPair(used, mem.swapTotalKib),
    percent: Math.min(100, (used / mem.swapTotalKib) * 100),
  };
});

/** htop's traffic light: green to half, amber to four-fifths, red beyond. */
function cpuTier(percent: number | null): string {
  if (percent === null) return '';
  if (percent >= 80) return 'crit';
  if (percent >= 50) return 'warn';
  return 'ok';
}
function memTier(percent: number): string {
  if (percent >= 90) return 'crit';
  if (percent >= 70) return 'warn';
  return 'ok';
}
/** Whether the panel has meter BARS to draw — a ps-only host has none, and
 * their absence is the honesty (MONITOR.md §1); the text meters survive. */
const hasBars = computed(
  () => (sample.value?.cpus.length ?? 0) > 0 || memoryBar.value !== null || swapBar.value !== null,
);
function pctText(percent: number | null): string {
  return percent === null ? '–' : `${Math.round(percent)}%`;
}

/** The sampled wall clock, for the paused chip: a frozen meter must say when it froze. */
const sampledAt = computed(() =>
  sample.value === null ? '' : new Date(sample.value.at).toLocaleTimeString(),
);
/**
 * The host answered nothing any section could use — the MONITOR_NO_DATA case.
 * The panel says so and stops: no meter wells, no table skeleton with its
 * filter-mismatch copy, nothing that reads as a read of an absent host.
 */
const noData = computed(
  () =>
    sample.value !== null &&
    sample.value.processes.length === 0 &&
    sample.value.cpus.length === 0 &&
    sample.value.memory === null,
);
</script>

<template>
  <div class="monitor" :class="{ ready: sample !== null }">
    <!-- The first sample's holding line. Quiet: sampling is normal, not an alarm. -->
    <p v-if="loading && sample === null" class="sampling muted">
      Sampling {{ connection.activeHost?.name ?? 'the host' }}…
    </p>

    <template v-else-if="sample">
      <!-- The host answered nothing the monitor can draw: the banner is the
           whole body. A table skeleton under it would claim a read that
           never happened. -->
      <p v-if="noData" class="error fetch-error" role="alert">
        <span class="error-text">{{ error }}</span>
      </p>

      <template v-else>
        <!-- A failure keeps the stale read on screen under it (UsageView's ruling). -->
        <p v-if="error" class="error fetch-error" role="alert">
          <span class="error-text">{{ error }}</span>
          <button class="retry" type="button" @click="onRefresh">Retry</button>
        </p>

        <div class="tools">
          <span v-if="paused" class="paused" role="status">paused — sampled {{ sampledAt }}</span>
          <button class="btn-ghost" type="button" @click="togglePolling">
            {{ paused ? 'Resume' : 'Pause' }}
          </button>
          <button
            class="icon-btn"
            type="button"
            title="Sample now"
            :disabled="refreshing"
            @click="onRefresh"
          >
            <AppIcon name="refresh" :class="{ spin: refreshing }" />
          </button>
        </div>

      <!-- Two columns, htop's shape: bars left, memory/swap and the text
           meters right. A ps-only host (macOS) draws no BARS — their absence
           states the missing /proc more honestly than empty wells would —
           while the text meters (uptime aside, procs is ps-derived) still
           speak. -->
      <section
        class="meters"
        :class="{ 'no-bars': !hasBars }"
        :aria-label="hasBars ? 'CPU and memory' : 'Host statistics'"
      >
        <div v-if="hasBars" class="cpu-col">
          <div class="meter-row">
            <span class="meter-k">cpu</span>
            <div
              class="meter"
              role="progressbar"
              :aria-valuenow="aggregatePercent === null ? undefined : Math.round(aggregatePercent)"
              aria-valuemin="0"
              aria-valuemax="100"
              aria-label="All cores"
            >
              <span
                class="meter-fill"
                :class="cpuTier(aggregatePercent)"
                :style="{ width: aggregatePercent === null ? '0%' : `${aggregatePercent}%` }"
              />
              <span class="pct meter-val" aria-hidden="true">{{ pctText(aggregatePercent) }}</span>
            </div>
          </div>
          <div class="core-grid" aria-label="Per-core CPU">
            <div v-for="(percent, i) in corePercents" :key="i" class="meter-row core">
              <span class="meter-k" aria-hidden="true">{{ i }}</span>
              <div class="meter">
                <span
                  class="meter-fill"
                  :class="cpuTier(percent)"
                  :style="{ width: percent === null ? '0%' : `${percent}%` }"
                />
                <span class="pct meter-val" aria-hidden="true">{{ pctText(percent) }}</span>
              </div>
            </div>
          </div>
        </div>
        <div class="side-col">
          <div v-if="memoryBar" class="meter-row">
            <span class="meter-k">mem</span>
            <div
              class="meter"
              role="progressbar"
              :aria-valuenow="Math.round(memoryBar.percent)"
              aria-valuemin="0"
              aria-valuemax="100"
              aria-label="Memory used"
              :aria-valuetext="memoryBar.label"
            >
              <span class="meter-fill" :class="memTier(memoryBar.percent)" :style="{ width: `${memoryBar.percent}%` }" />
              <span class="pct pair meter-val" aria-hidden="true">{{ memoryBar.label }}</span>
            </div>
          </div>
          <div v-if="swapBar" class="meter-row">
            <span class="meter-k">swap</span>
            <div
              class="meter"
              role="progressbar"
              :aria-valuenow="Math.round(swapBar.percent)"
              aria-valuemin="0"
              aria-valuemax="100"
              aria-label="Swap used"
              :aria-valuetext="swapBar.label"
            >
              <span class="meter-fill" :class="memTier(swapBar.percent)" :style="{ width: `${swapBar.percent}%` }" />
              <span class="pct pair meter-val" aria-hidden="true">{{ swapBar.label }}</span>
            </div>
          </div>
          <div class="stats">
            <div class="stat">
              <span class="k">load</span>
              <span class="v mono" :class="loadTier">{{ loadText }}</span>
              <span v-if="coresCount > 0" class="of">of {{ coresCount }} cores</span>
            </div>
            <div class="stat">
              <span class="k">up</span>
              <span class="v mono">{{ uptimeText }}</span>
            </div>
            <div class="stat">
              <span class="k">tasks</span>
              <span class="v mono">{{ tasksText }}</span>
            </div>
          </div>
        </div>
      </section>

        <MonitorProcessTable :processes="sample.processes" :kill="monitor.kill" />
      </template>
    </template>

    <p v-else class="empty">Nothing to monitor here.</p>
  </div>
</template>

<style scoped>
.monitor {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  width: 100%;
  min-width: 0;
  padding: var(--sp-4);
}
/* Once a sample is on screen the body becomes a fixed frame — the settings
   tabs' precedent (DESIGN.md 5.7c) — so the table scrolls INSIDE the panel
   and the meters never leave the viewport (the table owns the only
   scrollbar). Before that, the panel sizes to the holding line. */
.monitor.ready {
  height: min(640px, 70vh);
}
.sampling {
  margin: 0;
  padding: var(--sp-4) 0;
}
/* The failure line, with its one action at the right end. */
.fetch-error {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin: 0;
}
.error-text {
  flex: 1;
  min-width: 0;
}
.retry {
  flex: none;
  height: var(--control-h-sm, 26px);
  padding: 0 var(--sp-3);
  background: transparent;
  border: 1px solid var(--error);
  border-radius: var(--r-md);
  color: var(--error);
  font-family: var(--font-ui);
  font-size: var(--fs-200);
  font-weight: var(--fw-semibold);
  cursor: pointer;
}
.retry:hover {
  background: var(--error-soft);
}

/* The poll controls: the panel's only chrome, parked at the top right with
   the paused chip at their left — a frozen panel is a FACT about the numbers
   on screen, amber-tinted quiet, not an alarm and not invisible. */
.tools {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-2);
}
.paused {
  margin-right: auto;
  color: var(--warning);
  font-size: var(--fs-100);
}

/* The meters: two columns — htop's shape. Bars left (aggregate + cores),
   memory/swap and the text meters right. */
.meters {
  flex: none;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 340px);
  gap: var(--sp-2) var(--sp-5);
  align-items: start;
}
/* A ps-only host: no bars, so the text meters take the whole width. */
.meters.no-bars {
  grid-template-columns: 1fr;
}
.cpu-col,
.side-col {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-width: 0;
}
.meter-row {
  display: grid;
  grid-template-columns: 36px 1fr;
  column-gap: var(--sp-3);
  align-items: center;
}
/* htop packs its cores side by side; auto-fill wraps, two per row here. */
.core-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  column-gap: var(--sp-4);
  row-gap: var(--sp-2);
}
.meter-row.core {
  grid-template-columns: 20px 1fr;
}
.meter-k {
  font-size: var(--fs-100);
  font-weight: var(--fw-semibold);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-muted);
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.meter-row.core .meter-k {
  text-transform: none;
  letter-spacing: 0;
}
/* One text-height track: a meter is a bar and its figure in ONE fixation.
   The hairline border is what keeps the unset state a meter, not a hole. */
.meter {
  position: relative;
  height: 18px;
  background: var(--bg);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-sm);
  overflow: hidden;
}
/* htop's pipe meter: one repeating overlay slices fill and track into
   segments, so the bar reads as ticks at a glance and a PARTIAL fill is
   countable rather than a smooth wash. The ticks are --bg, the track's own
   colour — no new token, no new colour. */
.meter::after {
  content: '';
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(90deg, transparent 0 3px, var(--bg) 3px 5px);
  pointer-events: none;
}
.meter-fill {
  display: block;
  height: 100%;
  border-radius: var(--r-sm);
  background: var(--fg-muted);
  transition: width var(--dur-normal) var(--ease);
}
.meter-fill.ok {
  background: var(--success);
}
.meter-fill.warn {
  background: var(--warning);
}
.meter-fill.crit {
  background: var(--error);
}
/* The figure lives in the track's right end, htop's way — a surface chip so
   the digits stay legible over empty track and full fill alike. Above the
   pipe texture (the ::after overlay would otherwise slice the digits). */
.meter-val {
  position: absolute;
  right: 2px;
  top: 50%;
  transform: translateY(-50%);
  max-width: calc(100% - 6px);
  padding: 2px 5px;
  background: var(--surface-2);
  border-radius: 3px;
  text-align: right;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  box-sizing: border-box;
  z-index: 1;
}
.pct {
  font-family: var(--font-mono);
  font-size: var(--fs-100);
  font-variant-numeric: tabular-nums;
  color: var(--fg);
}

/* The text meters: load, uptime, tasks — the strip's figures, demoted from
   caption row to their honest rank: load is the headline, tier-coloured
   against the core count it is measured against. */
.stats {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  margin-top: var(--sp-2);
  padding-top: var(--sp-2);
  border-top: 1px solid var(--border-soft);
}
.stat {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  min-width: 0;
  line-height: var(--lh-200);
}
.stat .k {
  flex: none;
  width: 40px;
  font-size: var(--fs-100);
  font-weight: var(--fw-semibold);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-muted);
}
.stat .v {
  font-size: var(--fs-200);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stat .v.ok {
  color: var(--success);
}
.stat .v.warn {
  color: var(--warning);
}
.stat .v.crit {
  color: var(--error);
}
.of {
  font-size: var(--fs-100);
  color: var(--fg-secondary);
  white-space: nowrap;
}
</style>
