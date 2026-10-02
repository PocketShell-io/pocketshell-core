<script setup lang="ts">
// MonitorPanelView: the host monitor's body — the htop-style read of the
// connected box, drawn from `useHostMonitor`'s polled samples. Embedded in
// the monitor overlay (HostWorkspaceView), never routed to: a route would
// unmount the host workspace and take the terminals' scrollback with it,
// the same ruling the settings panel lives under.
//
// Layout, top to bottom: the stat strip (load, uptime, tasks — with the
// panel's two poll controls at its right end), the CPU/memory meters, and
// the process table. The poll controls live HERE rather than in the
// overlay header's action row where Usage's refresh sits, for one reason:
// this panel's pause is not garnish, it is the difference between a live
// meter and a stable number you can read and aim a kill from — so it sits
// beside the thing it freezes, not up in chrome the table does not own.
//
// The CPU bars are DELTAS between samples (hostMonitor.ts), so the first
// sample a freshly opened panel shows is an unset bar — one dash, not a
// fabricated 0% — and by the second (two seconds) it is live. The per-
// process CPU column is ps's lifetime average, and says so in its tooltip;
// per-process instantaneous rates would need a /proc/<pid>/stat exec per
// pid per poll, which is not a trade this panel makes.
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

const loadText = computed(() =>
  sample.value?.load
    ? `${sample.value.load.one.toFixed(2)} ${sample.value.load.five.toFixed(2)} ${sample.value.load.fifteen.toFixed(2)}`
    : '–',
);
const uptimeText = computed(() =>
  sample.value?.uptimeS === null || sample.value?.uptimeS === undefined
    ? '–'
    : formatUptime(sample.value.uptimeS),
);
/**
 * Three counts, three sources, three words — the loadavg figure is THREADS
 * (scheduler entities; htop's `12157 thr`), the process count is the ps
 * table's own length, and running is loadavg's first half of the fraction.
 * The old "tasks" label said all three were the same kind of thing.
 */
const processCount = computed(() => sample.value?.processes.length ?? 0);
const threadsCount = computed(() => sample.value?.load?.threads ?? null);
const runningCount = computed(() => sample.value?.load?.running ?? null);

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
function pctText(percent: number | null): string {
  return percent === null ? '–' : `${Math.round(percent)}%`;
}

/** The sampled wall clock, for the paused chip: a frozen meter must say when it froze. */
const sampledAt = computed(() =>
  sample.value === null ? '' : new Date(sample.value.at).toLocaleTimeString(),
);
</script>

<template>
  <div class="monitor">
    <!-- The first sample's holding line. Quiet: sampling is normal, not an alarm. -->
    <p v-if="loading && sample === null" class="sampling muted">
      Sampling {{ connection.activeHost?.name ?? 'the host' }}…
    </p>

    <template v-else-if="sample">
      <!-- A failure keeps the stale read on screen under it (UsageView's ruling). -->
      <p v-if="error" class="error fetch-error" role="alert">
        <span class="error-text">{{ error }}</span>
        <button class="retry" type="button" @click="onRefresh">Retry</button>
      </p>

      <section class="strip" aria-label="Host load">
        <div class="stats">
          <span class="stat"><span class="k">load</span> {{ loadText }}</span>
          <span class="stat"><span class="k">up</span> {{ uptimeText }}</span>
          <span class="stat"><span class="k">procs</span> {{ processCount }}</span>
          <span v-if="threadsCount !== null" class="stat">
            <span class="k">threads</span> {{ threadsCount }}
          </span>
          <span v-if="runningCount !== null" class="stat">
            <span class="k">running</span> {{ runningCount }}
          </span>
          <span v-if="paused" class="paused" role="status">paused — sampled {{ sampledAt }}</span>
        </div>
        <div class="tools">
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
      </section>

      <!-- Meters render only when the host exposed /proc — a ps-only host
           (macOS) gets the table without them, which the section's absence
           states more honestly than a row of empty wells would. The cores
           sit in a compact auto-fill GRID — htop's own layout — because a
           column of twelve full-width bars spends the panel's height
           repeating one number twelve times. -->
      <section v-if="sample.cpus.length > 0 || memoryBar" class="meters" aria-label="CPU and memory">
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
          </div>
          <span class="pct">{{ pctText(aggregatePercent) }}</span>
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
            </div>
            <span class="pct">{{ pctText(percent) }}</span>
          </div>
        </div>
        <div v-if="memoryBar" class="meter-row">
          <span class="meter-k">mem</span>
          <div
            class="meter"
            role="progressbar"
            :aria-valuenow="Math.round(memoryBar.percent)"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-label="Memory used"
          >
            <span class="meter-fill" :class="memTier(memoryBar.percent)" :style="{ width: `${memoryBar.percent}%` }" />
          </div>
          <span class="pct pair">{{ memoryBar.label }}</span>
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
          >
            <span class="meter-fill" :class="memTier(swapBar.percent)" :style="{ width: `${swapBar.percent}%` }" />
          </div>
          <span class="pct pair">{{ swapBar.label }}</span>
        </div>
      </section>

      <MonitorProcessTable :processes="sample.processes" :kill="monitor.kill" />
    </template>

    <p v-else class="empty">Nothing to monitor here.</p>
  </div>
</template>

<style scoped>
.monitor {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  width: 100%;
  min-width: 0;
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

/* The stat strip: figures read left to right, controls take the right end. */
.strip {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.stats {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: var(--sp-4);
  font-size: var(--fs-200);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
}
.stat .k {
  margin-right: var(--sp-1);
  font-size: var(--fs-100);
  font-weight: var(--fw-semibold);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-muted);
}
/* A frozen panel is a FACT about the numbers on screen — amber-tinted quiet,
   not an alarm and not invisible. */
.paused {
  color: var(--warning);
  font-size: var(--fs-100);
}
.tools {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}

/* The meters. The aggregate and the mem/swap rows carry their label in the
   gutter; the cores sit in the compact grid above. */
.meters {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.meter-row {
  display: grid;
  grid-template-columns: 36px 1fr 150px;
  column-gap: var(--sp-3);
  align-items: center;
}
/* htop packs its cores side by side; a 230px cell holds
   `10 [|||  ] 64%` comfortably, and auto-fill wraps. */
.core-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  column-gap: var(--sp-4);
  row-gap: var(--sp-1);
}
.meter-row.core {
  grid-template-columns: 24px 1fr 44px;
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
/* 8px on a --bg well, the usage panel's meter register. */
.meter {
  position: relative;
  height: 8px;
  background: var(--bg);
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
.pct {
  font-family: var(--font-mono);
  font-size: var(--fs-200);
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* A mem/swap row speaks a used/total PAIR (one unit, the total's) — wide
   enough for it at the meter font, never truncated into `32.6 GB / …`. */
.pct.pair {
  width: 150px;
}
</style>
