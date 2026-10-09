<script setup lang="ts">
// SessionTreeRowsView: the session panel's rows — the root sections with their
// folder rows and the panel's empty state — as a PRESENTATIONAL component.
// Everything it draws arrives as props and everything it does leaves as an
// event; it reads no store. `SessionTreeRows.vue` is the thin wrapper that
// binds the stores (the tree derivation, the sort setting, the drag state)
// for the desktop panel, and any other shell can feed it its own tree.
//
// The design reasoning for the rows (why the panel is root -> folder, the
// indent budget, why roots never collapse) stays with the markup below and in
// SessionTree.vue's header, where the revisions were written down.
//
// One addition over the desktop rows: `showSessions`. A phone has no room for
// a folder workspace's tab bar beside the panel, so the narrow layout draws the
// folder's sessions as leaf rows under it (root -> folder -> session, #2530)
// and a leaf tap opens that folder with that session's tab selected — the same
// `select(folder, session)` the panel's own create path already emits.
import { computed } from 'vue';
import AppIcon from '@ui/components/AppIcon.vue';
import { rootHostPath } from '../sessionRoots';
import { rootHeaderParts, type SessionDirectory, type SessionRootFolder } from '../sessionTree';
import { agentBadge, agentBadges, dirTooltip, fmtRelative, rootTooltip } from '../sessionTreeText';
import type { AgentBadgeKind } from '../sessionTreeText';
import { agentMark, type AgentMark } from '@pocketshell/core/shared/agentBadge';
import MaintenanceSection from './MaintenanceSection.vue';

/** Where a dragged folder row would land: before row `gap` of `root`. */
export interface FolderDropTarget {
  root: string;
  gap: number;
}

const props = withDefaults(
  defineProps<{
    /** The root sections, in panel order. */
    roots: readonly SessionRootFolder[];
    /** The host's `$HOME`, which a root's `+` resolves its folder against. */
    home: string | null;
    /**
     * Key of the folder whose workspace is open, so its row can be marked.
     * A `SessionDirectory.key` — selection is a FOLDER fact.
     */
    activeFolder?: string | null;
    /** The open folder's selected session tab, marked when leaves are drawn. */
    activeSession?: string | null;
    /** The panel's minute clock (`useSessionTreePoll`), for the relative ages. */
    now: number;
    /**
     * Where the empty state's "New session…" starts the picker: the panel's
     * first root, or null for the dialog's own `$HOME` behaviour.
     */
    defaultStartIn: string | null;
    /** A non-host sort is in force; tints the root rows' sort door. */
    sortEngaged?: boolean;
    /** A quick search is up: rows are the filter's output, drags refused. */
    filtering?: boolean;
    filterQuery?: string;
    /** The session list is still loading; suppresses the empty state. */
    loading?: boolean;
    /** Draw each folder's sessions as leaf rows (the narrow layout). */
    showSessions?: boolean;
    /** Folder drag state, owned by the wrapper's `useFolderDrag`. */
    dragging?: string | null;
    dropTarget?: FolderDropTarget | null;
    /** Root drag state, same owner: the header being dragged, and where it would land. */
    rootDragging?: string | null;
    /** The gap index a dragged root header would land in, over the panel's roots. */
    rootDropTarget?: number | null;
    /**
     * Every drawn folder's stored tab ranking, keyed by folder key — what the
     * folder's workspace tab bar applies (`applyTabOrder` over the
     * `ps.tabOrder` arrangement), so a row's mark run reads as its tab bar
     * folded flat with the user's dragged order included. A folder with no
     * entry wears the derived order, exactly as the un-arranged bar does.
     * Required, not defaulted: a wrapper that cannot produce the map has no
     * business promising the marks, and a silent `{}` would render an
     * arranged folder in an order its own bar no longer wears.
     */
    tabOrders: Record<string, readonly string[]>;
    /**
     * Whether the pinned Maintenance section shows at all. It is the door
     * to the tool workspaces, so it appears once there is something to open
     * — the host has tools open, or the workspace itself is on screen right
     * now — and stays hidden before that, however many roots the host has.
     * The wrapper owns the rule (maintenance.ts's opened list); this
     * component only obeys it.
     */
    showMaintenance?: boolean;
    /**
     * How many maintenance tools the host has open. Drives the section's
     * visibility (the wrapper's rule: open tools force it on) and its
     * count; the tools themselves are the workspace's tabs and are listed
     * nowhere in this panel.
     */
    maintenanceCount?: number;
  }>(),
  {
    activeFolder: null,
    activeSession: null,
    sortEngaged: false,
    filtering: false,
    filterQuery: '',
    loading: false,
    showSessions: false,
    dragging: null,
    dropTarget: null,
    rootDragging: null,
    rootDropTarget: null,
    showMaintenance: false,
    maintenanceCount: 0,
  },
);

/**
 * The rows announce; the parent disposes. A click opens a folder's workspace
 * (a leaf names the session tab to select), a right-click opens the row menu
 * whose state the parent owns, the two `+`s hand the folder they resolved to
 * the ONE creation flow, and the drag gestures are reported for the wrapper's
 * drag state to interpret.
 */
const emit = defineEmits<{
  select: [folder: SessionDirectory, session?: string];
  menu: [dir: SessionDirectory, e: MouseEvent];
  create: [startIn: string | null];
  sort: [trigger: HTMLButtonElement];
  dragStart: [dir: SessionDirectory, e: DragEvent];
  dragOver: [root: SessionRootFolder, index: number, e: DragEvent];
  drop: [];
  dragEnd: [];
  rootDragStart: [root: SessionRootFolder, e: DragEvent];
  rootDragOver: [index: number, e: DragEvent];
  rootDrop: [];
}>();

/**
 * The roots, each paired with its header text already split for the muted `~/`.
 *
 * Paired here rather than called three times inside the `v-for` — once for the
 * `v-if`, once for the prefix, once for the rest. The cost is nothing (a handful
 * of roots, a four-line pure function), but the template is where this panel's
 * decisions are written down and a line that says `rootHeaderParts(root).prefix`
 * twice in a row reads as an accident rather than as a rule.
 */
const rootRows = computed(() =>
  props.roots.map((root) => ({ root, header: rootHeaderParts(root) })),
);

/**
 * The absolute host directory a root's `+` would start the picker in, or null
 * when the root names no directory we can resolve.
 *
 * Null has two causes and they are not the same. `other` is a BUCKET — the
 * sessions that matched no root — so there is no place to create anything in;
 * the template does not render a `+` on it at all. The second is a `~`-keyed
 * root on a host whose `$HOME` never resolved and could not be inferred from
 * the paths either, and there the `+` renders DISABLED rather than vanishing:
 * the control is real, the host is temporarily unable to answer, and a button
 * that disappears on a failed fetch reads as a feature that is not there.
 */
function rootAddPath(root: SessionRootFolder): string | null {
  return rootHostPath(root.key, props.home);
}

/**
 * The root rows' door to the panel's sort menu. The menu itself lives in the
 * parent with the other two doors (the search row's trigger, Settings'
 * select) — one stored value, `settings.sessionTreeSort`, so the handoff is
 * the clicked BUTTON, and the menu anchors at the row that asked for it.
 */
function onSortClick(e: MouseEvent): void {
  const el = e.currentTarget;
  if (el instanceof HTMLButtonElement) emit('sort', el);
}

/**
 * What one folder row's badge slot shows for a kind. The four engines wear
 * their own brand marks (`agentMark`) at the panel's muted grey — VS Code's
 * treatment of tree adornments: present, never competing with the label they
 * qualify. The mark's tooltip names the SESSION the badge stands for, not the
 * engine — the silhouette already says codex, and in a stacked run of
 * look-alike marks the hover is what tells the copies apart. `probing…` and
 * `exited` are detector STATES rather than products, so they keep the word
 * form, dimmed — a logo on those would claim a product that is not running.
 */
interface AgentBadgeView {
  kind: AgentBadgeKind;
  session: string;
  mark: AgentMark | null;
  text: string | null;
}

function badgeViews(dir: SessionDirectory): AgentBadgeView[] {
  // The folder's tab ranking rides in as the `tabOrders` prop, so the run
  // follows the arrangement the user dragged the workspace's tabs into — the
  // wrapper reads the live store and hands the result over as data, the same
  // as every other prop here.
  return agentBadges(dir, props.tabOrders[dir.key]).map(({ kind, session }) => {
    const mark = agentMark(kind);
    return { kind, session, mark, text: mark === null ? agentBadge(kind) : null };
  });
}

/**
 * The session a folder row stands for by itself in the narrow layout: a
 * folder holding exactly one session NAMED like the folder (`api` in `api`).
 * A leaf there would repeat the folder's own label on the next row, so the
 * folder row IS the leaf — it opens that session and wears its selection.
 */
function soleSession(dir: SessionDirectory): string | null {
  if (!props.showSessions || dir.untracked || dir.rows.length !== 1) return null;
  const name = dir.rows[0]!.session.name;
  return name === dir.label ? name : null;
}

/** An untracked folder is one session with no folder; its row IS the leaf. */
function drawsLeaves(dir: SessionDirectory): boolean {
  return props.showSessions && !dir.untracked && soleSession(dir) === null;
}

function onFolderClick(dir: SessionDirectory): void {
  const sole = soleSession(dir);
  if (sole === null) emit('select', dir);
  else emit('select', dir, sole);
}
</script>

<template>
  <!-- `dragend` sits on the LIST, not on the row: it fires on the source
       element and bubbles, so one listener here covers every row and — more
       to the point — covers the cancelled drag, where the pointer was
       released over something that is not a row at all. Without it a drag
       abandoned over the header would leave the dragged row faded forever.
       Same placement, same reason, as the tab strip's `<nav @dragend>`. -->
  <div class="folder-list" :class="{ leaves: props.showSessions }" @dragend="emit('dragEnd')">
    <!-- The drop target is the WHOLE SECTION, not the header: the reorder
         gesture aims at the GROUP — "put git under tmp" — and a thin 28px
         header row among dozens of folder rows is a target a hand can only
         hit by accident. The first cut bound `dragover`/`drop` on the header
         alone and every release over the folder rows refused, ten tries to
         one landing; the events live on the section now, so hovering any row
         of the group proposes a placement for it. `dragover` bubbles out of
         the header and the rows alike, and the folder drag's own handlers
         refuse first (their strip is empty while a root is in flight), so the
         two gestures still cannot cross.

         The landing rule draws on the SECTION's edges, which is also a
         measured fix: on the header it drew "after the name" — a rule under
         `~/tmp` but ABOVE its folders, inside the group it claimed to end.
         Top edge of the section is the boundary above the group; bottom edge
         is below its last row, where "after the group" actually is. -->
    <section
      v-for="({ root, header }, ri) in rootRows"
      :key="root.key"
      class="folder"
      :class="{
        'drop-above': props.rootDropTarget === ri,
        'drop-below': props.rootDropTarget === props.roots.length && ri === props.roots.length - 1,
      }"
      @dragover="emit('rootDragOver', ri, $event)"
      @drop.prevent="emit('rootDrop')"
    >
      <!-- A plain element, not a <button>, and no disclosure mark: now that
           sessions live in workspace tabs the panel is root -> folder, and a
           root row is a grouping HEADER over its folders rather than a node
           with something hidden under it. A chevron here would advertise an
           interaction that does not exist, so the row still takes no CLICK —
           the tooltip is the only thing it offers on hover, and it carries
           real information (the root's path and its size).

           The one gesture it starts is the reorder drag the folder rows take:
           the header is draggable, and pulling it up or down moves the ROOT
           among its siblings (`../rootOrder.ts` holds why the headers, unlike
           the rows, may be rearranged). Same native DnD family, so the same
           three rules carry over — the drag does not fight any click because
           there is no click to fight, the dragged header fades but stays in
           place, and the landing place is drawn as a 2px accent rule on the
           section's edge, with a refused drop drawing nothing at all.

           NOT while a filter is up (a drag writes the whole panel's root keys
           in draw order, and under a filter that list is the survivors'), and
           not on `other`, which is a bucket pinned last — there is no gap it
           can meaningfully land in (`canDropRootAt` refuses every one). The
           bucket's section still ACCEPTS drops above it: "just above other"
           is a real place, and the section handler refuses only the gap
           below.

           ROOT ROWS ARE DELIBERATELY ALWAYS OPEN. If collapsing ever comes
           back, it must NOT be driven off the root list: `roots` recomputes
           every time the sessions store refreshes on its timer, so anything
           that reopens roots on recompute would reopen one the instant the
           user closed it. The state removed here dodged that by watching the
           ACTIVE FOLDER instead, so a deliberate collapse survived until the
           user navigated somewhere else. That is the trap, written down. -->
      <div
        class="folder-header"
        :class="{ dragging: props.rootDragging === root.key }"
        :title="rootTooltip(root)"
        :draggable="root.other || props.filtering ? 'false' : 'true'"
        @dragstart="emit('rootDragStart', root, $event)"
      >
        <!-- The dot is how a root reports attachment in ONE mark: a reader
             scanning the headers sees which roots have something live in them
             without reading the folder rows underneath, and on a registered
             root with nothing running it is the difference between "quiet"
             and "not loaded". -->
        <span class="dot" :class="{ active: root.active }" />
        <!-- The header names the real directory — `~/git`, not `git` — with
             the `~/` in its own span so it can recede. It is the part every
             root repeats, so it is the part worth toning down; see
             `rootHeaderParts` for the three keys that carry no `~/` at all
             and must not be given one. -->
        <span class="folder-label" :class="{ bucket: root.other }">
          <!-- No whitespace between the two: a newline here is a text node,
               and the header would read `~/ git`. -->
          <span v-if="header.prefix" class="path-prefix">{{ header.prefix }}</span>{{ header.text }}
        </span>
        <!-- Beside the label, not pinned to the right edge. A count thrown to
             the far end of the row reads as its own column — "10" floating
             level with `git` but nowhere near it — and the user asked for it
             back: "move 10 closer to git". The `+` takes over the
             `margin-left: auto` and keeps the right end of the row. -->
        <span class="folder-count muted">{{ root.sessionCount }}</span>
        <!-- The root rows' door to the panel's sort menu — the same menu the
             summoned search row and Settings' "Session panel" section open,
             one stored value, not a per-root one: the sort is a way of
             READING the list (the settings store's field comment holds that
             argument), so every root carries the same door to it. Beside the
             count, because this is where the reorder is VISIBLE — the rows it
             moves are the ones under this header.

             The mark is `arrow-up-down`, NOT a chevron: the comment on the
             header element above forbids advertising a disclosure this row
             does not have, and a chevron is exactly that advertisement on a
             tree header. `@click.stop` for the same reason the `+` carries
             it — the row is deliberately inert, and that decision can be
             revisited.

             ON `other` TOO, where the `+` is not: the bucket's folder rows
             are re-sorted like any root's, so a sort door that skipped it
             would promise less than the sort does. -->
        <button
          class="icon-btn sm root-sort"
          :class="{ engaged: props.sortEngaged }"
          title="Sort folders"
          aria-label="Sort folders"
          @click.stop="onSortClick($event)"
        >
          <AppIcon name="arrow-up-down" :size="12" />
        </button>
        <!-- Per-root `+`: create a session UNDER THIS ROOT. It opens the same
             folder picker the header's `+` does, one level in — the root is
             known, the folder is not, and guessing a directory from a root is
             how you get a session in the wrong place.

             NOT on `other`. That row is a bucket for paths that matched no
             root, not a directory, so there is nowhere for the picker to
             start; the header's `+` already covers "somewhere else".

             `@click.stop` even though the row takes no click today. The row
             is deliberately inert (see the comment above), but "deliberately"
             is a decision that can be revisited, and a `+` that also selects
             the row it sits on is a bug that would arrive silently the moment
             it were. One modifier now, or a mystery later.

             `:title` carries the destination, because the mark alone cannot
             say WHICH root it belongs to once the eye is on the right of the
             row rather than the left. -->
        <button
          v-if="!root.other"
          class="icon-btn sm root-add"
          :disabled="rootAddPath(root) === null"
          :title="
            rootAddPath(root) === null
              ? `cannot resolve $HOME on this host, so ${root.label} has no directory to start in`
              : `New session in ${root.key}`
          "
          @click.stop="emit('create', rootAddPath(root))"
        >
          <AppIcon name="plus" :size="12" />
        </button>
      </div>

      <ul class="dir-list">
        <!-- Only a REGISTERED root can be empty; a derived one exists because
             a session is in it. Saying so beats a header with nothing under
             it, which reads as a failed load — and there is no collapsed
             state left to blame it on. -->
        <li v-if="!root.directories.length" class="empty-root muted">no sessions here yet</li>

        <!-- ONE ROW PER FOLDER. Not a header over a list any more: the row
             IS the destination, and what used to be its children are the
             tabs in the workspace it opens. Rendered as a <button> because
             it is a control that navigates, and marked `current` by the
             folder key so a workspace holding four session tabs still
             highlights exactly one row. -->
        <!-- The drop indicator lives on the `<li>`, not on the button: the
             button already spends its left border on the selection rail, and
             a landing rule drawn on the same element would have to fight it
             for the one border the row has. -->
        <li
          v-for="(dir, i) in root.directories"
          :key="dir.key"
          :class="{
            'drop-above': props.dropTarget?.root === root.key && props.dropTarget.gap === i,
            'drop-below':
              props.dropTarget?.root === root.key &&
              props.dropTarget.gap === root.directories.length &&
              i === root.directories.length - 1,
          }"
        >
          <!-- `draggable` for the "pull them up and down" drag. It changes
               nothing about the click, the context menu or the keyboard —
               see the drag section in the script for why each of those is
               safe rather than merely untested.

               NOT while a filter is up: a drag writes the WHOLE panel's keys
               in draw order (reorderFolders), and under a filter that
               draw order is the SURVIVORS' — dropping a row mid-search would
               silently erase every hidden folder's rank. A gesture that
               cannot say what it would destroy is refused at the source, and
               the rows say so by not even offering the grip. -->
          <button
            class="dir-header"
            :class="{
              current: dir.key === props.activeFolder,
              orphan: dir.untracked,
              attached: dir.active,
              dragging: props.dragging === dir.key,
            }"
            :title="dirTooltip(dir)"
            :draggable="props.filtering ? 'false' : 'true'"
            :data-session-name="soleSession(dir) ?? undefined"
            @click="onFolderClick(dir)"
            @contextmenu.prevent="emit('menu', dir, $event)"
            @dragstart="emit('dragStart', dir, $event)"
            @dragover="emit('dragOver', root, i, $event)"
            @drop.prevent="emit('drop')"
          >
            <!-- The dot says "something live is in here". It used to be an
                 aggregate standing in for a collapsed branch; now it is the
                 only place the panel reports attachment at all, because the
                 sessions it belonged to are no longer rows. -->
            <span class="dot" :class="{ active: dir.active }" />
            <!-- One span, one CSS ellipsis: when the row runs out of width
                 the label degrades to `course-managemen…` and the tooltip
                 carries the full name (the full path) on hover. An untracked
                 folder is labelled by its session name, which is the only
                 label it has. -->
            <span class="label" :class="{ mono: dir.untracked }">{{ dir.label }}</span>
            <!-- One mark per session that runs a named agent, in the folder's
                 TAB-BAR order — the folder's tab bar folded flat, the user's
                 dragged arrangement included (the `tabOrders` prop). This
                 slot used to carry the
                 session count (from 2 up) beside a DEDUPED kind list, two
                 notations on one row; the user asked for the tabs' notation
                 outright — "show the icons from tabs here instead of a
                 number" — so the count is gone and a folder running three
                 claudes wears three sparks. A shell wears no mark
                 (agentBadge's silence rule), so the run can be shorter than
                 the session list, and the row tooltip still counts the
                 sessions and names them; the run itself is capped in
                 `agentBadges`, and past it the tooltip is where the overflow
                 goes.
                 The run is one span so the marks can lie on top of each other
                 (`.agent-run`'s overlap) without the row's `--sp-2` gap
                 pricing every one of them at 20px — the width the cap spends.
                 Rendered only when there IS a run: an empty flex item would
                 still collect two gaps where the label and the timestamp
                 used to have one.
                 Keyed by index, not by kind: the kinds repeat now, and a
                 duplicated key is a Vue warning and broken patching. -->
            <span v-if="badgeViews(dir).length" class="agent-run">
              <template v-for="(view, i) in badgeViews(dir)" :key="i">
                <AppIcon
                  v-if="view.mark"
                  :name="view.mark.icon"
                  :size="12"
                  :title="view.session"
                  class="agent-mark"
                />
                <span v-else class="agent-badge">{{ view.text }}</span>
              </template>
            </span>
            <!-- The folder's age is its NEWEST session's, and it is
                 INDEPENDENT of where the row sits: the list is in the host's
                 order — or the sort the user picked (folderSort.ts) — plus the
                 user's own arrangement, so by default times run in no
                 particular direction down a root. That is a cost of the
                 host-order change and it is paid deliberately — an order you
                 can predict is worth more than one that happened to double as
                 a sort key — and it makes this field carry MORE than it used
                 to rather than less, since position no longer says any of it.
                 Picking the activity sort is what points position back at the
                 timestamp. -->
            <span class="row-time">{{ fmtRelative(dir.mostRecentActivity, props.now) }}</span>
          </button>
          <!-- The narrow layout's third level: the folder's sessions as leaves,
               each opening the folder with its own tab selected. Drawn only
               for a real folder — an untracked folder's row already IS its
               one session. -->
          <ul v-if="drawsLeaves(dir)" class="session-leaves">
            <li v-for="row in dir.rows" :key="row.session.name">
              <button
                class="session-leaf"
                :class="{
                  current: dir.key === props.activeFolder && row.session.name === props.activeSession,
                }"
                :title="row.session.name"
                :data-session-name="row.session.name"
                @click="emit('select', dir, row.session.name)"
              >
                <span class="dot" :class="{ active: row.session.attached }" />
                <span class="label mono">{{ row.session.name }}</span>
                <span class="row-time">{{ fmtRelative(row.session.activity, props.now) }}</span>
              </button>
            </li>
          </ul>
        </li>
      </ul>
    </section>

    <!-- THE MAINTENANCE SECTION — the door to the tool workspaces
         (docs/MONITOR.md), shown while the host has open tools and forced on
         while the workspace itself is on screen. One row: the tools are the
         workspace's tabs, listed there and nowhere here.
         components/MaintenanceSection.vue is the section; the v-if here is
         the only decision this file keeps. -->
    <MaintenanceSection
      v-if="showMaintenance || props.maintenanceCount > 0"
      :count="props.maintenanceCount"
      :active-folder="props.activeFolder"
      @select="(folder) => emit('select', folder)"
    />

    <!-- Nothing running anywhere on this host. The sentence used to stand
         alone, which made this the one empty state with no way forward: the
         header's `+` covers it in principle, but it is an unlabelled 14px
         mark in a strip of five, and an empty panel is exactly when a user
         has no habits to find it by. The folder workspace's own empty state
         set the pattern ("nothing is running in this folder" + a worded
         "Start a session here" button, FolderWorkspaceView.vue): say what is
         empty AND offer the one useful action. The button opens the same
         dialog the header `+` does, nothing pre-filled — a second door into
         the ONE creation flow, not a second flow.

         A filter that matches nothing gets its OWN sentence, naming the
         query, because "no sessions" while a filter is up is a lie the user
         can see through only by remembering the box they typed into: an
         empty filtered tree must never read as a host with nothing running
         (folderFilter.ts). And it offers no create — the create is not the
         next step of a search, and a row born under an active filter would
         be a row the filter immediately hides. -->
    <div v-if="!props.roots.length && !props.loading" class="empty">
      <p v-if="props.filtering" class="muted">no folders match “{{ props.filterQuery.trim() }}”</p>
      <template v-else>
        <p class="muted">no sessions</p>
        <button class="btn-ghost" @click="emit('create', props.defaultStartIn)">
          New session…
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* Everything in this block styles THIS component's markup and was carried
   verbatim from SessionTree.vue's stylesheet — scoped styles do not cross the
   component boundary, so the rules must live beside the rows they draw. The
   container queried at the bottom of the block is `.tree`, in the parent;
   container resolution follows the DOM, not the scope. */

.folder-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--sp-2) 0;
}
.folder {
  margin-bottom: var(--sp-1);
}
/* A <div>, so the button reset this used to carry — background, border, color,
   text-align, cursor, font-family/size/line-height — is all gone: everything in
   that list is either the element's own default or inherited from `body`. Only
   the weight is a real decision and it stays.

   The row still gets no BACKGROUND on hover: a lift under the cursor advertises
   a click, and this row does not take one. The `:hover` rule it does have
   reveals the `+` inside it and touches nothing else, which says the opposite
   of a lift — the row is inert, and the one thing in it that is not says so by
   appearing. */
.folder-header {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  height: var(--row-h);
  padding: 0 var(--row-pad-x) 0 var(--sp-3);
  font-weight: var(--fw-semibold);
  overflow: hidden;
}
.folder-label {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The `~/` every root header repeats, receding so the part that IDENTIFIES the
   root is what the eye lands on. A colour rather than an opacity, and on its
   own span rather than on the label: `opacity` on the label would fade `git`
   too, which is the one word in the row that has to stay crisp.

   `--fg-muted` rather than `--fg-secondary` — one step further down than the
   `other` bucket below, because that row's whole label is toned to say what
   KIND of row it is, whereas this tones a fragment inside an ordinary one. */
.path-prefix {
  color: var(--fg-muted);
}
/* `other` is a bucket, not a directory: lowered so it does not read as a
   folder the user could navigate to. */
.folder-label.bucket {
  font-weight: var(--fw-regular);
  color: var(--fg-secondary);
}
/* Bare count, no `· 3 sessions`: the number is the whole message, and the
   header is the one row per root this design is allowed to spend.

   NEXT TO THE LABEL, not pinned right. It carried `margin-left: auto`, which
   threw it to the far end of the row where `10` sat level with `git` and
   related to nothing — "move 10 closer to git". The `auto` moved to the two
   elements that genuinely want the right edge: the root row's `+` and the
   folder row's timestamp, each of which is a column in its own right. */
.folder-count {
  flex: none;
  font-weight: var(--fw-regular);
  font-size: var(--fs-100);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
/* ── The per-root `+`: revealed, not persistent ────────────────────────────
   HOVER- AND FOCUS-REVEALED, and this is the decision the control turned on.

   Persistent was the alternative and it is affordable on width — the root
   labels are short words (`git`, `tmp`) and a 24px square leaves plenty at the
   232px floor. What it is not affordable on is NOISE: one `+` per root is a
   column of identical marks running down a panel whose entire job is to be
   scanned, repeating an affordance that is identical on every row. VS Code's
   tree-row actions reach the same conclusion for the same reason.

   Two rules make the reveal honest rather than merely quiet:

     - it is `opacity`, never `display`. The square is always laid out, so the
       root label never reflows when the cursor arrives — a row that changes
       width under the pointer is worse than a mark that was always there.
     - `:focus-visible` reveals it too, so it is fully reachable by keyboard and
       VISIBLE once reached. A hover-only affordance is one a keyboard user can
       tab into and not see, which is the failure mode this pattern usually
       ships with.

   `@media (hover: none)` shows it unconditionally: a pointer that cannot hover
   would otherwise never reveal it at all.

   What it is deliberately NOT conditioned on is whether the root is empty. An
   empty registered root is the `+`'s most useful case, but `directories.length`
   changes under the sessions store's refresh timer, so keying visibility off it
   would make the control appear and disappear as sessions come and go — the
   same trap the root rows' own comment records about expansion state. Every
   root row carries the same mark, always, in the same place. */
/* `margin-left: auto` is what keeps the `+` on the right edge now that the
   count no longer holds it there. It is the one control in this row rather
   than a field, so it is the one that belongs in the right column — and
   because the square is always LAID OUT (only its opacity changes), the label
   and count never reflow when the cursor arrives. */
.root-add {
  flex: none;
  margin-left: auto;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease);
}
.folder-header:hover .root-add,
.root-add:focus-visible {
  opacity: 1;
}
/* `.folder-header` clips (`overflow: hidden`), which would eat a +2px ring. */
.root-add:focus-visible {
  outline-offset: -2px;
}
@media (hover: none) {
  .root-add {
    opacity: 1;
  }
}
/* ── The per-root sort door ────────────────────────────────────────────────
   The `+`'s reveal rules copied whole — opacity never `display` (the count
   never reflows under the cursor), `:focus-visible` so a keyboard user sees
   what they tabbed to, `hover: none` for the pointer that cannot hover.
   Nothing holds the mark visible on its own: the rows' order itself says a
   sort is in force, and the state keeps its always-visible doors in the
   search row and Settings' select. `.engaged` only tints the mark once the
   cursor is on the header — `.sort-btn.engaged`'s rule from SessionTree,
   carried over, because the two marks are doors to the same menu and must
   read as the same control. */
.root-sort {
  flex: none;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease);
}
.folder-header:hover .root-sort,
.root-sort:focus-visible {
  opacity: 1;
}
.root-sort.engaged {
  color: var(--accent);
}
/* Same clipped-ring reason as `.root-add` above. */
.root-sort:focus-visible {
  outline-offset: -2px;
}
@media (hover: none) {
  .root-sort {
    opacity: 1;
  }
}
.dir-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
/* ---- dragging a folder row ---------------------
 *
 * The tab bar's three rules, turned ninety degrees (FolderWorkspaceView's
 * `.tab.dragging`): the carried row FADES BUT STAYS IN
 * PLACE, because removing it from the flow would shift every row below it the
 * instant the drag began and move the target the user is aiming at; the landing
 * place is a 2px accent rule in the gap, because without one a reorder is "let
 * go and find out"; and a REFUSED drop draws nothing at all, which is how the
 * one rule this drag enforces — a row cannot leave its root — is made visible
 * while the drag is still in the air.
 *
 * `inset` box-shadow rather than a real border, exactly as the tabs do it: a
 * border would change the row's height and shove the whole list down by 2px as
 * the indicator moved between gaps, which is the same "target moves under the
 * cursor" failure the fade is avoiding. The shadow is drawn on the `<li>`
 * because the button's own left border is already spent on the selection rail.
 */
/* ---- dragging a ROOT header ---------------------
 *
 * The folder drag's three rules, one level up (`.dir-header.dragging` and the
 * `li` rules below): the carried header FADES BUT STAYS IN PLACE, the landing
 * place is a 2px accent rule, and a REFUSED drop draws nothing at all — which
 * is how the rules this drag enforces (the `other` bucket cannot be carried,
 * and nothing lands below it) are made visible while the drag is still in the
 * air. The rule draws on the SECTION, not the header: its top edge is the
 * boundary above the group, its bottom edge is below the group's last row —
 * on the header it drew "after the name", a rule inside the group it claimed
 * to end. `inset` box-shadow rather than a real border, for the same
 * height-shifting reason the folder rows give.
 */
.folder-header.dragging {
  opacity: var(--disabled-opacity);
}
.folder.drop-above {
  box-shadow: inset 0 2px 0 0 var(--accent);
}
.folder.drop-below {
  box-shadow: inset 0 -2px 0 0 var(--accent);
}
.dir-header.dragging {
  opacity: var(--disabled-opacity);
}
.dir-list li.drop-above {
  box-shadow: inset 0 2px 0 0 var(--accent);
}
.dir-list li.drop-below {
  box-shadow: inset 0 -2px 0 0 var(--accent);
}
/* ── The indent budget, in one place ───────────────────────────────────────
   TWO levels, and no chevron column on either of them now that a root row is a
   header rather than a node. The column both rows share is the DOT, because it
   is the one element every row type has; the labels follow it at a constant
   16px (8px dot + an --sp-2 gap).

     level        dot    label
     root          12      28
     folder        20      36

   The root's 12px is --sp-3 rather than the --sp-2 the chevron used to start
   at: with the mark gone, an 8px inset put the dot hard against the panel edge
   and the root read as unindented rather than as the outer level. The folder
   step stays 8px — 18px of padding plus its 2px selection rail — which is the
   whole of the nesting this panel expresses.

   Dropping the chevron gives every row 18px back. At the 232px panel floor the
   timestamp is already gone (see the container query at the bottom of this
   block) and a folder row has 232 - 36 - 10 = 186px for its label, marks and
   count. Truncation is the ordinary end ellipsis; the row tooltip carries the
   full name. */
/* Sits in the folder slot, but is prose rather than a row: no dot, so
   it starts where a directory LABEL starts (36) instead of where its dot
   does. */
.empty-root {
  height: var(--row-h);
  display: flex;
  align-items: center;
  padding: 0 var(--row-pad-x) 0 36px;
  font-size: var(--fs-200);
  font-style: italic;
}
/* One step in from the root header: 18px of padding plus the 2px rail puts the
   dot at 20, 8px right of the root's. */
.dir-header {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  height: var(--row-h);
  background: transparent;
  border: none;
  border-left: 2px solid transparent;
  color: var(--fg);
  text-align: left;
  padding: 0 var(--row-pad-x) 0 18px;
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  line-height: var(--lh-300);
  overflow: hidden;
}
.dir-header:hover {
  background: var(--state-hover);
}
/* Selection is accent-tinted and railed; hover is a neutral lift. The two used
   to be the same cyan at two alphas, which read as one state. */
.dir-header.current {
  background: var(--state-selected);
  border-left-color: var(--accent);
}
/* A folder that is only a session — no reported cwd — is labelled by that
   session's NAME, so it is set in the mono face the name deserves and toned
   down, because it is a row we could not place rather than a folder the user
   organised. */
.dir-header.orphan .label {
  color: var(--fg-secondary);
}
.dir-header:hover {
  background: var(--state-hover);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--fg-muted);
  flex-shrink: 0;
}
.dot.active {
  background: var(--success);
}
/* The label wins the width fight; everything else shrinks first.

   `flex: 0 1 auto`, not `1 1 auto`: it may still SHRINK before the marks and
   the count do, but it no longer GROWS to eat the free space — growing is what
   pushed the count away from the label it belongs to. The right edge is held
   by `.row-time`'s `auto` margin instead, so the timestamps still line up in a
   column down the panel. */
.label {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg);
}
.label.mono {
  font-family: var(--font-mono);
}
/* A folder holding an attached session is semibold, so weight and colour (the
   green dot) say the same thing. This is what replaced the `attached` tag —
   and it now carries the whole of that job, because attachment is no longer a
   SORT key: a row that jumped to the top of its root the moment you opened it
   was the list rearranging itself in response to being used. The mark stays; the movement went. */
.dir-header.attached .label {
  font-weight: var(--fw-semibold);
}
/* The engine marks sit at the panel's own muted grey, never a per-kind hue:
   the SHAPE says which agent (the tooltip names it on first hover), and a
   row of logos at full contrast would out-shout the labels they qualify —
   the same call the tab bar's `.tab-agent` made. */
.agent-mark {
  flex: none;
  color: var(--fg-muted);
}
/* ── The badge run: stacked at rest, spread under the cursor ──────────────
   The run is priced by the row's `--sp-2` gap as long as the marks are its
   direct children — 20px a mark, which is what forced `agentBadges`' cap of
   four and made a folder's row disagree with its own tab strip (six tabs,
   four marks). One span, its own flex formatting, and the mark-on-mark
   overlap buys each extra mark down to 8px, so the cap can rise to the
   tooltip's six and the row reads as its tabs again.

   At rest each mark after the first lies 4px deep on its neighbor —
   `margin-left: -4px` against no run gap — enough to read as one compact
   run without mangling 12px glyphs; the marks are monochrome line art at
   `--fg-muted`, so the pile stays one texture. Under the cursor (or
   `:focus-visible`, the root-add's rule: a keyboard user sees what they
   tabbed to) the same margin walks out to `--sp-1` and the run blooms
   apart — the reading order the stack is compressed FROM. `@media
   (hover: none)` keeps it spread: a pointer that cannot hover would never
   see the bloom at all.

   The spread is a real layout change — margin, not transform — and that is
   the honest cost of the effect: the timestamp is pinned by its own auto
   margin and cannot move, so the one thing a wider run can shift is where
   an ALREADY-ellipsed label cuts. The root-add rule — "a row that changes
   width under the pointer is worse" — is about an affordance appearing;
   here the movement is the affordance, asked for outright ("spreading a
   little on hover"), and it settles the moment the cursor leaves. */
.agent-run {
  display: inline-flex;
  align-items: center;
  flex: none;
}
/* Word chips (`probing…`, `exited`) have borders and need a breath between
   neighbours, whatever they stand next to; mark-on-mark (the rule below)
   overrides it with the overlap. */
.agent-run > * + * {
  margin-left: var(--sp-1);
}
.agent-run > .agent-mark + .agent-mark {
  margin-left: -4px;
  transition: margin-left var(--dur-fast) var(--ease);
}
.dir-header:hover .agent-run > .agent-mark + .agent-mark,
.dir-header:focus-visible .agent-run > .agent-mark + .agent-mark {
  margin-left: var(--sp-1);
}
@media (hover: none) {
  .agent-run > .agent-mark + .agent-mark {
    margin-left: var(--sp-1);
  }
}
/* The transient detector states keep a WORD, not a logo — a state is not a
   product — in the shared chip metric, dim register only: transparent
   ground, hairline border, secondary ink. */
.agent-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  flex: none;
  line-height: var(--lh-100);
  font-size: var(--fs-100);
  font-weight: var(--fw-medium);
  color: var(--fg-secondary);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 0 var(--sp-1);
  white-space: nowrap;
}
/* Holds the right edge, which the count used to. It is a column the eye reads
   down — ages only compare against each other — so it is the field that has to
   stay aligned. When the container query below hides it, the `auto` goes with
   it and the row simply hugs the left, which is the right shape for a row that
   has run out of width. */
.row-time {
  flex: none;
  margin-left: auto;
  font-size: var(--fs-100);
  color: var(--fg-secondary);
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}
/* Sentence over action, left on the panel's own indent rather than centred:
   the workspace's empty state centres in a whole pane, and centring in a strip
   that drags down to 232px would just ragged-edge two short lines. */
.empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
}
.empty p {
  margin: 0;
}
/* Below ~270px the row cannot hold every field. The timestamp goes first: it
   is still the least operational of them, though the ORIGINAL reason for
   picking it — "a recency-sorted list already carries most of what it says" —
   died with the recency sort. What survives the
   revision is the comparison rather than the absolute: at the 232px floor
   something has to go, and every other field on the row either identifies it
   (label), locates it (dot) or says what is running in it (mark), and an age
   answers none of those. It is a genuine loss at that width now rather than a
   redundancy, and it is recorded as one. Dot, label and mark survive to the
   232px floor. The
   rule is unscoped on purpose, so a directory header drops its aggregate age
   at the same width its children drop theirs — a header still showing a time
   above rows that had theirs removed would read as its own, separate fact.
   270 rather than revision 2's 250, by the same arithmetic that set 250: the
   leaf row is 16px deeper than the single-session row it replaces, and it now
   carries a full session name rather than a short directory basename, so it
   runs out of width that much sooner. */
/* The narrow layout's session leaves: one step in from the folder row (its
   dot at 28, 8px right of the folder's), the session NAME in the mono face
   the terminal tabs use. */
.session-leaves {
  list-style: none;
  margin: 0;
  padding: 0;
}
.session-leaf {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  height: var(--row-h);
  background: transparent;
  border: none;
  border-left: 2px solid transparent;
  color: var(--fg);
  text-align: left;
  padding: 0 var(--row-pad-x) 0 26px;
  cursor: pointer;
  font-size: var(--fs-300);
  overflow: hidden;
}
.session-leaf:hover {
  background: var(--state-hover);
}
.session-leaf.current {
  background: var(--state-selected);
  border-left-color: var(--accent);
}
/* With leaves drawn, a folder row is a header over them: it keeps its click
   (opening the folder), but reads one step quieter than the sessions. */
.folder-list.leaves .dir-header .label {
  color: var(--fg-secondary);
}
/* A coarse pointer (a finger) gets rows it can hit: the platform's 48px
   touch target instead of the desktop's 28px list rhythm, and the root row's
   doors at the same size. Keyed on the input device, not the viewport, so a
   narrow desktop window keeps its density and a tablet gets the targets. */
@media (pointer: coarse) {
  .folder-header,
  .dir-header,
  .session-leaf,
  .empty-root {
    height: auto;
    min-height: 48px;
  }
  .root-add,
  .root-sort {
    width: 48px;
    height: 48px;
  }
}
@container (width < 270px) {
  .row-time {
    display: none;
  }
}
</style>
