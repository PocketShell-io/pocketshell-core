<script setup lang="ts">
// EnvPanelView: the server-side env editor (FEATURES.md F16). Lists the env
// keys the helper sees for a folder (`pocketshell env list`), shows values on
// demand (`env get --key`), and writes edits (`env set`, values on the
// command's stdin — never argv).
//
// Two design constraints shape everything below:
//
//   - **Values are secrets until asked for.** The helper's write-only default
//     keeps values off the wire, and the panel honours that: names load
//     immediately, and a value travels — and lands on screen — only when its
//     row's eye is pressed. The click IS the ask: one press fetches and shows,
//     the same eye puts the mask back. Nothing here re-serves a value that was
//     never fetched.
//
//   - **A write that failed must not look like one that succeeded.** `envSet`
//     rejects with the host's own message; per-row save state turns that into
//     a sentence next to the row rather than a silent no-op.
//
// The layout is the Ports panel's table vocabulary (PortPanelView.vue): one
// line per key — name, file chip, value field, one action — shared column
// widths across rows, hairline `--border-soft` separators. The previous look
// stacked a key line and a full-width action button per row, which spent the
// pane's height on chrome and read as a column of buttons rather than an
// editor.
import { computed, onMounted, ref } from 'vue';
import AppIcon from '@ui/components/AppIcon.vue';
import { api } from '../ipc';
import type { ConnectionId, EnvVarRow } from '@pocketshell/core';
import { errorMessage } from '@pocketshell/core/shared/errors';

const props = defineProps<{
  connectionId: ConnectionId;
  /**
   * The folder whose env is being edited — pinned by the host (FilesView)
   * when the editor was asked for, so browsing the tree underneath the docked
   * panel does not move its target. Stated in the host's bar, not here.
   */
  dir: string;
}>();

/** One editable row on screen. */
interface EnvRow {
  key: string;
  /** The env file the key was read from; '' when a new key not yet written. */
  file: string;
  hasValue: boolean;
  /** The value has been fetched from the host (`env get`). */
  revealed: boolean;
  /** The fetched value is on screen — the eye button's state. */
  visible: boolean;
  /** The field's current text — the fetched value, or the user's edit. */
  value: string;
  /** True when `value` differs from what the host last confirmed. */
  dirty: boolean;
  saving: boolean;
}

const rows = ref<EnvRow[]>([]);
const loading = ref(true);
/** A load/list failure — the panel's own error channel. */
const error = ref<string | null>(null);
/** A failed write, named next to the row (or the new-key form) that failed. */
const saveError = ref<string | null>(null);

/** The new-key form. */
const newKey = ref('');
const newValue = ref('');
const adding = ref(false);

function toRow(r: EnvVarRow): EnvRow {
  return { key: r.key, file: r.file, hasValue: r.hasValue, revealed: false, visible: false, value: '', dirty: false, saving: false };
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const list = await api.agent.envList(props.connectionId, props.dir);
    rows.value = list.map(toRow);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}

/**
 * The row's one verb. First press fetches the value AND shows it — the click
 * is the ask to see it, so it lands on screen in one gesture; from then on
 * the eye is a plain show/hide toggle.
 */
async function onEye(row: EnvRow): Promise<void> {
  if (!row.revealed) {
    try {
      const values = await api.agent.envGet(props.connectionId, props.dir, [row.key]);
      row.value = values[row.key] ?? '';
      row.revealed = true;
      row.visible = true;
    } catch (e) {
      error.value = errorMessage(e);
    }
    return;
  }
  row.visible = !row.visible;
}

/** Fetch every row's value in one round trip (the helper's whole-env read). */
async function onRevealAll(): Promise<void> {
  try {
    const values = await api.agent.envGet(props.connectionId, props.dir);
    for (const row of rows.value) {
      if (row.key in values) {
        row.value = values[row.key]!;
        row.revealed = true;
        row.visible = true;
      }
    }
  } catch (e) {
    error.value = errorMessage(e);
  }
}

/**
 * "4 keys · 3 in .env · 1 in .envrc" — the list's one quiet summary line,
 * which is also where the panel-level Reveal all lives, instead of floating
 * between the rows and the add form.
 */
const keysSummary = computed(() => {
  const perFile = new Map<string, number>();
  for (const row of rows.value) {
    const f = row.file || 'new';
    perFile.set(f, (perFile.get(f) ?? 0) + 1);
  }
  const parts = [...perFile.entries()].map(([f, n]) => `${n} in ${f}`);
  return `${rows.value.length} keys · ${parts.join(' · ')}`;
});

/**
 * A cheap key check before the host sees it. The helper has opinions about
 * names too, but `=` or whitespace in a key mangles the dotenv file silently
 * worse than it fails loudly — refuse the obvious nonsense locally.
 */
function keyIsSane(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

/** Write one row's value back to the file it came from. */
async function onSave(row: EnvRow): Promise<void> {
  if (!row.dirty || row.saving) return;
  row.saving = true;
  saveError.value = null;
  try {
    await api.agent.envSet(props.connectionId, props.dir, { [row.key]: row.value }, row.file || undefined);
    row.hasValue = true;
    row.dirty = false;
    row.file = row.file || '.env';
  } catch (e) {
    saveError.value = `${row.key}: ${errorMessage(e)}`;
  } finally {
    row.saving = false;
  }
}

async function onAdd(): Promise<void> {
  const key = newKey.value.trim();
  if (!keyIsSane(key)) return;
  adding.value = true;
  saveError.value = null;
  try {
    await api.agent.envSet(props.connectionId, props.dir, { [key]: newValue.value });
    // Re-list rather than hand-appending: the helper decides where the key
    // landed, and the authoritative row is one cheap call away.
    newKey.value = '';
    newValue.value = '';
    await load();
  } catch (e) {
    saveError.value = `${key}: ${errorMessage(e)}`;
  } finally {
    adding.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="env-panel">
    <p v-if="loading" class="muted">listing env keys…</p>
    <p v-else-if="error" class="error">{{ error }}</p>

    <template v-else>
      <p v-if="!rows.length" class="muted empty-line">
        No env keys in this folder yet. Add one below — it lands in <code>.env</code>.
      </p>

      <template v-else>
        <div class="list-meta">
          <span class="muted">{{ keysSummary }}</span>
          <button type="button" class="btn-ghost reveal-all" @click="onRevealAll">
            Reveal all
          </button>
        </div>

        <!-- One line per key, the Ports table's construction: shared column
             widths (a real table, so the value column starts at the same x in
             every row), ghost fields that surface on hover/focus only, and a
             single right-aligned action cell. The action cell holds the eye
             and the row's Save in FIXED slots — `v-show` + the ghosted class,
             never `v-if` — so the column cannot resize under the caret the
             moment a row goes dirty. -->
        <table class="env-table">
          <tbody>
            <tr v-for="row in rows" :key="row.key">
              <td class="c-key" :title="row.key">{{ row.key }}</td>
              <td class="c-file">
                <span class="file-badge" :class="{ envrc: row.file === '.envrc' }">{{
                  row.file || 'new'
                }}</span>
              </td>
              <td class="c-value">
                <!-- Unfetched: disabled dots — there is a value and the panel
                     is not showing it; the eye fetches it. Unset: an empty
                     enabled field (absence is not a secret) — typing goes
                     straight to the save flow. Fetched: masked until the eye
                     opens it, text while edited. -->
                <input
                  v-model="row.value"
                  class="value-input"
                  :type="row.hasValue && !(row.visible || row.dirty) ? 'password' : 'text'"
                  :disabled="row.hasValue && !row.revealed"
                  :placeholder="row.hasValue && !row.revealed ? '••••••••••' : row.hasValue ? '' : 'not set'"
                  :aria-label="`Value of ${row.key}`"
                  spellcheck="false"
                  @input="row.dirty = true"
                  @keyup.enter="onSave(row)"
                />
              </td>
              <td class="c-actions">
                <div class="actions">
                  <!-- The eye: fetch-and-show the first time, show/hide after.
                       Retired (slot kept) while the field is edited — there is
                       no editing a secret you cannot see, and once edited there
                       is nothing left for the eye to offer. -->
                  <button
                    v-if="row.hasValue"
                    v-show="!row.dirty && !row.saving"
                    type="button"
                    class="icon-btn sm eye-btn"
                    :aria-pressed="row.visible"
                    :title="row.revealed ? (row.visible ? 'Hide value' : 'Show value') : 'Fetch and show the value'"
                    :aria-label="row.revealed ? (row.visible ? `Hide the value of ${row.key}` : `Show the value of ${row.key}`) : `Fetch and show the value of ${row.key}`"
                    @click="onEye(row)"
                  >
                    <AppIcon :name="row.visible ? 'eye-off' : 'eye'" :size="14" />
                  </button>
                  <!-- Save only ever exists for a change worth writing; clean
                       it keeps its slot, invisible, so the row's width holds. -->
                  <button
                    type="button"
                    class="row-save"
                    :class="{ ghosted: !row.dirty && !row.saving }"
                    :disabled="row.saving"
                    :title="row.dirty ? 'Write to the host' : 'Unchanged'"
                    @click="onSave(row)"
                  >
                    {{ row.saving ? 'Saving…' : 'Save' }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </template>

      <p v-if="saveError" class="error">{{ saveError }}</p>

      <form class="add-row" @submit.prevent="onAdd">
        <AppIcon name="plus" :size="14" />
        <input
          v-model="newKey"
          class="key-input"
          placeholder="NEW_KEY"
          aria-label="New key name"
          spellcheck="false"
          autocomplete="off"
        />
        <input
          v-model="newValue"
          class="value-input"
          placeholder="value"
          aria-label="New key value"
          spellcheck="false"
          autocomplete="off"
        />
        <button class="row-save add" type="submit" :disabled="!keyIsSane(newKey.trim()) || adding">
          {{ adding ? 'Adding…' : 'Add key' }}
        </button>
      </form>
      <p v-if="newKey.trim() && !keyIsSane(newKey.trim())" class="muted hint">
        Keys are UPPER_SNAKE — letters, digits and underscores, starting with a letter.
      </p>
    </template>
  </div>
</template>

<style scoped>
.env-panel {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  min-width: 0;
  /* Fills the docked editor area under its bar and scrolls there: a long key
     list belongs to the panel, not to the pane around it. */
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.muted {
  color: var(--fg-muted);
}
.error {
  margin: 0;
  color: var(--error);
}
.empty-line {
  margin: 0;
}
/* The list's quiet head: what is in it, and the one bulk action. */
.list-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}
.list-meta .muted {
  font-size: var(--fs-100);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* `btn-ghost` at the table's density: the primitive's register, smaller. */
.reveal-all {
  height: var(--control-h-sm);
  font-size: var(--fs-200);
  flex: none;
}
/* The rows. A real table so the value column starts at one x for every key;
   hairlines over full rules, the last one dropped because the add form below
   carries its own top border. */
.env-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-200);
}
.env-table td {
  padding: var(--sp-1) var(--sp-2);
  border-bottom: 1px solid var(--border-soft);
  vertical-align: middle;
}
.env-table tbody tr:last-child td {
  border-bottom: none;
}
.env-table tbody tr:hover td {
  background: var(--state-hover);
}
/* The key is the row's identity: mono, capped, ellipsised, full name on the
   cell's title. Capping is what keeps one 40-character key from squeezing the
   value column for every row. */
.c-key {
  font-family: var(--font-mono);
  font-weight: var(--fw-medium);
  max-width: 26ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.c-file {
  width: 1%;
  white-space: nowrap;
}
/* Badge metrics per the design system's one-badge rule: inline-flex,
   `padding: 0 var(--sp-1)`, `line-height: var(--lh-100)`. */
.file-badge {
  display: inline-flex;
  font-size: var(--fs-100);
  line-height: var(--lh-100);
  padding: 0 var(--sp-1);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--fg-muted);
}
.file-badge.envrc {
  color: var(--accent);
}
/* The value column is the flexible one; the input is the Ports table's ghost
   field — invisible at rest, surfaced on hover/focus with a WCAG-legal
   boundary once it looks like a control. */
.c-value {
  width: 100%;
  min-width: 0;
}
.value-input,
.key-input {
  width: 100%;
  min-width: 0;
  height: var(--control-h-sm);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  padding: 0 var(--sp-1);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--fs-200);
}
.value-input::placeholder,
.key-input::placeholder {
  color: var(--fg-muted);
}
.value-input:hover:not(:disabled),
.value-input:focus,
.key-input:hover,
.key-input:focus {
  background: var(--surface-2);
  /* WCAG 1.4.11: once it looks like a control it needs a >=3:1 boundary. */
  border-color: var(--border-strong);
}
.value-input:disabled {
  opacity: var(--disabled-opacity);
}
/* One action cell, fixed-width slots: the eye keeps its box while edited
   (`v-show`), Save keeps its box while clean (`.ghosted`), so neither state
   change can resize the column under the caret. The flex group is a DIV
   inside the cell — a td must stay a table-cell for the columns to size. */
.c-actions {
  width: 1%;
  white-space: nowrap;
}
.actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-1);
}
.eye-btn {
  flex: none;
}
.row-save {
  flex: none;
  /* Fixed width so 'Save' and 'Saving…' occupy the same box — the action
     column cannot breathe when a write starts. */
  width: 64px;
  height: var(--control-h-sm);
  padding: 0 var(--sp-1);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface);
  color: var(--fg-secondary);
  font-family: var(--font-ui);
  font-size: var(--fs-200);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.row-save:hover:not(:disabled):not(.ghosted) {
  color: var(--fg);
  background: var(--state-hover);
}
.row-save:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
.row-save.ghosted {
  visibility: hidden;
}
.save-error {
  margin: 0;
}
/* The new-key form: one line like the rows above it, the same ghost fields,
   the same action width. */
.add-row {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  border-top: 1px solid var(--border-soft);
  padding-top: var(--sp-3);
}
.add-row .app-icon {
  color: var(--fg-muted);
  flex: none;
}
.add-row .key-input {
  flex: 0 1 30%;
}
.add-row .value-input {
  flex: 1 1 0;
}
.row-save.add {
  width: auto;
  min-width: 64px;
}
.hint {
  margin: 0;
  font-size: var(--fs-200);
}
</style>
