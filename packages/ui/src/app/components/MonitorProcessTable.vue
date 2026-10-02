<script setup lang="ts">
// MonitorProcessTable: the htop half of the monitor panel — the process
// table with its filter, sort and the two-step kill.
//
// It owns the filter and the sort because both are table state with no
// other consumer (the poll loop in useHostMonitor holds everything two
// surfaces could share; nothing else wants this table's query). The kill
// arrives as a prop function — the composable's own `kill`, passed through
// the panel — so the arm/confirm choreography can live beside the button
// that performs it and still end in the one exec seam.
//
// Killing a remote process is destructive with no undo, so it is a
// TWO-CLICK verb: the first press arms ("TERM" → "sure?"), the second
// fires, and touching anything else — the other signal, the filter,
// another sort — disarms. That is the inline cousin of the session Stop
// confirm (useSessionStop): same refusal to kill on a single click, sized
// for a table where the victim is already the focused row. The second
// press needs no dialog because it names what it kills by being ON the
// row; the pid in the row is the label.
import { computed, ref } from 'vue';
import AppIcon from '@ui/components/AppIcon.vue';
import {
  MONITOR_RENDER_CAP,
  type MonitorSignal,
} from '../useHostMonitor';
import {
  formatProcessTime,
  sortProcesses,
  type ProcessRow,
  type ProcessSortKey,
} from '../hostMonitor';

const props = defineProps<{
  /** The sample's process list, as parsed — unfiltered, unsorted. */
  processes: readonly ProcessRow[];
  /**
   * The panel's kill verb (`useHostMonitor().kill`): resolves false when
   * the exec failed or the link is gone. Awaited here so the armed button
   * shows the work.
   */
  kill: (pid: number, signal: MonitorSignal) => Promise<boolean>;
}>();

/** The table's filter — pid, user or command substring, one box. */
const filter = ref('');
/** Sort state; CPU descending is htop's own landing order. */
const sortKey = ref<ProcessSortKey>('cpu');
const descending = ref(true);

const query = computed(() => filter.value.trim().toLowerCase());
const filtered = computed<readonly ProcessRow[]>(() => {
  const rows = props.processes;
  const q = query.value;
  if (!q) return rows;
  return rows.filter(
    (row) =>
      row.command.toLowerCase().includes(q) ||
      row.user.toLowerCase().includes(q) ||
      String(row.pid).includes(q),
  );
});
const total = computed(() => filtered.value.length);
const visible = computed(() =>
  sortProcesses(filtered.value, sortKey.value, descending.value).slice(0, MONITOR_RENDER_CAP),
);
const capped = computed(() => total.value > MONITOR_RENDER_CAP);

/** Same key flips the direction; a new key lands in its heavier direction. */
function sortBy(key: ProcessSortKey): void {
  if (sortKey.value === key) {
    descending.value = !descending.value;
  } else {
    sortKey.value = key;
    descending.value = key !== 'user' && key !== 'command';
  }
  armed.value = null;
}

/** Column captions in header order — the key IS the field name (hostMonitor). */
const COLUMNS: { key: ProcessSortKey; label: string; title: string }[] = (
  ['cpu', 'mem', 'timeS', 'pid', 'user', 'command'] as const
).map((key) => ({
  key,
  label: key === 'timeS' ? 'time' : key,
  title:
    key === 'cpu'
      ? 'CPU — lifetime average as ps reports it'
      : key === 'mem'
        ? 'Memory — share of physical memory'
        : key === 'timeS'
          ? 'Cumulative CPU time'
          : key,
}));

/** The one armed kill, if any: touching anything else disarms it. */
const armed = ref<{ pid: number; signal: MonitorSignal } | null>(null);
const killing = ref(false);

function onKill(pid: number, signal: MonitorSignal): void {
  if (killing.value) return;
  if (armed.value?.pid === pid && armed.value.signal === signal) {
    armed.value = null;
    killing.value = true;
    void props
      .kill(pid, signal)
      .finally(() => {
        killing.value = false;
      });
    return;
  }
  armed.value = { pid, signal };
}

/** The button's word: the armed press names itself as the confirmation. */
function killLabel(pid: number, signal: MonitorSignal): string {
  return armed.value?.pid === pid && armed.value.signal === signal ? 'sure?' : signal;
}
</script>

<template>
  <div class="ptable">
    <div class="ptool">
      <div class="filter-field">
        <AppIcon name="search" :size="12" class="filter-mark" />
        <input
          v-model="filter"
          class="filter-input"
          type="text"
          spellcheck="false"
          autocomplete="off"
          placeholder="filter — pid, user, command"
          aria-label="Filter processes"
        />
      </div>
      <span class="count muted" role="status">
        {{ total }} process{{ total === 1 ? '' : 'es' }}<template v-if="capped">
          — showing {{ MONITOR_RENDER_CAP }}</template
        >
      </span>
    </div>

    <div class="pgrid head">
      <span class="th">pid</span>
      <button
        v-for="col in COLUMNS.slice(1)"
        :key="col.key"
        class="th sort"
        :class="{ on: sortKey === col.key }"
        type="button"
        :aria-pressed="sortKey === col.key"
        :title="col.title"
        @click="sortBy(col.key)"
      >
        {{ col.label }}
        <AppIcon v-if="sortKey === col.key" name="arrow-up-down" :size="12" />
      </button>
      <span class="th acts" aria-hidden="true" />
    </div>

    <div class="pbody">
      <div v-for="row in visible" :key="row.pid" class="pgrid prow">
        <span class="cell mono pid">{{ row.pid }}</span>
        <span class="cell cpu" :title="`${row.cpu.toFixed(1)}% — ps lifetime average`">{{
          row.cpu.toFixed(1)
        }}</span>
        <span class="cell mono">{{ row.mem.toFixed(1) }}</span>
        <span class="cell mono time">{{ formatProcessTime(row.timeS) }}</span>
        <span class="cell mono">{{ row.user }}</span>
        <span class="cell cmd" :title="row.command">{{ row.command || '(no command line)' }}</span>
        <span class="cell acts">
          <button
            class="kill"
            :class="{ armed: armed?.pid === row.pid && armed.signal === 'TERM' }"
            type="button"
            :disabled="killing"
            :title="`Send SIGTERM to pid ${row.pid}`"
            @click="onKill(row.pid, 'TERM')"
          >
            {{ killLabel(row.pid, 'TERM') }}
          </button>
          <button
            class="kill danger"
            :class="{ armed: armed?.pid === row.pid && armed.signal === 'KILL' }"
            type="button"
            :disabled="killing"
            :title="`Send SIGKILL to pid ${row.pid}`"
            @click="onKill(row.pid, 'KILL')"
          >
            {{ killLabel(row.pid, 'KILL') }}
          </button>
        </span>
      </div>
      <p v-if="capped" class="note muted">
        and {{ total - MONITOR_RENDER_CAP }} more — refine the filter to see them.
      </p>
      <p v-else-if="total === 0" class="empty">No process matches “{{ filter }}”.</p>
    </div>
  </div>
</template>

<style scoped>
.ptable {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  width: 100%;
}

/* pid user cpu mem time command actions */
.pgrid {
  display: grid;
  grid-template-columns:
    52px 76px 48px 48px 84px minmax(160px, 1fr) 108px;
  column-gap: var(--sp-3);
  align-items: center;
}

.ptool {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin-bottom: var(--sp-3);
}
.filter-field {
  position: relative;
  flex: 0 1 280px;
  min-width: 160px;
}
.filter-mark {
  position: absolute;
  left: var(--sp-2);
  top: 50%;
  transform: translateY(-50%);
  color: var(--fg-muted);
  pointer-events: none;
}
.filter-input {
  width: 100%;
  height: var(--control-h-sm, 26px);
  padding: 0 var(--sp-2) 0 calc(var(--sp-4) + var(--sp-2));
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  color: var(--fg);
  font-family: var(--font-ui);
  font-size: var(--fs-200);
}
.filter-input:focus {
  outline: none;
  border-color: var(--accent-dim);
}
.filter-input::placeholder {
  color: var(--fg-muted);
}
/* The count takes the slack; a long filter shrinks the field, not the count. */
.count {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-100);
  text-align: right;
}

/* Column captions: the app's .th treatment (UsageView), clickable where the
   column sorts. pid is fixed ascending — a sort nobody asks for. */
.th {
  font-size: var(--fs-100);
  line-height: var(--lh-100);
  font-weight: var(--fw-semibold);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-muted);
  padding-bottom: var(--sp-1);
  text-align: left;
}
.th.sort {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  background: none;
  border: none;
  padding: 0 0 var(--sp-1);
  cursor: pointer;
  font: inherit;
  text-transform: inherit;
  letter-spacing: inherit;
  color: inherit;
}
.th.sort:hover {
  color: var(--fg);
}
.th.sort.on {
  color: var(--accent);
}
.head {
  border-bottom: 1px solid var(--border);
  padding-bottom: 1px;
}

.pbody {
  overflow-y: auto;
  min-height: 120px;
}
.prow {
  min-height: var(--row-h, 28px);
  padding: var(--sp-1) 0;
  border-bottom: 1px solid var(--border-soft);
}
/* Mono figures for the numbers, so pid/time columns form one clean edge. */
.mono {
  font-family: var(--font-mono);
  font-size: var(--fs-200);
  font-variant-numeric: tabular-nums;
}
.pid {
  color: var(--fg-secondary);
}
.cpu {
  font-family: var(--font-mono);
  font-size: var(--fs-200);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
/* The command is the row's identity: single line, ellipsis on overflow, the
   full argv in the title. */
.cmd {
  font-family: var(--font-mono);
  font-size: var(--fs-200);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.time {
  white-space: nowrap;
}

.acts {
  display: flex;
  gap: var(--sp-1);
  justify-content: flex-end;
}
/* The two-step kill's buttons. Ghost at rest — a table where every row
   carries two loud buttons is a wall of danger; the word shows on hover and
   the armed press fills. */
.kill {
  height: 20px;
  padding: 0 var(--sp-2);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--fg-secondary);
  font-family: var(--font-ui);
  font-size: 10px;
  font-weight: var(--fw-semibold);
  letter-spacing: 0.04em;
  cursor: pointer;
  opacity: 0;
  transition:
    opacity var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.prow:hover .kill,
.kill:focus-visible,
.kill.armed {
  opacity: 1;
}
.kill:hover:not(:disabled) {
  background: var(--state-hover);
  color: var(--fg);
}
.kill.armed {
  background: var(--warning-soft);
  border-color: var(--warning);
  color: var(--warning);
}
.kill.danger.armed {
  background: var(--error-soft);
  border-color: var(--error);
  color: var(--error);
}
.kill:disabled {
  cursor: default;
}

.note {
  margin: var(--sp-2) 0 0;
  font-size: var(--fs-100);
}
.ptable .empty {
  padding: var(--sp-3) 0;
}
</style>
