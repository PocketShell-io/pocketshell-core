<script setup lang="ts">
// CommandPalette: the session tree's quick actions — one summoned overlay that
// lists every verb the workspace speaks, filters as you type, and runs on
// Enter or click. VS Code's Ctrl+P is the shape being copied, and the parts
// copied are the parts that make that shape fast: a summons chord, a filter
// that matches the moment a character lands, arrow keys that never touch the
// mouse, and a first item that is always one Enter away.
//
// The palette is deliberately dumb about its commands (see commandPalette.ts):
// it renders and runs a list it is handed. WHAT the list holds is the host
// workspace's decision (HostWorkspaceView builds it from the same stores the
// panel and tabs read — one derivation, no second opinion).
//
// Dismissal is PopupMenu's rule, reused rather than reinvented: Escape in
// capture and stopped (so the composer's Escape and the terminal's do not also
// act), `mousedown` gated on where the press landed, and a scroll anywhere
// closes rather than chasing the anchor. The difference is that this overlay
// does not hang off an anchor — it is a fixed top-centre surface — so the
// scroll rule closes it because a palette left open over a moved page is a
// palette pointing at nothing.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { PaletteCommand } from '../commandPalette';

const props = defineProps<{
  /** The verbs on offer, in display order (the builder's order is the order). */
  commands: PaletteCommand[];
  /** Accessible name for the surface. */
  label?: string;
}>();

const emit = defineEmits<{ close: [] }>();

const query = ref('');
const inputEl = ref<HTMLInputElement | null>(null);
const listEl = ref<HTMLElement | null>(null);

/**
 * The rows that survive the query: a case-insensitive substring across the
 * label, the hint and the never-rendered keywords. Not fuzzy — the command
 * set is a few dozen verbs with short names, and a filter that sometimes
 * surprises beats one that always ranks. Empty query means everything, in
 * the builder's order.
 */
const filtered = computed<PaletteCommand[]>(() => {
  const needle = query.value.trim().toLowerCase();
  if (needle === '') return props.commands;
  return props.commands.filter(
    (command) =>
      command.label.toLowerCase().includes(needle) ||
      (command.hint ?? '').toLowerCase().includes(needle) ||
      (command.keywords ?? '').toLowerCase().includes(needle),
  );
});

/** The highlighted row. Resets to the top whenever the filter moves — an
 * arrow-key selection that survives a rewrite of the list underneath it is a
 * selection pointing at a command the user is no longer reading. */
const activeIndex = ref(0);
watch(filtered, () => {
  activeIndex.value = 0;
});

const activeCommand = computed<PaletteCommand | null>(
  () => filtered.value[activeIndex.value] ?? null,
);

function move(delta: 1 | -1): void {
  const count = filtered.value.length;
  if (count === 0) return;
  const next = (activeIndex.value + delta + count) % count;
  activeIndex.value = next;
  void nextTick(() => {
    listEl.value
      ?.querySelectorAll('.palette-item')
      [next]?.scrollIntoView({ block: 'nearest' });
  });
}

function run(command: PaletteCommand): void {
  emit('close');
  command.run();
}

function onEnter(): void {
  if (activeCommand.value) run(activeCommand.value);
}

function onPointerDown(e: MouseEvent): void {
  const target = e.target;
  if (!(target instanceof Node)) return;
  if (rootEl.value?.contains(target)) return;
  emit('close');
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    emit('close');
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    e.stopPropagation();
    move(1);
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    e.stopPropagation();
    move(-1);
  }
}

function onScroll(): void {
  emit('close');
}

const rootEl = ref<HTMLElement | null>(null);

onMounted(() => {
  void nextTick(() => inputEl.value?.focus());
  window.addEventListener('keydown', onKeydown, { capture: true });
  window.addEventListener('mousedown', onPointerDown, { capture: true });
  window.addEventListener('scroll', onScroll, { capture: true });
  window.addEventListener('resize', onScroll);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, { capture: true });
  window.removeEventListener('mousedown', onPointerDown, { capture: true });
  window.removeEventListener('scroll', onScroll, { capture: true });
  window.removeEventListener('resize', onScroll);
});
</script>

<template>
  <!-- To `body`, past every clipping ancestor — PopupMenu's reasoning, and
       PopupMenu's dismissal rules beside it. -->
  <Teleport to="body">
    <div ref="rootEl" class="command-palette" role="dialog" :aria-label="label ?? 'Quick actions'">
      <input
        ref="inputEl"
        v-model="query"
        class="palette-input"
        type="text"
        spellcheck="false"
        autocomplete="off"
        placeholder="Type a command…"
        :aria-label="label ?? 'Quick actions'"
        role="combobox"
        aria-controls="command-palette-list"
        :aria-activedescendant="
          activeCommand ? `command-palette-item-${activeCommand.id}` : undefined
        "
        @keydown.enter.prevent="onEnter"
      />
      <ul id="command-palette-list" ref="listEl" class="palette-list" role="listbox">
        <li v-if="!filtered.length" class="palette-empty muted">no matching commands</li>
        <li v-for="(command, i) in filtered" v-else :key="command.id" role="option">
          <button
            :id="`command-palette-item-${command.id}`"
            class="palette-item"
            :class="{ active: i === activeIndex }"
            :aria-selected="i === activeIndex"
            @mouseenter="activeIndex = i"
            @click="run(command)"
          >
            <span class="palette-label">{{ command.label }}</span>
            <span v-if="command.hint" class="palette-hint muted">{{ command.hint }}</span>
          </button>
        </li>
      </ul>
    </div>
  </Teleport>
</template>

<style scoped>
.command-palette {
  position: fixed;
  top: 12vh;
  left: 50%;
  transform: translateX(-50%);
  width: min(560px, 92vw);
  z-index: 70; /* Above PopupMenu (60): a palette opened over a menu wins. */
  display: flex;
  flex-direction: column;
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-popover);
  overflow: hidden;
}
.palette-input {
  flex: none;
  height: var(--control-h);
  margin: var(--sp-1);
  padding: 0 var(--sp-2);
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  color: var(--fg);
  font-family: var(--font-ui);
  font-size: var(--fs-300);
}
.palette-input::placeholder {
  color: var(--fg-muted);
}
.palette-list {
  list-style: none;
  margin: 0 0 var(--sp-1);
  padding: 0;
  max-height: 46vh;
  overflow-y: auto;
}
.palette-empty {
  padding: var(--sp-2) var(--sp-3);
  font-size: var(--fs-200);
  font-style: italic;
}
.palette-item {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  width: 100%;
  padding: 0 var(--sp-3);
  height: var(--row-h);
  background: transparent;
  border: none;
  color: var(--fg);
  text-align: left;
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
}
.palette-item.active {
  background: var(--state-selected);
}
.palette-label {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.palette-hint {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
  font-size: var(--fs-100);
}
</style>
