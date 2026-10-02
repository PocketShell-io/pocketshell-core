<script setup lang="ts">
// Settings → Session panel: what the session tree shows — its project roots
// (the host-scoped section) and the folder-row sort. Extracted from
// SettingsView with the rest of the group components; the roots logic itself
// lives in useProjectRoots.
import { onMounted } from 'vue';
import { useConnectionStore } from '../../stores/connection';
import { useSettingsStore } from '../../stores/settings';
import { useWorkspaceRootsStore } from '../../stores/workspaceRoots';
import { FOLDER_SORT_KEYS, FOLDER_SORT_LABELS, type FolderSortKey } from '../../folderSort';
import { useProjectRoots } from '../../useProjectRoots';
import AppIcon from '@ui/components/AppIcon.vue';

const connection = useConnectionStore();
const settings = useSettingsStore();
const workspaceRoots = useWorkspaceRootsStore();

const {
  selectedRootHost,
  rootHost,
  rootsOnHost,
  rootsEditable,
  rootRows,
  rootDraft,
  rootSuggestions,
  rootsFull,
  rootMessage,
  selectDefaultRootHost,
  onAddRoot,
  onRemoveRoot,
  onMoveRoot,
} = useProjectRoots();

onMounted(async () => {
  // The picker loads hosts on its own mount, but the workspace does not
  // re-read the config, and this panel opens over both. `listConfigHosts()` is
  // the single source for the root-host choices, so ask for it when the list
  // is empty rather than rendering an empty select. (The view's own Startup
  // group runs the same guarded load for its select; whichever mount runs
  // first fills the store, the other's guard sees it and skips.)
  if (!connection.hosts.length) await connection.loadHosts();
  selectDefaultRootHost();
});

/** The panel's folder-row sort — the select writes the key straight in. */
const sortOptions = FOLDER_SORT_KEYS.map((key) => ({ key, label: FOLDER_SORT_LABELS[key] }));

function onSortChange(event: Event): void {
  // The action, not a bare write: picking a sort clears the dragged
  // arrangements (one per host) — see setSessionTreeSort.
  settings.setSessionTreeSort((event.target as HTMLSelectElement).value as FolderSortKey);
}
</script>

<template>
  <section class="group" data-testid="settings-group-sessions">
    <h3 class="group-title">Session panel</h3>

    <div class="row stacked">
      <div class="row-text">
        <span class="row-label">Project roots</span>
        <p class="row-hint">
          The top level of the session tree: <code>~/git</code>, <code>~/tmp</code>, or
          any folder you keep projects in. Every session below a root is grouped under
          it, by the folder it runs in. Sessions under no root collect in
          <em>other</em>, at the bottom.
          <template v-if="rootsOnHost">
            Roots are registered on the host itself; removing one only takes it off
            this list — its folder, files and sessions stay.
          </template>
          <template v-else>Roots are stored separately for each SSH host;</template>
          <template v-if="rootHost">
            <!-- Host mode's sentence ends before this one; the local one runs on. -->
            {{ rootsOnHost ? 'This' : 'this' }} list belongs to <code>{{ rootHost }}</code>.
          </template>
          <template v-else>choose an instance below to edit its list.</template>
        </p>
      </div>

      <div v-if="!rootHost && connection.hosts.length" class="root-host-picker">
        <label for="root-host">Instance</label>
        <select id="root-host" v-model="selectedRootHost" class="control">
          <option disabled value="">Choose an SSH host</option>
          <option v-for="host in connection.hosts" :key="host.name" :value="host.name">
            {{ host.name }}
          </option>
        </select>
      </div>

      <template v-if="rootsEditable">
        <ul v-if="rootRows.length" class="roots" data-testid="workspace-roots">
          <li
            v-for="(root, index) in rootRows"
            :key="root.path"
            class="root"
            :data-root-path="root.path"
          >
            <span class="root-path" :title="root.path">{{ root.label }}</span>
            <template v-if="rootsOnHost">
              <button
                class="icon-btn"
                :title="`Move ${root.label} up`"
                :disabled="index === 0 || workspaceRoots.rootsBusy"
                @click="onMoveRoot(root.path, -1)"
              >
                <AppIcon name="chevron-up" :size="14" />
              </button>
              <button
                class="icon-btn"
                :title="`Move ${root.label} down`"
                :disabled="index === rootRows.length - 1 || workspaceRoots.rootsBusy"
                @click="onMoveRoot(root.path, 1)"
              >
                <AppIcon name="chevron-down" :size="14" />
              </button>
            </template>
            <button
              class="icon-btn"
              :title="`Remove ${root.label}`"
              :disabled="workspaceRoots.rootsBusy"
              @click="onRemoveRoot(root.path)"
            >
              <AppIcon name="trash-2" :size="14" />
            </button>
          </li>
        </ul>
        <p
          v-else-if="rootsOnHost && workspaceRoots.state.status === 'loading'"
          class="row-hint"
        >
          Reading this host's workspace roots…
        </p>

        <div class="add-root">
          <input
            v-model="rootDraft"
            class="control grow"
            type="text"
            list="root-suggestions"
            placeholder="~/git"
            :disabled="rootsFull"
            :aria-label="`Add a project root for ${rootHost}`"
            @keydown.enter.prevent="onAddRoot"
          />
          <!-- Where the user's roots actually are, read off the running
               sessions. Typing is still allowed: a root you have not started a
               session in yet cannot be suggested, and registering one ahead of
               time is a legitimate thing to want. -->
          <datalist id="root-suggestions">
            <option v-for="path in rootSuggestions" :key="path" :value="path" />
          </datalist>
          <button
            class="add-btn"
            :disabled="rootsFull || workspaceRoots.rootsBusy"
            @click="onAddRoot"
          >
            <AppIcon name="plus" :size="14" />
            Add
          </button>
        </div>

        <p
          v-if="rootMessage"
          class="notice"
          :class="{ info: rootMessage.tone === 'info' }"
          :role="rootMessage.tone === 'error' ? 'alert' : undefined"
        >
          <AppIcon :name="rootMessage.tone === 'error' ? 'alert-triangle' : 'check'" :size="14" />
          <span>{{ rootMessage.text }}</span>
        </p>
      </template>
      <p v-else class="root-notice">
        <AppIcon name="alert-triangle" :size="14" />
        <span v-if="rootsOnHost && rootHost">
          Workspace roots are stored on the host. Connect to {{ rootHost }} to manage them.
        </span>
        <span v-else-if="connection.hosts.length">
          Connect to an instance, or choose an SSH host above, to configure its roots.
        </span>
        <span v-else>Connect to an instance to configure its roots.</span>
      </p>
    </div>

    <!-- The folder-row sort, in the seat every other preference holds. The
         panel's own sort menu (the summoned search row) writes the same
         setting through the same action. -->
    <div class="row">
      <div class="row-text">
        <label class="row-label" for="session-tree-sort">Sort folders</label>
        <p class="row-hint">
          The order of the folder rows in the session tree. <em>Host order</em> is the
          order the host's listing reports, and it is the mode your dragged arrangement
          belongs to: picking a sort clears dragged places, and dragging rows switches
          you back under <em>Host order</em>.
        </p>
      </div>
      <select
        id="session-tree-sort"
        class="control"
        :value="settings.sessionTreeSort"
        @change="onSortChange"
      >
        <option v-for="opt in sortOptions" :key="opt.key" :value="opt.key">
          {{ opt.label }}
        </option>
      </select>
    </div>
  </section>
</template>

<style scoped src="./settingsGroup.css"></style>

<style scoped>
/* The group-specific shapes: a list plus an editor cannot sit in the
   label-left/control-right shape the other rows use — it needs the full
   width — so that row stacks instead. */
.row.stacked {
  flex-direction: column;
  align-items: stretch;
  gap: var(--sp-2);
}
.root-host-picker {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.root-host-picker label {
  flex: none;
  font-size: var(--fs-200);
  color: var(--fg-secondary);
}
.root-host-picker .control {
  flex: 1;
  max-width: none;
}
.roots {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  overflow: hidden;
}
.root {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  height: var(--row-h);
  padding: 0 var(--sp-1) 0 var(--sp-3);
  border-bottom: 1px solid var(--border-soft);
}
.root:last-child {
  border-bottom: none;
}
/* The stored spelling, verbatim and in mono: this is the string the panel
   matches against, so showing it in anything else would be a paraphrase. */
.root-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--fs-200);
}
.add-root {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.control.grow {
  flex: 1;
  max-width: none;
  font-family: var(--font-mono);
}
/* Bordered, matching the session panel's `New session` button: it is the one
   primary action in this section and a ghost control beside a text field
   reads as a hint rather than a button. */
.add-btn {
  flex: none;
  height: var(--control-h);
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 var(--sp-3);
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  color: var(--fg-secondary);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-medium);
}
.add-btn:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent-dim);
  background: var(--accent-soft);
}
.add-btn:disabled,
.control:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
/* The roots editor's message: the host's refusal or unreadable answer in the
   error register, a completed add/remove/restore in the quiet one. */
.notice {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  color: var(--error);
  background: var(--error-soft);
  font-size: var(--fs-200);
  line-height: var(--lh-200);
  overflow-wrap: anywhere;
}
.notice.info {
  color: var(--fg-secondary);
  background: var(--surface-2);
}
.root-notice {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  color: var(--warning);
  background: var(--warning-soft);
  font-size: var(--fs-200);
  line-height: var(--lh-200);
}
code {
  font-family: var(--font-mono);
  font-size: 0.9em;
}
</style>
