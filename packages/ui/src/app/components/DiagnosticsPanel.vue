<script setup lang="ts">
// DiagnosticsPanel: the local support reports a platform keeps, listed for
// review before anything leaves the device (0.5.x Settings → Diagnostics and
// its per-report page).
//
// The platform owns storage (`api.diagnostics`) and records reports already
// redacted by core's diagnosticReports.ts; this panel only lists, opens,
// shares and deletes them. Nothing is sent anywhere until the user picks
// Share, and a share goes through the platform's own share sheet.
//
// Delete and Clear use the composer's two-click arm rather than a modal: the
// panel renders inside a Settings overlay on desktop and a narrow phone
// screen, and a second dialog over either is more chrome than the decision
// deserves. The armed button names what it removes.
import { computed, onMounted, ref } from 'vue';
import AppIcon from '@ui/components/AppIcon.vue';
import { formatDiagnosticReportsForSharing, type DiagnosticReport } from '@pocketshell/core';
import { diagnosticsCapability, listDiagnosticReports } from '../platformCapabilities';

const reports = ref<DiagnosticReport[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);
const openId = ref<string | null>(null);
const armedDeleteId = ref<string | null>(null);
const clearArmed = ref(false);
const status = ref<string | null>(null);

const SOURCE_LABELS: Record<DiagnosticReport['source'], string> = {
  'runtime-error': 'App error',
  'native-crash': 'Native crash',
  'imported-crash': 'Imported from 0.5.x',
  'imported-history': 'Imported from 0.5.x',
};

const hasReports = computed(() => reports.value.length > 0);

async function load(): Promise<void> {
  const diagnostics = diagnosticsCapability();
  if (!diagnostics) return;
  loading.value = true;
  loadError.value = null;
  try {
    reports.value = (await listDiagnosticReports(diagnostics)) ?? [];
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function when(report: DiagnosticReport): string {
  return report.at === null ? 'Time unknown' : new Date(report.at).toLocaleString();
}

function toggle(id: string): void {
  openId.value = openId.value === id ? null : id;
  armedDeleteId.value = null;
}

function fileNameFor(subject: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `pocketshell-${subject}-${stamp}.txt`;
}

async function share(target: readonly DiagnosticReport[], subject: string): Promise<void> {
  const diagnostics = diagnosticsCapability();
  if (!diagnostics || target.length === 0) return;
  status.value = null;
  try {
    const outcome = await diagnostics.share({
      fileName: fileNameFor(subject),
      text: formatDiagnosticReportsForSharing(target, Date.now()),
    });
    status.value = outcome === 'shared' ? 'Report handed to the share sheet.' : outcome === 'saved' ? 'Report saved.' : null;
  } catch (error) {
    status.value = `Could not share: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function removeReport(report: DiagnosticReport): Promise<void> {
  const diagnostics = diagnosticsCapability();
  if (!diagnostics) return;
  if (armedDeleteId.value !== report.id) {
    armedDeleteId.value = report.id;
    return;
  }
  armedDeleteId.value = null;
  try {
    if (await diagnostics.remove(report.id)) {
      reports.value = reports.value.filter((candidate) => candidate.id !== report.id);
      if (openId.value === report.id) openId.value = null;
      status.value = 'Report deleted from this device.';
    } else {
      status.value = 'That report was already gone.';
      await load();
    }
  } catch (error) {
    status.value = `Could not delete: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function clearAll(): Promise<void> {
  const diagnostics = diagnosticsCapability();
  if (!diagnostics) return;
  if (!clearArmed.value) {
    clearArmed.value = true;
    return;
  }
  clearArmed.value = false;
  try {
    const removed = await diagnostics.clear();
    status.value = `Removed ${removed} local report${removed === 1 ? '' : 's'}. Hosts, keys and remote sessions are unchanged.`;
  } catch (error) {
    status.value = `Could not clear: ${error instanceof Error ? error.message : String(error)}`;
  }
  await load();
}
</script>

<template>
  <div class="diagnostics" data-testid="diagnostics-panel">
    <p class="row-hint">
      Crashes and unexpected errors are kept on this device until you choose to share
      them. Host names, paths and credentials are redacted; review a report before
      sharing, because terminal excerpts can remain.
    </p>

    <p v-if="loading" class="row-hint" role="status">Loading local reports…</p>
    <p v-else-if="loadError" class="notice" role="alert">
      <AppIcon name="alert-triangle" :size="14" />
      <span>Could not load reports: {{ loadError }}</span>
      <button class="btn-ghost" @click="load">Retry</button>
    </p>
    <p v-else-if="!hasReports" class="row-hint" data-testid="diagnostics-empty">No diagnostic reports.</p>

    <ul v-else class="reports" data-testid="diagnostics-reports">
      <li v-for="report in reports" :key="report.id" class="report" :data-report-id="report.id">
        <button
          class="report-head"
          :aria-expanded="openId === report.id"
          :data-testid="`diagnostics-report-${report.id}`"
          @click="toggle(report.id)"
        >
          <AppIcon :name="openId === report.id ? 'chevron-down' : 'chevron-right'" :size="14" />
          <span class="report-text">
            <span class="report-title">{{ report.title }}</span>
            <span class="report-meta">{{ when(report) }} · {{ SOURCE_LABELS[report.source] }}</span>
          </span>
        </button>
        <div v-if="openId === report.id" class="report-body">
          <pre class="report-preview" data-testid="diagnostics-report-body">{{ report.body }}</pre>
          <div class="actions">
            <button class="btn-ghost" data-testid="diagnostics-share-report" @click="share([report], 'report')">
              <AppIcon name="external-link" :size="14" />
              Share report
            </button>
            <button
              class="btn-ghost danger"
              data-testid="diagnostics-delete-report"
              @click="removeReport(report)"
            >
              <AppIcon name="trash-2" :size="14" />
              {{ armedDeleteId === report.id ? 'Tap again to delete' : 'Delete report' }}
            </button>
          </div>
        </div>
      </li>
    </ul>

    <div v-if="hasReports" class="actions">
      <button class="btn-ghost" data-testid="diagnostics-share-all" @click="share(reports, 'diagnostics')">
        <AppIcon name="download" :size="14" />
        Share all reports
      </button>
      <button class="btn-ghost danger" data-testid="diagnostics-clear" @click="clearAll">
        <AppIcon name="trash-2" :size="14" />
        {{ clearArmed ? `Tap again to remove ${reports.length}` : 'Clear local reports' }}
      </button>
    </div>
    <p v-if="status" class="row-hint" role="status" data-testid="diagnostics-status">{{ status }}</p>
  </div>
</template>

<style scoped>
.row-hint {
  margin: 0;
  max-width: 60ch;
  font-size: var(--fs-200);
  line-height: var(--lh-200);
  color: var(--fg-secondary);
}
.diagnostics {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.reports {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
}
.report + .report {
  border-top: 1px solid var(--border-soft);
}
/* 44px: a phone touch target, and a comfortable desktop row. */
.report-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  min-height: 44px;
  padding: var(--sp-2) var(--sp-3);
  background: none;
  border: none;
  color: var(--fg);
  text-align: left;
  cursor: pointer;
}
.report-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.report-title {
  font-weight: var(--fw-medium);
  overflow-wrap: anywhere;
}
.report-meta {
  font-size: var(--fs-100);
  color: var(--fg-muted);
}
.report-body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: 0 var(--sp-3) var(--sp-3);
}
.report-preview {
  margin: 0;
  max-height: 240px;
  overflow: auto;
  padding: var(--sp-2);
  background: var(--surface-2);
  border-radius: var(--r-sm);
  font-family: var(--font-mono);
  font-size: var(--fs-100);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}
.actions .btn-ghost {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  min-height: 44px;
}
.danger {
  color: var(--error);
}
.notice {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  color: var(--warning);
}
</style>
