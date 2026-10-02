<script setup lang="ts">
// AppIcon: the ONLY way an icon enters this UI. No character ever stands in
// for a graphic affordance — 
//
// Contract (inherited verbatim from the composer's ComposerIcon, which this
// component replaced — the two sets were specified to be pixel-identical so
// the merge was a rename):
//   - one 24x24 viewBox for every mark, so stroke weights stay identical;
//   - stroke="currentColor", never a literal colour — an icon inherits the
//     parent's token colour and its hover/disabled states for free;
//   - stroke-width 2, round caps/joins: Feather 4.29 geometry (MIT), the thin
//     geometric unfilled register of VS Code's Codicons.
//
// Displayed at 16px (default — toolbars, tree glyphs), 14px (dense bars, the
// disclosure chevron) or 12px (chips, table-row actions, block toggles). No
// other sizes; the composer's two sub-12px pips are CSS overrides on marks
// that are status dots rather than affordances.
//
// The `brand-*` names are the one register that is NOT Feather: filled vendor
// marks on the same 24×24 grid, painted `currentColor` like everything else so
// they inherit whatever muted treatment the host gives the stroked marks. See
// the block comment on the entries themselves, and
// `@pocketshell/core/shared/agentBadge` for why the registry carries vendor
// geometry at all.
export type AppIconName =
  | 'activity'
  | 'alert-triangle'
  | 'arrow-left'
  | 'arrow-right'
  | 'arrow-right-left'
  | 'arrow-up'
  | 'arrow-up-down'
  | 'bar-chart-2'
  | 'brand-claude'
  | 'brand-codex'
  | 'brand-copilot'
  | 'brand-grok'
  | 'brand-opencode'
  | 'brand-zai'
  | 'check'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-up'
  | 'circle'
  | 'close'
  | 'code'
  | 'download'
  | 'dot'
  | 'edit-2'
  | 'external-link'
  | 'eye'
  | 'eye-off'
  | 'file'
  | 'folder'
  | 'folder-plus'
  | 'git-branch'
  | 'hexagon'
  | 'home'
  | 'image'
  | 'minus'
  | 'panel-left'
  | 'paperclip'
  | 'plus'
  | 'refresh'
  | 'rotate-ccw'
  | 'search'
  | 'settings'
  | 'square'
  | 'star'
  | 'star-filled'
  | 'symlink'
  | 'terminal'
  | 'toggle-left'
  | 'toggle-right'
  | 'tool'
  | 'trash-2'
  | 'type'
  | 'zap';

/**
 * Feather 4.29 path data (MIT), verbatim. One entry per icon.
 *
 * `filled` marks the exceptions to the outline register: a status dot has no
 * outline to speak of, so it is painted rather than stroked.
 */
interface IconShape {
  paths: string[];
  filled?: boolean;
}

/**
 * Feather's `star` polygon, its ten points written as one path so the template
 * stays a single path loop. Shared by the two entries below rather than typed
 * twice: `star` and `star-filled` are ONE mark in two states, and a
 * transcription drift between them would show up as the outline and the solid
 * being subtly different stars.
 */
const STAR_PATH =
  'M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26z';

const GEOMETRY: Record<AppIconName, IconShape> = {
  // Feather's `activity`, its <polyline> as one path. The HOST MONITOR trigger
  // (app/hostPanels.ts): the pulse line — the register every live read of a
  // running box wears. Deliberately not a meter: `bar-chart-2` already means
  // the usage panel, and a heartbeat says "something running to watch"
  // where a bar says "a number to read".
  activity: { paths: ['M22 12h-4l-3 9L9 3l-3 9H2'] },
  // Feather's `alert-triangle`. The banner mark for a scan that is failing —
  // a warning about a background process, not an error the user caused.
  'alert-triangle': {
    paths: [
      'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z',
      'M12 9v4',
      'M12 17h.01',
    ],
  },
  'arrow-left': { paths: ['M19 12H5', 'M12 19l-7-7 7-7'] },
  'arrow-right': { paths: ['M5 12h14', 'M12 5l7 7-7 7'] },
  // Two opposing arrows, built in Feather's own construction — each half is
  // `arrow-right` scaled onto one baseline (line + a three-point head) and
  // mirrored. Neither Feather 4.29 nor this registry had a mark for it, and
  // the two halves are written to mirror each other so the pair cannot drift.
  // The PORT FORWARDING trigger (renderer/hostPanels.ts): a local port and a
  // remote port joined in both directions. An opposing pair rather than
  // `shuffle`'s crossing arrows or `symlink`'s turn, because forwarding is a
  // symmetric MAPPING between two sides, not a route that leaves from one of
  // them.
  'arrow-right-left': {
    paths: ['M4 7h16', 'M16 3l4 4-4 4', 'M20 17H4', 'M8 13l-4 4 4 4'],
  },
  // "Up one folder" in the project browser. An arrow, not a chevron: the
  // chevron is this app's disclosure/navigate-into mark and is already spoken
  // for by the folder rows underneath it.
  'arrow-up': { paths: ['M12 19V5', 'M5 12l7-7 7 7'] },
  // Two opposing vertical arrows — `arrow-up` and its mirror side by side,
  // `arrow-right-left`'s construction turned ninety degrees, the halves
  // written to mirror each other so the pair cannot drift. Neither Feather
  // 4.29 nor this registry had a mark for it. The SESSION PANEL's sort
  // triggers (app/components/SessionTree.vue, SessionTreeRows.vue): the
  // folder rows can be read in any of four orders, so the mark says
  // "reorder" without committing to a direction. Not the chevron — the
  // chevron is this app's disclosure mark, and on a tree header it would
  // advertise a collapsing that does not exist.
  'arrow-up-down': {
    paths: ['M7 4v16', 'M3 16l4 4 4-4', 'M17 20V4', 'M13 8l4-4 4 4'],
  },
  // Feather's `bar-chart-2`, its three <line>s run upward from the common
  // baseline y=20 as relative paths. The PROVIDER USAGE trigger
  // (renderer/hostPanels.ts): the one register every tool uses for a meter.
  'bar-chart-2': {
    paths: ['M18 20v-10', 'M12 20V4', 'M6 20v-6'],
  },
  // ── The brand register ────────────────────────────────────────────────────
  // The agent engines' own marks, the deliberate exception to the Feather
  // outline register this registry is otherwise made of. Each is a FILLED
  // vendor silhouette on the same 24×24 grid, painted `currentColor` like
  // every other entry — the colour never names the agent (the tab bar greys
  // them, the session tree shows them at `--fg-muted`); the SHAPE does.
  //
  // Geometry: Simple Icons (CC0) paths, verbatim, for claude, codex (the
  // OpenAI knot), opencode and copilot; grok redrawn from the mark in grok.com's own
  // favicon, rescaled 512→24 and then normalized to fill the canvas the way
  // Simple Icons normalizes its own entries — the favicon carries padding of
  // its own, and the straight multiply brought it across, leaving the loop
  // reading a size smaller than its neighbours in the same box (both strokes
  // are absolute-command paths, so the rescale is a straight coordinate
  // multiply). They are trademarks and are
  // worn nominatively — to say WHICH agent a session runs, the way a
  // dependencies file names a product — which is the answer to the
  // "licensing and fidelity trap" that the previous arbitrary Feather marks
  // were chosen to dodge; the reversal is recorded in
  // `@pocketshell/core/shared/agentBadge.ts`, and these names exist so the
  // shape-named Feather entries above stay a registry of MARKS, with the
  // which-product-wears-which knowledge living in that mapping alone.
  'brand-claude': {
    paths: [
      'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z',
    ],
    filled: true,
  },
  'brand-codex': {
    paths: [
      'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z',
    ],
    filled: true,
  },
  // The two strokes of the Grok loop, as two subpaths of one mark, scaled to
  // fill the canvas like the Simple Icons entries above.
  'brand-grok': {
    paths: [
      'M9.268 15.406L17.248 9.263C17.64 8.961 18.198 9.079 18.385 9.548C19.365 12.014 18.927 14.979 16.975 17.014C15.023 19.049 12.308 19.496 9.827 18.479L7.114 19.789C11.004 22.56 15.726 21.875 18.678 18.796C21.018 16.353 21.743 13.027 21.065 10.025L21.071 10.031C20.088 5.623 21.313 3.862 23.822 0.259C23.881 0.173 23.941 0.087 24 0L20.699 3.443V3.432L9.267 15.407',
      'M7.622 16.899C4.831 14.117 5.312 9.814 7.694 7.332C9.455 5.495 12.34 4.746 14.86 5.848L17.565 4.545C17.078 4.178 16.453 3.782 15.736 3.505C12.497 2.115 8.618 2.807 5.984 5.551C3.451 8.193 2.655 12.255 4.022 15.722C5.044 18.313 3.369 20.145 1.682 21.994C1.083 22.65 0.484 23.306 0 24L7.62 16.901',
    ],
    filled: true,
  },
  // A thick square frame — the OpenCode mark, whose inner square is the hole
  // the two opposite-wound subpaths cut under the default nonzero fill rule.
  'brand-opencode': { paths: ['M22 24H2V0h20zM17 4.8H7v14.4h10z'], filled: true },
  // GitHub Copilot, Simple Icons (CC0) verbatim like the three above. The
  // PROVIDER USAGE table wears it beside copilot's name; it is not an agent
  // kind, so no session tab ever names it.
  'brand-copilot': {
    paths: [
      'M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z',
    ],
    filled: true,
  },
  // Z.ai's sliced "Z" — the three shapes of the mark in chat.z.ai's own
  // logo.svg (its Simple Icons slug does not exist), redrawn the way the grok
  // entry above was: coordinates rescaled from the 30×30 source grid and then
  // normalized to fill the canvas, preserving the aspect, the way Simple
  // Icons normalizes its own entries. The vendor's top and bottom strokes are
  // cut by the diagonal's parallel edges — that slice IS the mark.
  'brand-zai': {
    paths: [
      'M12.6065 1.8065L10.929 4.1935C10.671 4.5677 10.2323 4.8 9.7677 4.8H0.6065V1.7935Z',
      'M24 1.8065L9.6 22.2065H0L14.4 1.8065Z',
      'M11.3935 22.2065L13.0839 19.8065C13.3419 19.4323 13.7806 19.2 14.2452 19.2H23.3935V22.2065Z',
    ],
    filled: true,
  },
  check: { paths: ['M20 6L9 17l-5-5'] },
  'chevron-down': { paths: ['M6 9l6 6 6-6'] },
  'chevron-right': { paths: ['M9 18l6-6-6-6'] },
  'chevron-up': { paths: ['M18 15l-6-6-6 6'] },
  // Feather's `circle` — the ellipse shape tool. Its <circle cx=12 cy=12 r=10>
  // is an arc pair, the same conversion `dot` and `search` already use. Stroked,
  // not filled: it is an outline shape, and the fill is the canvas's business.
  circle: { paths: ['M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20'] },
  close: { paths: ['M18 6L6 18', 'M6 6l12 12'] },
  // Feather's `code` — two <polyline>s as relative paths. The CODEX tab mark
  // (src/shared/agentBadge.ts). Symmetric chevrons pointing outward, which is
  // what tells it apart from `terminal` below at 12px: the mass sits at both
  // edges rather than on the left.
  code: { paths: ['M16 18l6-6-6-6', 'M8 6l-6 6 6 6'] },
  // A circle expressed as two semicircular arcs, so the template stays one
  // path loop. Painted, not stroked: this is a pip, not an outline.
  dot: { paths: ['M12 7a5 5 0 1 0 0 10a5 5 0 1 0 0-10'], filled: true },
  // Feather's `download` — the clone route. Not `git-branch`: what the user is
  // asking for is "bring this repo down onto the host", and the branch mark
  // reads as VCS topology rather than as an action.
  download: { paths: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'] },
  // Feather's `eye`. The env panel's value toggle (EnvPanelView.vue): a
  // fetched secret stays masked until this mark opens it, Windows password
  // field style. Its <circle cx=12 cy=12 r=3> is an arc pair, the same
  // conversion `search` and `settings` use; the lid path is verbatim.
  eye: {
    paths: [
      'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z',
      'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6',
    ],
  },
  // Feather's `eye-off` — the same toggle's pressed state: the value is on
  // screen and the button's offer is to put the mask back. The <line> is
  // written as one l path; the lid is verbatim, its inner <circle> already
  // an arc in Feather's own hand.
  'eye-off': {
    paths: [
      'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24',
      'M1 1l22 22',
    ],
  },
  // Feather's `edit-2` — the pen. The draw tool. Not `edit-3` (pen + underline,
  // which reads as "edit this field") and not `pen-tool` (bezier authoring).
  'edit-2': { paths: ['M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z'] },
  // Feather's `external-link`. The "look at it in a browser" mark, shared by
  // BOTH open buttons in the Ports panel's actions column (PortPanelView.vue):
  // the served folder's URL and a forwarded port's. One action, one mark —
  // served rows had `arrow-right` before this glyph existed, and the two open
  // buttons reading differently in one column was drift, not variety.
  // Feather's polyline `15 3 21 3 21 9` is written as one h/v path.
  'external-link': {
    paths: ['M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6', 'M15 3h6v6', 'M10 14L21 3'],
  },
  file: { paths: ['M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z', 'M13 2v7h7'] },
  folder: { paths: ['M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z'] },
  // Feather's `folder-plus` — the "new empty folder" route.
  'folder-plus': {
    paths: [
      'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
      'M12 11v6',
      'M9 14h6',
    ],
  },
  // Feather's `git-branch`, its two <circle>s expressed as arc pairs so the
  // template stays one path loop. Marks a row that IS a git repo.
  'git-branch': {
    paths: [
      'M6 3v12',
      'M18 3a3 3 0 1 0 0 6a3 3 0 1 0 0-6',
      'M6 15a3 3 0 1 0 0 6a3 3 0 1 0 0-6',
      'M18 9a9 9 0 0 1-9 9',
    ],
  },
  // Feather's `hexagon`, verbatim. The CLAUDE tab mark (src/shared/agentBadge.ts).
  // A closed angular outline: at 12px it is a silhouette rather than a figure,
  // which is exactly what makes it survive the size the other three are read at.
  hexagon: {
    paths: [
      'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z',
    ],
  },
  // Feather's `home` — "back to $HOME" in the project browser's breadcrumb.
  home: { paths: ['M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M9 22V12h6v10'] },
  // Feather's `image` — the picture being annotated, and the "add a picture"
  // source. Its rounded <rect> is the same frame `panel-left` and `square`
  // convert; its <circle> is an arc pair; its <polyline> a relative path.
  image: {
    paths: [
      'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
      'M8.5 7a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3',
      'M21 15l-5-5-11 11',
    ],
  },
  // Feather's `minus`, its <line x1=5 x2=19 y=12> as a path. Two jobs: the
  // straight-line tool, and the stroke-width affordance (a rule of ink).
  minus: { paths: ['M5 12h14'] },
  // Feather's `sidebar`, its <rect> expressed as a path so the template stays
  // a single path loop. This is VS Code's "toggle sidebar" mark.
  'panel-left': {
    paths: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M9 3v18'],
  },
  paperclip: {
    paths: [
      'M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48',
    ],
  },
  plus: { paths: ['M12 5v14', 'M5 12h14'] },
  // Feather's `rotate-cw` (one arc + one arrowhead), chosen over `refresh-cw`
  // (two arcs) for calm at 14px — and it spins cleanly while loading.
  refresh: { paths: ['M23 4v6h-6', 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10'] },
  // Feather's `rotate-ccw` — undo. Deliberately the exact mirror of `refresh`
  // above (which is Feather's `rotate-cw`, same arc, same arrowhead): the pair
  // has to be one family, or undo and reload read as unrelated marks.
  'rotate-ccw': { paths: ['M1 4v6h6', 'M3.51 15a9 9 0 1 0 2.13-9.36L1 10'] },
  // Feather's `search`, its <circle> as an arc pair. Filter fields only.
  search: { paths: ['M11 3a8 8 0 1 0 0 16a8 8 0 1 0 0-16', 'M21 21l-4.35-4.35'] },
  // Feather's `settings` — the gear, opening the app-level settings panel. Its
  // <circle cx=12 cy=12 r=3> is an arc pair, the same conversion `dot` and
  // `search` use; the outer path is verbatim. The gear rather than `sliders`:
  // sliders reads as "filter/adjust this view", and this control is not scoped
  // to the screen it sits on.
  settings: {
    paths: [
      'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6',
      'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z',
    ],
  },
  // Feather's `square` — the rectangle shape tool. Same rounded <rect> as
  // `panel-left`'s frame, converted the same way.
  square: {
    paths: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z'],
  },
  // "Default host" in the picker, in its two states. Outline vs solid is a
  // SHAPE difference, not a colour one, for the same reason `toggle-left` and
  // `toggle-right` exist as a pair: a two-state control has to be readable
  // without relying on the tint.
  star: { paths: [STAR_PATH] },
  'star-filled': { paths: [STAR_PATH], filled: true },
  symlink: { paths: ['M4 4v7a4 4 0 0 0 4 4h12', 'M15 10l5 5-5 5'] },
  // Feather's `terminal` — its <polyline> prompt and its <line> rule. The
  // OPENCODE tab mark (src/shared/agentBadge.ts). Deliberately asymmetric
  // against `code` above: one chevron on the left, one rule on the right.
  terminal: { paths: ['M4 17l6-6-6-6', 'M12 19h8'] },
  // Feather's `toggle-left` / `toggle-right`: the port panel's per-row on/off.
  // A real two-state mark, so "forwarded" and "silenced" differ in SHAPE and
  // not only in colour (the knob moves), which a checkbox tick cannot do.
  'toggle-left': {
    paths: ['M8 5h8a7 7 0 0 1 0 14H8a7 7 0 0 1 0-14z', 'M8 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6'],
  },
  'toggle-right': {
    paths: ['M8 5h8a7 7 0 0 1 0 14H8a7 7 0 0 1 0-14z', 'M16 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6'],
  },
  tool: {
    paths: [
      'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
    ],
  },
  // Feather's `trash-2` — clear the canvas. Its lid <polyline> (3 6, 5 6, 21 6,
  // three collinear points) is the single span they describe; its two <line>
  // ribs are paths. `trash-2` over `trash` because the ribs keep the mark from
  // collapsing into a solid blob at 14px.
  'trash-2': {
    paths: [
      'M3 6h18',
      'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
      'M10 11v6',
      'M14 11v6',
    ],
  },
  // Feather's `type` — the text annotation tool. A serif "T" with its slab and
  // its foot, which is the mark every drawing app uses for this and therefore
  // the one that needs no label to be understood. Its <polyline> (4 7, 4 4,
  // 20 4, 20 7) is one relative path and its two <line>s are the others.
  //
  // NOT a literal letter glyph: a character never
  // stands in for a graphic affordance, and "the affordance happens to be about
  // letters" is not an exemption — a `T` typed into the template would render
  // in the UI font at the button's font size and inherit none of the stroke
  // weight the rest of the toolbar shares.
  type: { paths: ['M4 7V4h16v3', 'M9 20h6', 'M12 4v16'] },
  // Feather's `zap`, its <polygon> closed with `z`. The GROK tab mark
  // (src/shared/agentBadge.ts). Stroked, not filled, so it stays in the same
  // outline register as the other three — a solid bolt beside three outlines
  // would read as a different KIND of badge rather than a different agent.
  zap: { paths: ['M13 2L3 14h9l-1 8 10-12h-9z'] },
};

const props = withDefaults(
  defineProps<{
    name: AppIconName;
    size?: 12 | 14 | 16;
    /** Decorative by default — the surrounding button carries the label. */
    title?: string;
  }>(),
  { size: 16, title: undefined },
);
</script>

<template>
  <svg
    class="app-icon"
    viewBox="0 0 24 24"
    :width="props.size"
    :height="props.size"
    :fill="GEOMETRY[props.name].filled ? 'currentColor' : 'none'"
    :stroke="GEOMETRY[props.name].filled ? 'none' : 'currentColor'"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    :aria-hidden="props.title ? undefined : 'true'"
    :role="props.title ? 'img' : undefined"
    focusable="false"
  >
    <title v-if="props.title">{{ props.title }}</title>
    <path v-for="(d, i) in GEOMETRY[props.name].paths" :key="i" :d="d" />
  </svg>
</template>

<style scoped>
/* display:block kills the baseline gap inline SVGs get; flex:none stops
   flex rows from squashing the icon when a label truncates. */
.app-icon {
  display: block;
  flex: none;
}
</style>
