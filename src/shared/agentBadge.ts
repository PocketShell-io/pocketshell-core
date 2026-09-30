/**
 * Which mark a session tab wears for the agent running in it, and which mark
 * a provider wears in the usage table — the two places this UI names an
 * engine or provider by its vendor's own silhouette.
 *
 *
 * The classification itself is not decided here and is not decided anywhere in
 * this app: `@ps_agent_kind` is a per-session tmux user option written by the
 * helper's `pocketshell agent` wrapper in the process that becomes the agent,
 * and it reaches the renderer as `SessionSummary.agentKind`. This module is
 * presentation and nothing else — it answers "what does that kind look like on
 * a 12px tab".
 *
 * ## What the phone does, and why none of it is ported
 *
 * Checked before designing, because a difference from the phone should be a
 * decision rather than an accident. The Android app renders a **two-letter
 * monogram in a tinted pill** — `CL`, `CX`, `OC`, `GK`, `SH`, `?` —
 * (`sessionBadgeMonogram` in `app/.../projects/FolderListTreeChrome.kt`, drawn
 * by `shared/ui-kit/.../components/AgentKindBadge.kt`). Its tint is BINARY, not
 * per-kind: agent means one purple (`#A78BFA`), non-agent means grey, so
 * Claude, Codex, OpenCode and Grok are told apart by their letters alone. It
 * ships no per-agent drawable at all — `res/drawable/` holds only the launcher,
 * the quick-settings tile and the two notification marks.
 *
 * So there was nothing to port, and the one mechanism it does have cannot come
 * across: a letter standing in for a graphic affordance is exactly what
 * `tests/unit/designGates.test.ts` enforces.
 * A monogram would also inherit the UI font at the tab's own size rather than
 * the stroke weight the rest of the bar shares — the same reason `type` is a
 * drawn "T" in AppIcon.vue and not a typed one.
 *
 * ## The marks are the vendors' own
 *
 * Originally four arbitrary Feather marks (`hexagon`, `code`, `terminal`,
 * `zap`), chosen because vendor logos at 12-14px looked like a licensing and
 * fidelity trap. That reasoning lost to the thing it was protecting: the
 * arbitrary shapes never became legible — a user had to hover each one to
 * learn it, and the tooltip was doing the identifying, not the mark — so the
 * badges went to the actual product marks (claude's spark, the OpenAI knot,
 * the Grok loop, opencode's frame), rendered as flat single-colour
 * silhouettes at the same muted grey the arbitrary marks wore. Monochrome at
 * the app's own contrast answers the fidelity half of the trap, the marks are
 * carried at UI sizes to identify the tool the session runs — nominative use,
 * the way a dependency list names a product — answers the licensing half, and
 * the geometry sources are recorded in AppIcon.vue's brand register.
 *
 * They are named `brand-*` in AppIcon.vue so the Feather entries stay a
 * registry of shape-named MARKS, and this file remains the only place that
 * knows which product wears which.
 *
 * ## Nothing at all for unknown, and that is the point
 *
 * The unknown case is common and legitimate. A session started outside the
 * `pocketshell agent` wrapper — by hand, by `tmuxctl`, by the user's own
 * terminal — reads as `unknown` forever, because the wrapper is what records
 * the option; and a plain shell tab is not a failure of detection, it is a
 * shell. Marking either would put a glyph on most of the bar that means "we do
 * not know", which is worse than silence: it costs the same 12px, it trains the
 * eye to ignore the slot, and it takes away the only useful property a sparse
 * badge has — that its PRESENCE is information.
 *
 * `probing` and `exited` are the phone's transient detector states. The desktop
 * runs no detector so nothing emits them, and they are listed in the switch
 * anyway so this stays exhaustive against the same enum the phone renders.
 */

import type { SessionAgentKind } from '../types';

/**
 * The AppIcon marks this module may name.
 *
 * A narrow union rather than an import of `AppIconName`, because that type
 * lives inside a `.vue` SFC and this module is plain shared code that the main
 * process's `tsconfig` also compiles. The link between the two is checked where
 * it matters anyway: the template binds this string to `<AppIcon :name>`, so a
 * mark renamed in the registry fails `vue-tsc` at the call site rather than
 * rendering an empty `<svg>`.
 */
type AgentMarkName =
  | 'brand-claude'
  | 'brand-codex'
  | 'brand-copilot'
  | 'brand-grok'
  | 'brand-opencode'
  | 'brand-zai';

/** What a session tab shows for one agent kind. */
export interface AgentMark {
  icon: AgentMarkName;
  /** Tooltip text. The mark is arbitrary; this is what makes it legible. */
  label: string;
}

/**
 * The mark for [kind], or null when the tab should show nothing.
 *
 * Null is the answer for every kind that is not one of the four engines — see
 * the header for why `unknown` and `shell` deliberately get no glyph rather
 * than a "we don't know" one.
 *
 * `grok` is badged unconditionally, and that is independent of whether this
 * app could have started the session. Launching one now depends on the HOST —
 * 0.4.44's `pocketshell agent` has no `grok` subcommand, newer helpers do, and
 * `agentLaunch.ts` probes for it — while a session can be a grok session
 * regardless: the phone launches it through its own engine registry and the
 * tmux option is on the session either way. Reading our own capability, or a
 * particular host's, out of the record we are merely displaying would badge
 * the same session differently depending on which machine it came from.
 */
export function agentMark(kind: SessionAgentKind | null | undefined): AgentMark | null {
  switch (kind) {
    case 'claude':
      return { icon: 'brand-claude', label: 'Claude Code' };
    case 'codex':
      return { icon: 'brand-codex', label: 'Codex' };
    case 'opencode':
      return { icon: 'brand-opencode', label: 'OpenCode' };
    case 'grok':
      return { icon: 'brand-grok', label: 'Grok' };
    case 'shell':
    case 'unknown':
    case 'probing':
    case 'exited':
    case null:
    case undefined:
      return null;
    default:
      // An enum member added host-side that this build does not know about.
      // Silence is the safe answer for the same reason `unknown` gets it.
      return null;
  }
}

/**
 * The mark the provider usage table wears beside [provider]'s name — the same
 * vendor register the session tabs draw from, read by the usage ROW's
 * provider key instead of a session's agent kind.
 *
 * The tab function stays the narrower question and this the broader one,
 * because the two key off different vocabularies that mostly overlap: the
 * usage table speaks the helper's provider names, where `go` IS OpenCode (on
 * the Go backend, the helper's own gloss) but `copilot` and `zai` are
 * providers no session kind ever names — their marks exist for this table
 * alone. An unfamiliar provider gets null, the tab rule's silence: a table
 * where every row wears SOMETHING would have the same "we do not know"
 * glyph problem the header above refuses.
 */
export function usageProviderMark(provider: string): AgentMark | null {
  switch (provider.toLowerCase()) {
    case 'claude':
      return { icon: 'brand-claude', label: 'Claude Code' };
    case 'codex':
      return { icon: 'brand-codex', label: 'Codex' };
    case 'copilot':
    case 'github_copilot':
    case 'github-copilot':
      return { icon: 'brand-copilot', label: 'GitHub Copilot' };
    // The helper's own gloss: `go` is OpenCode on the Go backend.
    case 'go':
    case 'opencode':
    case 'open_code':
    case 'open-code':
      return { icon: 'brand-opencode', label: 'OpenCode' };
    case 'grok':
    case 'grok-build':
      return { icon: 'brand-grok', label: 'Grok' };
    case 'zai':
      return { icon: 'brand-zai', label: 'Z.ai' };
    default:
      return null;
  }
}
