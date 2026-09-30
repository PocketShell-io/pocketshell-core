/**
 * The session tree's presentation text: tooltips, badges, counts and the
 * compact relative age. Extracted from SessionTree.vue verbatim (comments
 * included); every function is pure, so the module holds no reactivity —
 * `fmtRelative` takes the panel's clock tick as an argument rather than
 * reading a ref.
 */
import type { SessionAgentKind } from './types';
import type { SessionDirectory, SessionRootFolder } from './sessionTree';

/** `1 session` / `3 sessions` — the phrase form, which lives only in tooltips. */
export function sessionCountLabel(count: number): string {
  return count === 1 ? '1 session' : `${count} sessions`;
}

/**
 * Header tooltip: the root's real path plus its size. `~/git` rather than the
 * absolute form, because the key IS home-relative — the two spellings tmux
 * reports for one directory are deliberately folded into it.
 *
 * A registered root holding nothing says so in words. It is the one header
 * that can be empty, and "0" alone would read as a bug rather than as the
 * setting doing exactly what it was told.
 */
export function rootTooltip(root: SessionRootFolder): string {
  const count = sessionCountLabel(root.sessionCount);
  if (root.other) return `sessions outside every root, or with no known folder\n${count}`;
  if (root.configured && root.sessionCount === 0) {
    return `${root.key}\nregistered in Settings — nothing running here`;
  }
  return `${root.key}\n${count}`;
}

/**
 * Folder tooltip: the full path, the session count, and the session NAMES.
 *
 * The names are here because they are no longer on screen — the workspace's
 * tab bar carries them, which is behind a click. One hover is the cheapest
 * place to answer "what is actually in here" without spending a row per
 * session again, and it is capped so a folder with a dozen sessions produces a
 * tooltip rather than a wall.
 *
 * An untracked folder says so instead of printing a path it does not have, and
 * one whose path was adopted from a sibling says THAT, because a guess
 * presented as a reported cwd is the kind of thing that wastes an hour

 */
const TOOLTIP_NAME_LIMIT = 6;

export function dirTooltip(dir: SessionDirectory): string {
  const lines: string[] = [];
  if (dir.untracked) {
    lines.push(
      dir.inferredRoot
        ? 'no reported folder — root read back from the name'
        : 'no reported folder',
    );
  } else {
    lines.push(dir.path);
    if (dir.rows.some((row) => row.session.pathInferred)) {
      lines.push('folder inferred from the session name, not reported by tmux');
    }
  }
  lines.push(sessionCountLabel(dir.rows.length));
  const names = dir.rows.slice(0, TOOLTIP_NAME_LIMIT).map((row) => `  ${row.session.name}`);
  lines.push(...names);
  if (dir.rows.length > TOOLTIP_NAME_LIMIT) {
    lines.push(`  … and ${dir.rows.length - TOOLTIP_NAME_LIMIT} more`);
  }
  return lines.join('\n');
}

/**
 * Row badge for the host-recorded `@ps_agent_kind` (types.ts:103). Null,
 * undefined and `unknown` are all the phone's "Unknown" and get NO badge — a
 * foreign session we did not launch should not be labelled as if we had.
 * `shell` gets none either: a shell is the unremarkable case.
 *
 * The four engines render as their brand marks (`agentMark`), so this word
 * form is what the transient detector states fall back to — `probing…` and
 * `exited` are states, not products, and a logo would claim otherwise.
 */
export function agentBadge(kind: SessionAgentKind | null | undefined): string | null {
  switch (kind) {
    case 'claude':
      return 'claude';
    case 'codex':
      return 'codex';
    case 'opencode':
      return 'opencode';
    case 'grok':
      return 'grok';
    case 'probing':
      return 'probing…';
    case 'exited':
      return 'exited';
    case 'shell':
    case 'unknown':
    case null:
    case undefined:
      return null;
    default:
      return null;
  }
}

/**
 * The agent badges a folder row wears: ONE PER SESSION that runs a named
 * agent, in row order — the same order the folder's workspace tabs wear
 * theirs (`buildWorkspaceTabs` walks the same rows), so the row reads as its
 * tab bar folded flat. The caller decides how each kind presents (a brand
 * mark for the four engines, the dim word form for `probing` / `exited`), so
 * the tree does not have to parse display strings back into kinds.
 *
 * This replaced a session count beside a deduped kind list: the count said
 * HOW MANY and the deduped marks said WHICH PRODUCTS, two notations on one
 * row, and the user asked for the tabs' notation outright — "show the icons
 * from tabs here instead of a number". Shells and unknown kinds wear nothing
 * (agentBadge's silence rule), so the run can be shorter than the folder's
 * session list, and a folder of bare shells wears no marks at all; the row
 * tooltip still counts the sessions and names them, which is where "how
 * many" lives now.
 *
 * The run is capped so a folder with a dozen sessions cannot push the
 * timestamp off the row. The row's marks stack now (SessionTreeRows'
 * `.agent-run` lays mark on mark, 4px deep), so a mark costs 8px where it
 * used to cost 20 — six marks are 52px of the ~186px a row has past the
 * label indent at the 232px panel floor, and the label keeps the rest. Six
 * is also the tooltip's own name limit (`TOOLTIP_NAME_LIMIT`), so the run
 * and the list that names the sessions agree, and a folder's row no longer
 * reads as fewer sessions than its tab strip wears. Past the cap the run
 * simply stops, and the tooltip is where the overflow goes.
 */
const FOLDER_BADGE_LIMIT = 6;

export type AgentBadgeKind = Exclude<SessionAgentKind, 'shell' | 'unknown'>;

export function agentBadges(dir: SessionDirectory): AgentBadgeKind[] {
  const out: AgentBadgeKind[] = [];
  for (const row of dir.rows) {
    const kind = row.session.agentKind;
    if (kind !== 'shell' && kind !== 'unknown' && kind !== null && kind !== undefined) {
      out.push(kind);
      if (out.length === FOLDER_BADGE_LIMIT) break;
    }
  }
  return out;
}

/**
 * Compact relative age: `now`, `12m`, `3h`, `2d`, then an absolute date past a
 * week. Six characters at the very worst, against ~90px for the absolute form
 * this replaced — and that width is exactly what the label needed back.
 *
 * There is no absolute-form companion any more. It existed for the session
 * row's tooltip, and the session rows are gone; a folder row's tooltip names
 * the folder and its sessions, which is what a folder is asked about.
 *
 * (`nowMs` is handed in rather than read from a ref: the minute clock is the
 * panel's — `useSessionTreePoll` — and the rows receive the tick as a prop.)
 */
export function fmtRelative(epochSeconds: number, nowMs: number): string {
  if (!epochSeconds) return '';
  const seconds = Math.max(0, Math.floor(nowMs / 1000) - epochSeconds);
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(epochSeconds * 1000).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}
