<script setup lang="ts">
// AgentBadgeRun: one folder row's run of agent marks — the folder's tab bar
// folded flat, one mark per session that runs a named agent. Extracted from
// SessionTreeRowsView.vue with its styles: the run has its own stacking
// rules (the overlap, the bloom under the cursor) and its own badge logic,
// and none of it touches the rows around it. Presentational like its parent:
// a folder and its stored tab ranking in, nothing out.
import { computed } from 'vue';
import AppIcon from '@ui/components/AppIcon.vue';
import type { SessionDirectory } from '../sessionTree';
import { agentBadge, agentBadges, type AgentBadgeKind } from '../sessionTreeText';
import { agentMark, type AgentMark } from '@pocketshell/core/shared/agentBadge';

const props = defineProps<{
  /** The folder whose sessions the run stands for. */
  dir: SessionDirectory;
  /**
   * The folder's stored tab ranking (`applyTabOrder` over the `ps.tabOrder`
   * arrangement), so the run follows the order the user dragged the
   * workspace's tabs into. Absent means the derived order, exactly as the
   * un-arranged bar wears it.
   */
  tabOrder?: readonly string[];
}>();

/**
 * What one badge slot shows for a kind. The four engines wear their own
 * brand marks (`agentMark`) at the panel's muted grey — VS Code's treatment
 * of tree adornments: present, never competing with the label they qualify.
 * The mark's tooltip names the SESSION the badge stands for, not the engine —
 * the silhouette already says codex, and in a stacked run of look-alike marks
 * the hover is what tells the copies apart. `probing…` and `exited` are
 * detector STATES rather than products, so they keep the word form, dimmed —
 * a logo on those would claim a product that is not running.
 */
interface AgentBadgeView {
  kind: AgentBadgeKind;
  session: string;
  mark: AgentMark | null;
  text: string | null;
}

const views = computed<AgentBadgeView[]>(() =>
  agentBadges(props.dir, props.tabOrder).map(({ kind, session }) => {
    const mark = agentMark(kind);
    return { kind, session, mark, text: mark === null ? agentBadge(kind) : null };
  }),
);
</script>

<template>
  <!-- The run is one span so the marks can lie on top of each other
       (`.agent-run`'s overlap) without the row's `--sp-2` gap pricing every
       one of them at 20px — the width the cap spends. Rendered only when
       there IS a run: an empty flex item would still collect two gaps where
       the label and the timestamp used to have one. Keyed by index, not by
       kind: the kinds repeat, and a duplicated key is a Vue warning and broken
       patching. -->
  <span v-if="views.length" class="agent-run">
    <template v-for="(view, i) in views" :key="i">
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
</template>

<style scoped>
/* CARRIED from SessionTreeRowsView.vue's stylesheet with the markup it
   styles: scoped styles do not cross the component boundary. The hover and
   focus selectors below still name the parent's `.dir-header` — scoped CSS
   pins only the LAST compound to this component, and the row it hovers is
   an ancestor in the DOM, which is what the descendant combinator matches. */

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
</style>
