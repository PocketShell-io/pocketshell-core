/**
 * The xterm side of "click a path in the terminal, land on it in the Files tab".
 *
 * Three jobs, in order:
 *   1. flatten a buffer line (with its wrapped continuation rows) back into a
 *      string, remembering which cell produced each character;
 *   2. run the pure detectors over that string (./terminalPaths.ts for paths
 *      and `file://` URLs, ./terminalUrls.ts for http(s) ones);
 *   3. hand xterm an ILink per match, whose `activate` asks the files store to
 *      reveal the path — or the browser to open the URL.
 *
 * Step 1 is the only part that is not obvious. xterm has no "give me the
 * logical line" call: a line longer than the window is stored as several rows,
 * each flagged `isWrapped`, and a link's range is expressed in CELLS. So the
 * flattening keeps a parallel array of cell positions — one entry per UTF-16
 * code unit of the string — and the match offsets are mapped back through it.
 * Walking the cells (rather than using `translateToString` and doing
 * arithmetic) is what keeps the mapping right when a row contains a double-width
 * character, which occupies two cells but one string index.
 *
 * ## Why `isWrapped` is not enough, in THIS pane
 *
 * `isWrapped` is set when xterm itself ran out of columns — the writer kept
 * printing past the right margin and the terminal moved to the next row. That
 * is not how anything writes to this pane. The pane is always a tmux client and
 * tmux redraws row by row (`tty_cursor(tty, 0, y)` before each one), and the
 * agent TUIs inside it are full-screen renderers that position every cell they
 * paint. Neither ever lets a line overflow, so a line the USER sees broken
 * across two rows arrives here as two rows with `isWrapped` false on both — and
 * a path that spans the break is never seen whole by the detector.
 *
 * The reports are the shapes the rules below reconstruct:
 *
 *   - the Codex TUI wrapped mid-token and continued at column 0 of the next
 *     row, i.e. exactly the hard wrap xterm would have flagged had it done the
 *     wrapping (rule 1);
 *   - the Codex TUI wrapped its own block and prefixed the continuation with
 *     its box-drawing gutter (`  │ `), which has to be dropped as well as
 *     joined (rule 2);
 *   - this app's own CLI wraps long tokens at the hyphens inside them instead
 *     of at the margin, so the row above the break ends a few columns SHORT of
 *     full — `…/event-webinar-` / `og.png` — and rule 1b reads the hyphen as
 *     the break opportunity it is;
 *   - a markdown-rendering CLI fills the row up to the last `/` inside the
 *     token instead of to the margin — `…vectorize-agent/` / `diagrams` —
 *     which is the same shape with the slash as the opportunity, so rule 1b
 *     takes both characters;
 *   - the same CLI also breaks tokens when the row is nowhere near the pane's
 *     margin — `…work-chronicle-` / `overview.png` sat a dozen columns short
 *     in a wider window — because tmux keeps rows painted at the width they
 *     were RENDERED at, and the window has since been resized. No fixed
 *     "how far short of the margin" bound survives that; rule 1b's fit
 *     arithmetic therefore runs against the render width inferred from the
 *     fullest nearby row ({@link inferWrapWidth}), never against the pane's
 *     live width.
 *   - Claude Code's transcript paints its rows up to a small inset inside
 *     the pane and cuts the token at that width wherever the width happens
 *     to land — `…-b30c-ed8` / `60a6cb317…`, a UUID severed mid-hex — so
 *     neither of the evidences above is present: the row is one or two
 *     columns short of full (no rule 1) and the cut is at no opportunity
 *     character (no rule 1b). Rule 1a reads the nearly-full row: within a
 *     bounded few columns of the margin is still "ran out of room", provided
 *     the continuation's first token could not have been placed in the
 *     columns left over, and the tail does not already end looking like a
 *     finished `name.ext` — which is what a COMPLETE path about to be
 *     followed by the next line's prose looks like.
 *   - the Codex transcript hang-indents the wrapped rows of its own blocks:
 *     the continuation began with ELEVEN spaces before the content that
 *     continued the row above's cut — `…list in image-` / `
 *     regeneration-workflow.md`. Every rule used to refuse any row whose
 *     first cell held a space, on the grounds that a space means the row
 *     above's token ended cleanly; but the spaces are the renderer's LAYOUT,
 *     and a token cannot contain a space, so the run is decoration and the
 *     content after it is what the guards must judge. Rules 1a and 1b now
 *     read past a bounded indent (rule 1 stays column-0 — an indent is the
 *     renderer choosing where a row begins, which is the opposite of the
 *     overflow rule 1 reconstructs).
 *   - the same family of TUIs wraps a command echo INSIDE a `KEY="…"`
 *     assignment at a block width far narrower than the pane:
 *     `PKG="/home/…/python3.12/` broke before `site-packages/linkedin_api`,
 *     the continuation carrying the block's gutter. Two stale assumptions
 *     refused it — the tail gate judged the raw token and hit the
 *     assignment's quote (FORBIDDEN in a path), and the gutter rule measured
 *     its fit against the pane's live width, where every head "had room".
 *     The gate now reads the tail past its leading decoration (the same peel
 *     the matcher applies — that is why row one was already underlined) and
 *     the gutter rule measures against the inferred render width, like every
 *     rule above it.
 *   - the Space Bunny transcript paints its message blocks with a left border
 *     bar (`▏ `, a left partial block) on EVERY row of the block, and the
 *     block's wrapper broke a long attachment path at an internal hyphen —
 *     `▏ …/20260929-162110-01-` / `▏ Webpage_3.pdf`, the row full to the
 *     block's own edge. The bar was no gutter the rules knew, so rule 1b
 *     joined the rows with the bar still in the stream: the flattened token
 *     was `…01-▏`, the link opened a path that exists nowhere, and the
 *     filename fragment stayed bare. The gutter now reads the bar family
 *     ({@link GUTTER}) and drops it on the join, and rule 2 takes the hyphen
 *     tail it previously refused.
 *   - the queued-follow-ups transcript renders its paragraph as markdown, and
 *     its three `[label](</data/…png>)` links were dead twice over: the angle
 *     brackets are FORBIDDEN in a path, so the detector refused every
 *     destination outright, and the gate refused the rows whose tail wore the
 *     link's own `](<` / `(<` syntax, so the paragraph tore at every link and
 *     the targets that reached past a break never came whole — the links that
 *     survived pointed at torn-off RELATIVE fragments resolving nowhere. The
 *     gate reads past the `(<` to the address-so-far, and terminalPaths reads
 *     the angle-bracket destination — after its label, or alone where the
 *     wrapper split the label from its destination.
 *   - the inspector transcript borders every row of a message block with a
 *     `│` at column 0 and pads the text three columns past it, and its
 *     wrapper cut a long localhost address after the query's `?` — `│
 *     …/inspect.html?` / `│ projectUrl=…`. Twice refused: rule 2 took only
 *     `/` and `-` tails, and the gutter read only `│ ` — one padding column —
 *     so even a `?`-admitting tail would have left two padding cells in the
 *     stream to tear the token apart. The gutter absorbs the border's padding
 *     run ({@link GUTTER}) and rule 2 takes the `?` tail rule 1b takes.
 *   - a transcript cut a relative address right after its `../` anchor —
 *     `…procedure is ../` / `dataops-knowledge/…` — and the tail gate refused
 *     an anchor that names nothing on its own row. The address's own head then
 *     joined WITHOUT the anchor: a link to `dataops-knowledge/…`, one
 *     directory short of where the address points, with the `../` orphaned
 *     plain at the cut. continuesPath reads a pure `../` run as the
 *     path-so-far it is; the matcher's refusal (no link opens `../` alone)
 *     stays.
 *   - a transcript paragraph wrapped its commit addresses at its own narrow
 *     width — `…/dapier/commit/` / `bcbfcf5a…40-hex` — while the prose around
 *     it ran full to the pane. The fit guards of rules 1b and 2 measure
 *     against the block's widest row, the prose had dragged that to the
 *     pane's, and the 40-hex head "had room": the join refused, the first row
 *     fell back to WebLinksAddon's truncated-fragment link (the report's
 *     404ing underline) and the hash sat dead. A long hex head under a web
 *     tail is the address's own rest — {@link HEX_FRAGMENT} — and the guard
 *     stands down for that shape alone ({@link joinedRowSkip}).
 *   - an SOP portal's markdown list printed its addresses plain, and the
 *     renderer cut them mid-word a few columns short of the pane —
 *     `…/sops/get-t` / `he-openai-invoice-and-receipt-from-chatgpt`. Rule
 *     1a's head test knew a `/`-rest and a hex hash but not a slug's rest —
 *     hyphens only, no slash anywhere — so three of the list's four
 *     addresses stayed two plain fragments each, the underline stopping at
 *     the cut. A hyphenated fragment of three or more groups is no prose
 *     word either ({@link SLUG_FRAGMENT}), and the head test admits it
 *     beside the hex.
 *   - the same transcript's tool blocks open every row with an elbow marker
 *     (`⎿ `), and a long command echo ran INTO its block: the bullet row
 *     wrapped after `/home/alexey/tmp/` and the command's own tail landed
 *     on the block's first row, elbow and all. The elbow was no gutter the
 *     rules knew and no space the hanging indent reads past — the head read
 *     `⎿` and the fit guard refused — so the lock path stayed two fragments,
 *     the first opening a directory, the second linkifying alone as a
 *     relative path resolving nowhere. The elbow joins the gutter family
 *     ({@link GUTTER}), and the command echo comes whole.
 *   - the Codex transcript's attachment list underlines its file paths and
 *     then paints each row's remaining fill with the attribute still active —
 *     `- ~/.pocketshell/attachments/…/…-01-` / `video1884788668.mp4`, BOTH
 *     rows underlined through empty space to the pane's edge — so the view at
 *     rest presented a link far wider than the fragments claimed, and most of
 *     what read as the link answered no click. A fragment now claims the
 *     trailing cells the CLI itself underlined ({@link linksPerRow}): what is
 *     presented underlined is what opens, and the padding of every CLI that
 *     underlines only its text stays bare as before.
 *
 * Both rules are deliberately narrow, for the reason terminalPaths.ts's header
 * gives: joining two rows that were never one line can only invent a path that
 * does not exist, and an underline stretched across a boundary is the most
 * visible way this feature can look broken. Each condition is spelled out at
 * the rule.
 *
 * ## Web links
 *
 * Everything above reads paths; the same flattening also rejoins the http(s)
 * URLs a remote CLI's wrapper breaks across rows — the shape the comet.com
 * reports arrived in: an address cut after `/`, after a hyphen inside a UUID,
 * after its `?`, or mid-hex at a row full to the margin — and the shape the
 * eleventh report arrived in: GitHub commit URLs cut right BEFORE a segment
 * (`https://github.com` / `/AI-Shipping-Labs/…`) and mid-segment or mid-hash
 * at the transcript's inset rows — and the twelfth's: a hyphenated slug
 * severed mid-word at that same inset width (`…/sops/get-t` / `he-openai-…`).
 * WebLinksAddon cannot see past the break (it
 * reads one row at a time), so the reconstructed line is scanned by
 * terminalUrls.ts and the address's links — one per row it spans, see
 * {@link linksPerRow} — are registered BEFORE the addon, whose priority rule
 * lets them claim every row of the URL — including the first, whose truncated
 * fragment is exactly what the addon used to underline instead. The rules'
 * URL-specific evidence lives at {@link joinedRowSkip}: `?` in rule 1b's
 * break opportunities, the finished-address trace reading the PATH's
 * extension — an authority's `.com` is no filename ({@link webPathOf}) — and
 * rule 1a's head test admitting only the URL's own continuation. A URL on one
 * row is the addon's and stays the addon's — except the bare addresses
 * (terminalUrls.ts's schemeless family: `127.0.0.1:8300`,
 * `datatalks.club/blog/x.html`): the addon's regex is anchored
 * on `https?://`, so on a single row nobody but this provider can claim them,
 * while the at-rest highlighter keeps its nothing-to-repair rule for every
 * single-row address, bare or not.
 *
 * ## Appearance
 *
 * A path link is decorated exactly like the http links this terminal already
 * has: pointer cursor and an underline, both on hover only — the decoration
 * vocabulary xterm's link provider API offers. The underline inherits the
 * cell's own foreground, so a path printed green underlines green and the
 * terminal keeps saying what the program said.
 *
 * Both detectors hand xterm ONE LINK PER ROW a match touches, never one link
 * spanning rows ({@link linksPerRow} for why). The practical difference is the
 * underline: on hover, every row of a wrapped path underlines exactly its own
 * fragment of it — the row's plain leftover columns after the cut, and the
 * continuation row's leading indent, stay bare — except where the remote CLI
 * itself underlined the fill past the cut ({@link linksPerRow}): there the
 * fragment claims the underlined stretch, because the user is already reading
 * it as part of the link and a click on it must not fall dead.
 *
 * Hover is not the layer the user judges by, though. The remote CLI colours
 * and underlines its file references itself, and when ITS wrapper breaks a
 * path across rows the underline covers only the first row's fragment — so
 * at rest a path read as highlighted halfway no matter how well the join
 * worked. Persistent highlighting therefore exists as its own layer:
 * terminalPathHighlights.ts blocks the whole joined path in the theme's
 * selection tint, re-derived from the buffer for every row the renderer
 * touches — the rescan is what answers the marker-staleness objection that
 * once kept this hover-only. The tint is the theme's own selection colour
 * solidified over the terminal ground (themes.ts terminalLinkTint): no new
 * palette values, per 
 *
 * ## Clicking while the remote app owns the mouse
 *
 * This pane is ALWAYS a tmux client, and the agent TUIs it runs turn mouse
 * reporting on, so "does a link still fire when the remote program is grabbing
 * clicks?" decides whether any of this works in practice rather than only in a
 * bare shell. It does fire, and the reason is that the two mechanisms are bound
 * to different elements (xterm 6.0.0, verified against its sources):
 *
 *   - mouse REPORTING binds to `.xterm` — `CoreBrowserTerminal.bindMouse()`
 *     opens with `const el = this.element`;
 *   - the LINKIFIER binds to `.xterm-screen`, a child of it —
 *     `createInstance(Linkifier, this.screenElement)`.
 *
 * A click lands inside the screen, so the linkifier's own mousedown/mouseup run
 * first on the way up, and `Linkifier._handleMouseUp` calls `link.activate`
 * with no consultation of `areMouseEventsActive` anywhere along that path. The
 * outer handler's `cancel(ev)` calls `stopPropagation`, which only stops the
 * event travelling FURTHER up — it cannot un-run a listener on a descendant.
 * The decorations survive too: `.xterm.enable-mouse-events { cursor: default }`
 * is overridden by the later and equally specific `.xterm .xterm-cursor-pointer`
 * in xterm's own stylesheet.
 *
 * What the user ALSO used to get was the same click delivered to the remote
 * program, so tmux could move its cursor or select the pane under the pointer
 * on the way. That side effect is gone for plain clicks:
 * terminalMouseSelection.ts replaces `SelectionService.shouldForceSelection`,
 * the predicate `bindMouse`'s mousedown handler consults before `sendEvent`,
 * so a plain button-1 press is never reported and follows the link cleanly.
 * SHIFT is the deliberate hand-off: a Shift-click is reported to tmux and
 * still follows the link, because the linkifier's listener on the descendant
 * runs regardless.
 */
import type { IBuffer, IBufferCell, ILink, ILinkProvider, Terminal } from '@xterm/xterm';
import {
  continuesPath,
  findPaths,
  HAS_EXTENSION,
  leadingDecorationWidth,
  stripFileScheme,
} from './terminalPaths';
import { findUrls } from './terminalUrls';
import { useFilesStore } from './stores/files';
import { useSessionsStore } from './stores/sessions';

/**
 * What a click needs to know, read fresh on every call.
 *
 * A getter rather than a value because both facts move: the pane re-points at
 * another session without being re-created (see TerminalView's `showTarget`),
 * and the sessions store is refreshed lazily, so at mount time it may not yet
 * know the session's working directory at all.
 */
export interface TerminalPathContext {
  /** tmux session the pane is showing, or '' for a bare shell. */
  sessionName: string;
}

/**
 * Cap on how many rows one flattening may join. A pathological wrapped line
 * (a 9000-row scrollback of one string) must not turn a mouse-move into a
 * full-buffer walk; the same 2048-character budget WebLinkProvider uses.
 */
const MAX_SCAN_CHARS = 2048;

/**
 * Cap on rows joined by RECONSTRUCTION ({@link joinedRowSkip}), in each
 * direction. xterm's own `isWrapped` chain is left uncapped because it is a
 * fact the terminal recorded; a reconstruction is a guess, and a guess that
 * chained down a screenful of gutter-prefixed rows would spend a whole buffer
 * walk on a hover. Eight is headroom above the longest joined run the repair
 * reports needed (see WRAP_SHORTFALL's derivation below); the rule's own
 * guards, not this cap, are what keep normal prose from gluing together.
 */
const MAX_JOIN_ROWS = 8;

/**
 * How many columns short of the margin a row may sit and still read as "ran
 * out of room" for RULE 1a below.
 *
 * Full to the very last column (rule 1) is the strongest geometric evidence
 * there is; nearly full is the next strongest, and nearly has to mean a
 * bounded few. The renderers that wrap short of the margin reserve a small
 * fixed inset — the Claude Code transcript the rule was written from
 * measured at one to two columns (a 91-character row in a 92- or 93-cell
 * pane) — so four covers the family without letting an ordinary word-wrap
 * line, which can end anywhere, qualify. What bounds the risk the extra
 * columns admit is the rule's own guards, not this number.
 */
const WRAP_SHORTFALL = 4;

/**
 * The gutter a TUI puts in front of the continuation rows of a block it wrapped
 * itself — `  │ ` in the Codex output the user reported, and the left border
 * bar of the Space Bunny transcript's message blocks: every row of a block
 * opens with `▏ ` (or a fuller member of the left partial blocks, with a cell
 * or two of padding before the text column), and the block's own wrapper broke
 * a long attachment path at an internal hyphen, so the continuation row was
 * `▏ Webpage_3.pdf`.
 *
 * Box-drawing, the transcript elbow (`⎿`, the marker its tool blocks open
 * every row with) and the left partial blocks only, with the trailing spaces
 * the TUIs actually emit — up to four for either. The bars' border sits left
 * of the text it decorates, and the inspector transcript's block border pads
 * its text three columns past the `│`; the padding is the renderer's LAYOUT,
 * not token content, and what the guards must judge is the content after it.
 * ASCII `|` is deliberately NOT here: `| ` starts a markdown table row and
 * appears in the middle of shell pipelines, and admitting it would let this
 * rule glue together two rows of a table. A bar RUN never matches either —
 * the class must be followed by a space, so `▌▌▌▌ 40%` stops being a gutter
 * at its own second bar, and a tree drawing's `└──` keeps its second dash
 * where a space would have to be.
 */
const GUTTER = /^ {0,8}(?:[│┃⎿] {1,4}|[▏▎▍▌▋▊▉] {1,4})/;

/**
 * The hanging indent a transcript renderer puts in front of the wrapped rows of
 * its own block — `           regeneration-workflow.md` in the Codex output the
 * seventh report was read from: the continuation row began with ELEVEN spaces,
 * the block's indent plus the wrap column, before the content that continues
 * the row above's `…list in image-`.
 *
 * The run is decoration, not a token boundary: a token cannot contain a space,
 * so spaces at the head of a continuation are always the renderer's indent, and
 * the content after them is what may or may not continue the tail. Capped at
 * {@link INDENT_LIMIT} columns — past that sits deep code-block territory where
 * a join has no business guessing.
 */
const HANGING_INDENT = /^ +/;

/** How much leading indentation a continuation row may carry and still join. */
const INDENT_LIMIT = 16;

/**
 * The PATH part of a web-URL tail, for the finished-address check the rules
 * share with {@link HAS_EXTENSION}.
 *
 * `HAS_EXTENSION` reads `name.ext` at a token's end, and a URL's authority
 * sits there whenever the cut fell right after it — but `github.com` is no
 * more a filename than `com` in prose is, and the eleventh report's
 * `https://github.com` cut right before `/AI-Shipping-Labs/…` must not be
 * refused by its own TLD. The extension that says "this address is whole"
 * lives on the path's last segment (`…/a/b.png`), so the check runs on
 * everything from the authority's first slash: empty for a bare authority,
 * `/a/b.png` for the ninth report's finished address.
 */
function webPathOf(tail: string): string {
  const afterScheme = tail.slice(tail.indexOf('://') + 3);
  const slash = afterScheme.indexOf('/');
  return slash === -1 ? '' : afterScheme.slice(slash);
}

/**
 * A run of hex too long to be a word — what a URL cut mid-hash hands the next
 * row (`6912cd7dd03802`, the eleventh report's GitHub commit hash). Eight is
 * the floor because the English words that are pure hex — `added`, `decade`,
 * `facade` — all live below it, and a line of prose can begin with one.
 */
const HEX_FRAGMENT = /^[0-9a-f]{8,}$/i;

/**
 * A hyphenated slug fragment — what a URL's path segment cut mid-word hands
 * the next row (`he-openai-invoice-and-receipt-from-chatgpt`, the twelfth
 * report's SOP links). Three hyphen-separated groups is the floor because two
 * is still prose (`well-known`, `e-mail`), and the letter the groups must
 * contain somewhere keeps a date (`2027-04-03`, the same shape in digits)
 * out. What the bar admits that is not URL material is the triple-hyphenated
 * compound (`mother-in-law`) — the same accepted trade {@link HEX_FRAGMENT}
 * makes with `added`, at a rarity one notch deeper.
 */
const SLUG_FRAGMENT = /^(?=[a-z0-9-]*[a-z])[a-z0-9]+(?:-[a-z0-9]+){2,}$/i;

/** One flattened logical line, plus the cell each character came from. */
export interface ScannedLine {
  text: string;
  /**
   * `cells[i]` is the 0-based buffer cell that produced `text[i]`; `u` is
   * whether that cell carries the underline attribute — the trace of a remote
   * CLI that underlined not just its path but the fill cells after it (the
   * thirteenth report's Codex transcript underlines attachment paths and then
   * paints the row's remaining columns with the attribute still active, so the
   * at-rest underline runs through empty space to the pane's edge). {@link
   * linksPerRow} lets a link claim exactly that much of the row: what the CLI
   * itself presents underlined is what the user reads as the link, and a dead
   * zone inside an underlined run reads as a broken click.
   */
  cells: { x: number; y: number; u: boolean }[];
  /**
   * For a row whose trailing fill was DROPPED by a join ({@link scanBufferLine}
   * pops the spaces so the glued token stays one token), the last column of
   * that dropped fill carrying the underline attribute — the same evidence
   * `cells[i].u` carries for rows whose fill was kept. Absent when the row's
   * fill had no underline, or was never dropped.
   */
  underlineTails: Map<number, number>;
}

/** A row read for the join rules: its text and where its content actually ends. */
interface RowRead {
  /** The whole row, untouched cells read as spaces. Never trimmed. */
  text: string;
  /** Column of the last cell holding anything but a space, or -1 for a blank row. */
  lastCol: number;
  /** Cells in the row — which, in xterm, is the terminal's column count. */
  width: number;
}

/**
 * Read one row for the join rules only.
 *
 * Separate from the flattening loop because the rules need to look at a row
 * BEFORE deciding whether to consume it, and because they need a COLUMN
 * (`lastCol`) rather than a string offset — the two part company the moment the
 * row holds a double-width character, which is the same reason the flattening
 * walks cells instead of using `translateToString`.
 */
function readRow(buf: IBuffer, y: number, scratch: IBufferCell): RowRead | null {
  const line = buf.getLine(y);
  if (!line) return null;
  const parts: string[] = [];
  let lastCol = -1;
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x, scratch);
    if (!cell || cell.getWidth() === 0) continue;
    const content = cell.getChars();
    if (content === '' || content === ' ') {
      parts.push(' ');
      continue;
    }
    parts.push(content);
    lastCol = x;
  }
  return { text: parts.join(''), lastCol, width: line.length };
}

/**
 * The render width the rows around a hover were painted at.
 *
 * THE PANE'S CURRENT WIDTH IS NOT EVIDENCE. This pane is a tmux client and
 * tmux keeps history rows painted at the width they were rendered at: the
 * window can be resized — or a CLI can wrap at its own narrower width — after
 * the fact, so a row can sit ANY distance short of the live margin. What
 * survives both is the rows themselves: the fullest row of the hovered row's
 * own block is the best surviving measurement of the width its neighbours
 * were wrapped at. Rule 1b's fit guard below runs against this, never
 * against `prev.width`.
 *
 * "Block" is the contiguous run of non-blank rows around the hover, and the
 * walk stops at the first blank row in each direction: blocks separated by a
 * blank were wrapped independently, and rows beyond it say nothing about this
 * one's width. That bound is what keeps the estimate honest in exactly the
 * pane this was rebuilt for — the agent CLI's footer draws `Worked for 23m
 * 29s ────────` to the PANE's own width a row or two below the text, and one
 * such row collected into a whole-window maximum would drag the inferred
 * width back up to the pane, reverting every guard to the live-width
 * arithmetic this exists to escape. A row of one repeated character (a bare
 * `────` rule or `====` bar) is refused as decoration as well, and ends the
 * walk the way a blank does: what lies beyond it is a different block anyway.
 *
 * The window is capped at {@link MAX_JOIN_ROWS} rows per direction — the same
 * rows the reconstruction walk may consume. Rows cannot exceed the pane, so
 * the result is a sane width even when the block is all short lines: there
 * the estimate degrades to the hovered block's own widest row, and the fit
 * guard degenerates to the lexical tail/head checks alone — the deliberate
 * fallback, not a bug.
 */
function inferWrapWidth(buf: IBuffer, y0: number, scratch: IBufferCell): number {
  let width = 1;
  const collect = (row: RowRead): boolean => {
    if (row.lastCol < 0) return false;
    const trimmed = row.text.trim();
    if (trimmed.length >= 4 && /^(.)\1+$/.exec(trimmed) !== null) return false;
    if (row.lastCol + 1 > width) width = row.lastCol + 1;
    return true;
  };
  for (let y = y0, steps = 0; y >= 0 && steps <= MAX_JOIN_ROWS; y--, steps++) {
    const row = readRow(buf, y, scratch);
    if (row === null || !collect(row)) break;
  }
  for (let y = y0 + 1, steps = 0; steps <= MAX_JOIN_ROWS; y++, steps++) {
    const row = readRow(buf, y, scratch);
    if (row === null || !collect(row)) break;
  }
  return width;
}

/**
 * Does [next] continue [prev], even though xterm did not flag it wrapped?
 *
 * [wrapWidth] is the inferred render width ({@link inferWrapWidth}) — the
 * width rule 1b's fit arithmetic is measured against, never the pane's live
 * width. Rule 1a is the deliberate exception: its near-full claim is about
 * the live margin, so its fit arithmetic runs against the row's own leftover
 * columns.
 *
 * @returns how many leading CELLS of [next] to drop before joining (0 for a
 *   plain wrap, the gutter's width for a gutter-marked one, the hanging
 *   indent's width for an indented one), or null for "these are two different
 *   lines" — which is the answer this function is built to give, and gives for
 *   everything it is not certain about.
 */
function joinedRowSkip(prev: RowRead, next: RowRead, wrapWidth: number): number | null {
  if (prev.lastCol < 0) return null;
  const tail = /\S+$/.exec(prev.text.trimEnd())?.[0] ?? '';
  // A tail carrying a WEB scheme is not the refusal it used to be. It once
  // read "an http(s) URL belongs to WebLinksAddon and is never extended
  // across a row break" — which is precisely why a URL the remote CLI's own
  // wrapper broke across rows never came back whole: the addon reads one row
  // at a time, the join rules refused to hand it more, and every wrapped
  // address stayed a first-row fragment pointing at a truncated link. Now
  // the tail defers to the same geometric rules a path answers to, with
  // URL-specific evidence added at the rules that need it: the question mark
  // joins rule 1b's break opportunities (it is a URL's query separator, and
  // no PATH can carry one — terminalPaths forbids `?` outright — so a
  // `?`-cut token can only ever be claimed by the URL detector), and rule 1
  // demands the URL read CUT before it will glue a row on ({@link HAS_EXTENSION}.
  // A `file://` URL is the opposite case — the detector strips its scheme
  // and claims it as a path — and joins under the path rules alone, exactly
  // as it always has. Any other scheme (`ssh://`, `redis://`) may now join
  // under the same geometry but produces no link: terminalUrls.ts matches
  // http(s) only, so the glue is inert until a detector claims it.
  const asPath = stripFileScheme(tail);
  const webSchemeTail = tail.includes('://') && asPath === null;
  // The shape guard is the detector's own standard, not a stricter local one:
  // it used to demand a ROOTED tail, and every relative path failed it — the
  // rows of `assets/images/exam/` + `quizgen-landing-page.png` stayed two
  // lines, the row above kept a link to the truncated directory, and the
  // filename fragment got nothing. One carve-out beside that: a tail ending
  // in `-`. A trailing hyphen is cut evidence in its own right — it is the
  // break-opportunity character the wrapper stopped on, and the one case
  // where the tail need not be a path SO FAR because the joined token is
  // what becomes one (`image-` + `regeneration-workflow.md`, the seventh
  // report's first-segment cut). The per-rule guards below still decide; the
  // slash keeps its stricter treatment, because `and/` is `and/or` prose and
  // not a break anyone's wrapper made.
  //
  // The tail is read past its leading decoration ({@link leadingDecorationWidth}),
  // because a command echo's tail is often a path wearing an assignment —
  // `PKG="/home/…/python3.12/` — and the matcher already underlines that
  // path-so-far on its own row. Judged on the raw token, the quote the
  // assignment carries is FORBIDDEN in a path and the gate refuses, so the
  // gutter continuation the CLI wrapped it into never glued on and the
  // underline stopped at `python3.12/` — the tenth report, verbatim.
  //
  // A markdown destination cut mid-address reads the same way, and where the
  // assignment's peel is decoration in FRONT, the link's is syntax at the
  // tail's own head: `list](</data/agents/…` — or, the label's `]` left on
  // the row above, `(</data/agents/…`, which the decoration peel already
  // strips. Judged raw, the angle brackets are FORBIDDEN in a path and the
  // gate refused, so the paragraph tore at every link and each destination
  // stayed torn across the rows it spans. Read past the `(<` to the address
  // so far, the tail is a path-so-far like any other, and the per-rule guards
  // below still decide on the raw tail's own break evidence — these wrappers
  // cut at `/` and `-` like every other in this file.
  const mdTail = /\]?\(<([^<>()]*)$/.exec(tail);
  const tailPath = mdTail !== null ? (mdTail[1] ?? '') : tail.slice(leadingDecorationWidth(tail));
  if (
    !webSchemeTail &&
    !tail.endsWith('-') &&
    !continuesPath(tailPath)
  ) {
    return null;
  }

  const gutter = GUTTER.exec(next.text);
  if (gutter === null) {
    // The hanging indent ({@link HANGING_INDENT}): leading spaces are the
    // renderer's decoration and the CONTENT starts after them. Past the cap,
    // or with nothing but spaces on the row, none of the rules below may
    // speak — `content` starts past the indent, and an all-indent row is a
    // blank one.
    const indentMatch = HANGING_INDENT.exec(next.text);
    const indent = indentMatch !== null && indentMatch[0].length <= INDENT_LIMIT
      ? indentMatch[0].length
      : 0;
    const overIndented = indentMatch !== null && indentMatch[0].length > INDENT_LIMIT;
    const content = next.text.slice(indent);
    const first = content.charAt(0);
    if (first === '' || first === ' ' || overIndented) return null;
    const head = /^\S+/.exec(content)?.[0] ?? '';

    // RULE 1c — opencode's hanging-list wrap inside a hostname.
    //
    // opencode renders a markdown list with a hanging indent, then cuts a
    // long URL at the pane margin. In the report that motivated this rule,
    // `https://github.` filled the first row and `    com/AI-Shipping-Labs/…`
    // began the next one. The ordinary full-row rule deliberately refuses an
    // indented continuation because indentation normally means layout, not
    // overflow; the unfinished authority (`github.`) and a path-bearing head
    // are the extra evidence that this is the URL's own cut instead.
    //
    // The path-bearing guard keeps a finished URL followed by an indented
    // sentence from being glued to that sentence. Breaks after `/`, `-`, or
    // `?` already have their own rules below and do not need this exception.
    const authority = webSchemeTail
      ? tail.slice(tail.indexOf('://') + 3).split('/')[0] ?? ''
      : '';
    if (
      webSchemeTail &&
      indent > 0 &&
      prev.lastCol === prev.width - 1 &&
      authority.endsWith('.') &&
      head.includes('/') &&
      !head.startsWith('/')
    ) {
      return indent;
    }

    // RULE 1 — the hard wrap tmux repainted away.
    //
    // The evidence is geometric and it is the strongest available: the row
    // above is full to its very last column, so whoever wrote it had no room
    // left, and the row below starts at column 0 with a non-blank. That is the
    // exact situation in which xterm would have set `isWrapped` had the bytes
    // reached it as one overlong line instead of as two positioned rows.
    //
    // A continuation carrying a hanging indent never gets here even when the
    // row above is full: an indent means the renderer CHOSE where this row
    // begins, which is layout, not an overflow — the content-guarded rules
    // below decide those.
    //
    // Not caught, deliberately: a row whose last column was left blank because
    // a double-width character would not fit in it. Reconstructing that needs a
    // second guess on top of this one, and the cost of being wrong is an
    // underline running through unrelated text.
    if (indent === 0 && prev.lastCol === prev.width - 1) {
      // A web URL must read CUT before the strongest geometry in the file
      // glues the next row onto it, because a URL — unlike a path — has no
      // continuesPath-grade content gate standing in front of this rule:
      // `https://…` is as anchored as a token gets whether or not it
      // continues. So the finished-token trace does the refusing: a tail
      // whose PATH ends extension-shaped (`…/a/b.png`) is a whole address
      // one space-wrap happened to land exactly on the margin — the ninth
      // report's `saved https://example.com/a/b.png` + `and cleaned up` —
      // and the extension reads the path part ({@link webPathOf}), because
      // the authority's `.com` is no extension. A head starting with `/`
      // refuses nothing here: a FULL row that ends at a token boundary is
      // cut evidence in itself — a word-wrap leaves the row short of the
      // margin, so two whole addresses can only land end-to-margin by
      // coincidence — while a cut right before a segment is the ordinary
      // shape of a long address, and is what the eleventh report's pane
      // carries (`https://github.com` / `/AI-Shipping-Labs/…`). The cut the
      // earlier reports carry has no extension either: `…8b64-ab0e95b` ends
      // mid-hex, and the row below starts with `7d5c6`.
      if (webSchemeTail && HAS_EXTENSION.test(webPathOf(tail))) return null;
      return indent;
    }

    // RULE 1a — the hard wrap that stopped a few columns SHORT of the margin.
    //
    // The Claude Code transcript of the sixth report paints its rows up to a
    // small inset inside the pane and cuts the token where that inset lands —
    // `…-b30c-ed8` / `60a6cb317…`, a UUID severed mid-hex. So rule 1's
    // evidence is missing by a cell or two, and rule 1b's is missing because
    // this wrapper wraps at its width, not at opportunity characters. A row
    // ending within {@link WRAP_SHORTFALL} columns of the margin is still a
    // row that ran out of room, and the continuation's content — at column 0
    // or after its hanging indent — still reconstructs it, under guards that
    // name the difference between a cut token and a finished line:
    //
    //   - the continuation's first token could not have been placed in the
    //     columns left over (`head.length > left`). The wrapper's own
    //     arithmetic, run backwards: had the break fallen BETWEEN tokens, the
    //     head would have been put on the row above when it fit. `…result.png`
    //     three columns short plus `and cleaned the cache` refuses here, and
    //     the head check is what refuses it — `and` had room.
    //   - the continuation starts with what a cut leaves. For a path the head
    //     must NOT start with `/` — `…` plus `/x` is two paths, and the
    //     second one is whole already. A web tail is the opposite shape: the
    //     eleventh report's transcript cut its commit addresses right before
    //     a segment (`https://github.com` / `/AI-Shipping-Labs/…`) and
    //     mid-segment at its inset rows, so the head must be the URL's OWN
    //     rest — a new segment, a fragment with more segments behind it, a
    //     run of hex ({@link HEX_FRAGMENT}), or a hyphenated slug fragment
    //     ({@link SLUG_FRAGMENT}, the twelfth report's mid-word cut) — and
    //     never the bare word a
    //     space-wrap moves down after a complete, not-quite-full address
    //     (`docs: https://x.io/guide` two columns short, `available online`
    //     below: `available` is prose, and the head test is what refuses it,
    //     since a URL tail has no continuesPath to disprove it — the scheme
    //     is already anchored).
    //   - the tail does not already end extension-shaped ({@link
    //     HAS_EXTENSION}). `…name.ext` is what a COMPLETE path looks like; a
    //     cut leaves a fragment. For a web tail the extension reads the
    //     URL's path ({@link webPathOf}) — the authority's `.com` is no
    //     filename. This is the guard that refuses the misjoin whose head is
    //     too long for the fit check to catch (`result.png` + `already`), at
    //     the cost of a true cut that happens to leave a dotted fragment
    //     (`…url.t` + `xt`) — the same trade rule 1b's opportunity
    //     characters make.
    const left = prev.width - 1 - prev.lastCol;
    const continuesUrl =
      head.startsWith('/') ||
      head.includes('/') ||
      HEX_FRAGMENT.test(head) ||
      SLUG_FRAGMENT.test(head);
    if (
      head !== '' &&
      left <= WRAP_SHORTFALL &&
      head.length > left &&
      !(webSchemeTail ? HAS_EXTENSION.test(webPathOf(tail)) : HAS_EXTENSION.test(tail)) &&
      (webSchemeTail ? continuesUrl : !head.startsWith('/'))
    ) {
      return indent;
    }

    // RULE 1b — the break a wrapper puts INSIDE the token, at an opportunity
    // the token itself offers, rather than at the margin: hyphens (this app's
    // own CLI), slashes (the markdown-rendering CLI of the "Cloudflare
    // diagrams" report) and question marks (the query separator a URL-
    // wrapping CLI breaks after — `…/compare?` / `experiments=%5B…`) are the
    // characters terminal wrappers are seen to break at. The opportunity
    // character stays at the tail's end, and that is the one trace of a cut —
    // rather than finished — token a row carries. (`?` needs no URL test of
    // its own: a path cannot hold one, so the glued token is web material or
    // nothing, and the detectors below decide which.) Four guards, each the
    // reason a different way of being wrong stays shut:
    //
    //   - the tail ends with `-`, `/` or `?`. That is the break opportunity
    //     the wrapper used, and the one trace of a cut — rather than
    //     finished — token a row's end carries that survives being far short
    //     of the margin: a whole path or URL landing anywhere (`…/result.png`
    //     + `and cleaned up`) ends in something else and never gets here.
    //   - the continuation does not start with `/`. `…-`, `…/` or `…?` plus
    //     `/x` is not a path anyone wrote; it is two paths, and the second
    //     one is whole already.
    //   - the continuation's first token WOULD NOT HAVE FIT at the render
    //     width ({@link inferWrapWidth}). That is the wrapper's own arithmetic
    //     run backwards: if the token fit, the wrapper would have put it
    //     there, so the row below is a new line. Where the neighbourhood gives
    //     no wider row, the estimate falls back to the block itself and this
    //     guard stops constraining — the tail and head checks then carry the
    //     rule alone, which is the price of surviving resizes.
    //
    //     One carve-out, the transcript report: an opportunity wrapper fills
    //     its rows to its own NARROW width while the paragraph around it runs
    //     full to the pane's — so the inferred width is the pane's and every
    //     head "had room". A head that is a long hex run ({@link HEX_FRAGMENT})
    //     under a WEB tail is the address's own rest regardless — a commit
    //     hash severed at the `commit/` before it, the shape the report's
    //     `…/commit/` / `bcbfcf5a…` rows carry. No prose word is eight hex
    //     chars, so the shape carries the cut evidence the fit guard exists to
    //     cross-check; the width arithmetic, poisoned by the wide neighbours,
    //     stands down for it alone. Prose heads (`and cleaned up`) still
    //     answer to the guard.
    if (!tail.endsWith('-') && !tail.endsWith('/') && !tail.endsWith('?')) return null;
    if (head === '' || head.startsWith('/')) return null;
    if (prev.lastCol + 1 + head.length <= wrapWidth && !(webSchemeTail && HEX_FRAGMENT.test(head)))
      return null;
    return indent;
  }

  // RULE 2 — the TUI wrapped its own block and marked the continuation.
  //
  // Three conditions, each guarding a different way of being wrong:
  //
  //   - the tail ends with `/`, `-` or `?`. A TUI that wraps its own text
  //     breaks either at a boundary it chose — `…/` is the break point that
  //     leaves a path visibly unfinished — or mid-token at a hyphen, like every
  //     wrapper in this file's reports — or, for a web address, after the
  //     query separator: the inspector report's bordered transcript carried
  //     `│ …/inspect.html?` over `│ projectUrl=…`. The `?` is the same
  //     opportunity rule 1b takes and needs no URL test of its own: a path
  //     cannot carry one — terminalPaths forbids `?` outright — so the glued
  //     token is web material or nothing, and the detectors below decide
  //     which. The hyphen is the same break-opportunity trace rule 1b reads,
  //     and the head and fit guards below still refuse everything else.
  //     Without the slash half, `  │ wrote /tmp/out` followed by `  │ done`
  //     would join into `/tmp/outdone`.
  //   - the continuation does not itself start with `/`. `…/` plus `/x` is not
  //     a path anyone wrote; it is two paths, and the second one is whole
  //     already.
  //   - the continuation's first token WOULD NOT HAVE FIT at the render width
  //     ({@link inferWrapWidth}). That is the wrapper's own arithmetic run
  //     backwards: if the token fit, the row above did not end because it ran
  //     out of room, so the row below is a new line that merely happens to
  //     carry the same gutter. It is what stops `  │ created /tmp/out/` +
  //     `  │ done` from joining when the block's own wider rows prove `done`
  //     had room — and the arithmetic runs against the INFERRED width, never
  //     the pane's live width, which is the repair this rule shares with 1b:
  //     the tenth report's CLI wraps its block at its own width inside a far
  //     wider pane, and against the pane every continuation head "had room",
  //     so no gutter wrap ever joined again. Where the block gives no wider
  //     row, the estimate falls back to the block itself and this guard stops
  //     constraining — the tail and head checks then carry the rule alone,
  //     the same price rule 1b pays for surviving resizes.
  //     Rule 1b's carve-out applies here too: a long hex head under a web
  //     tail is the address's own rest ({@link HEX_FRAGMENT}), its cut
  //     evidence independent of widths a full-width paragraph poisons.
  if (!tail.endsWith('/') && !tail.endsWith('-') && !tail.endsWith('?')) return null;
  const rest = next.text.slice(gutter[0].length);
  const head = /^\S+/.exec(rest)?.[0] ?? '';
  if (head === '' || head.startsWith('/')) return null;
  if (prev.lastCol + 1 + head.length <= wrapWidth && !(webSchemeTail && HEX_FRAGMENT.test(head)))
    return null;
  // The gutter is spaces and a narrow marker character — box-drawing, the
  // transcript elbow or a left partial block, all ambiguous-width and one
  // cell in xterm — so its string length is also its cell count; no
  // double-width correction is needed.
  return gutter[0].length;
}

/**
 * Whether [cell] carries the underline attribute. Guarded duck-check because
 * the test fakes build cells by hand; a real `IBufferCell` always answers.
 */
function cellUnderline(cell: IBufferCell | undefined): boolean {
  if (!cell || typeof cell.isUnderline !== 'function') return false;
  return cell.isUnderline() !== 0;
}

/**
 * Flatten the logical line that [bufferLineNumber] (1-based, as xterm passes
 * it to a link provider) belongs to.
 */
export function scanBufferLine(term: Terminal, bufferLineNumber: number): ScannedLine {
  const buf = term.buffer.active;
  const chars: string[] = [];
  const cells: { x: number; y: number; u: boolean }[] = [];
  const underlineTails = new Map<number, number>();
  const scratch = buf.getNullCell();
  // One inference per flattening, before any join decision: every
  // reconstruction below measures its fit arithmetic against this width.
  const wrapWidth = inferWrapWidth(buf, bufferLineNumber - 1, scratch);

  // Walk up to the row the logical line STARTS on. A row is a continuation of
  // the one above it when it is flagged wrapped, or when the rules above can
  // reconstruct a wrap xterm never saw; the first row that is neither is where
  // the line begins.
  let y = bufferLineNumber - 1;
  let joined = 0;
  while (y > 0) {
    const line = buf.getLine(y);
    if (line?.isWrapped) {
      y--;
      continue;
    }
    if (joined >= MAX_JOIN_ROWS) break;
    // Two extra row walks, and only on the row the mouse is actually over —
    // xterm asks a link provider once per hovered ROW, not once per cell.
    const above = readRow(buf, y - 1, scratch);
    const here = readRow(buf, y, scratch);
    if (above === null || here === null) break;
    if (joinedRowSkip(above, here, wrapWidth) === null) break;
    joined++;
    y--;
  }

  // Cells to drop from the front of the row about to be read: a reconstructed
  // gutter or a hanging indent, never anything else.
  let skip = 0;
  joined = 0;
  for (;;) {
    const line = buf.getLine(y);
    if (!line) break;
    for (let x = skip; x < line.length; x++) {
      const cell = line.getCell(x, scratch);
      if (!cell) continue;
      // Width 0 is the right-hand half of a double-width character: it holds no
      // string content of its own and must not advance the string index.
      if (cell.getWidth() === 0) continue;
      const underlined = cellUnderline(cell);
      const content = cell.getChars();
      if (content === '') {
        // An untouched cell. It reads as a space, which is what makes it a
        // token boundary for the detector.
        chars.push(' ');
        cells.push({ x, y, u: underlined });
        continue;
      }
      // Pushed per UTF-16 code unit, not per code point, so that string offsets
      // from the detector index this array directly.
      for (let k = 0; k < content.length; k++) {
        chars.push(content.charAt(k));
        cells.push({ x, y, u: underlined });
      }
    }
    if (chars.length >= MAX_SCAN_CHARS) break;

    const next = buf.getLine(y + 1);
    if (next?.isWrapped) {
      skip = 0;
      y++;
      continue;
    }
    if (joined >= MAX_JOIN_ROWS) break;
    const here = readRow(buf, y, scratch);
    const below = readRow(buf, y + 1, scratch);
    if (here === null || below === null) break;
    const continues = joinedRowSkip(here, below, wrapWidth);
    if (continues === null) break;
    // A row a TUI wrapped itself stops short of the margin, so the cells after
    // it read as spaces — and a run of spaces in the middle of the flattened
    // line would break the path back into the two tokens we just went to the
    // trouble of joining. They are dropped rather than emitted. Nothing is lost
    // with them: an `isWrapped` row is full by definition and never gets here,
    // rule 1 fires only on a row whose last column is occupied, and rule 1b
    // leaves behind nothing but the wrap's own blank columns.
    //
    // What CAN be lost is the fill's underline attribute — the thirteenth
    // report's CLI underlines the fill after its cut, and a fragment ending at
    // the cut must still be able to claim that underlined stretch ({@link
    // linksPerRow}). The last underlined column of the dropped run is
    // remembered, not the cells.
    let tailUnderline = -1;
    while (chars.length > 0 && chars[chars.length - 1] === ' ') {
      const dropped = cells.pop();
      chars.pop();
      if (dropped !== undefined && dropped.u && dropped.x > tailUnderline) {
        tailUnderline = dropped.x;
      }
    }
    if (tailUnderline >= 0) underlineTails.set(y, tailUnderline);
    skip = continues;
    joined++;
    y++;
  }

  return { text: chars.join(''), cells, underlineTails };
}

/**
 * The ILinks for one detector match: one per ROW a match sits on, every one
 * opening the whole match.
 *
 * A match that spans rows cannot be reported as ONE link spanning them.
 * xterm draws a link's hover underline per row, and for every row that is not
 * the range's last it underlines from the link's start column to the PANE's
 * last column (DomRenderer's `_setCellUnderline` passes `cols` as the end
 * index whenever the row is not `range.end.y`) — a wrapped URL underlined
 * through the empty space after its cut, the shape the user reported. A link
 * confined to a single row is underlined exactly from its first cell to its
 * last, so the match is cut into one fragment link per row: the underline
 * stops at the cut on the row above and starts at the content (past any
 * gutter or hanging indent) on the row below. xterm's hit-testing is per
 * cell, so a fragment activates exactly on its own text — hovering the
 * padding after the cut is no longer hovering the link at all.
 *
 * Each fragment still opens the WHOLE match: `build` receives the fragment's
 * text and range and closes over the match itself.
 *
 * ## Where a fragment may end past its own text
 *
 * Not every stretch of bare cells after a cut may stay bare. The thirteenth
 * report's CLI underlines its attachment paths and paints the row's remaining
 * fill with the attribute still active, so at rest the underline runs from the
 * path through empty space to the pane's edge — and a fragment ending at the
 * text leaves most of what the user sees underlined a DEAD ZONE: the click
 * lands on nothing, and the feature reads broken precisely where it worked.
 * The claim therefore extends through trailing cells that are spaces AND carry
 * the underline attribute — the exact stretch the CLI itself presents as part
 * of its link — and stops at the first plain cell, so the padding of a CLI
 * that underlines only its text (every report before this one) is left bare
 * exactly as before. Hover cannot repaint what is already underlined, so the
 * hover view does not change either; only the hit-testing follows the
 * underline. For a row whose fill was dropped by a join ({@link
 * scanBufferLine}) the dropped run's last underlined column is consulted
 * instead ({@link ScannedLine.underlineTails}).
 */
function linksPerRow(
  scanned: ScannedLine,
  start: number,
  end: number,
  build: (text: string, range: ILink['range']) => ILink,
): ILink[] {
  const links: ILink[] = [];
  let from = start;
  // `end` is exclusive, as the detectors report it. A row change at `i` (or
  // reaching `end`) closes the group of cells [from, i) as one fragment. The
  // cells of one row are contiguous — the flattening walks x within a row —
  // so a match touches each row in exactly one run.
  for (let i = start + 1; i <= end; i++) {
    if (i < end && scanned.cells[i]?.y === scanned.cells[i - 1]?.y) continue;
    const first = scanned.cells[from];
    const last = scanned.cells[i - 1];
    if (first === undefined || last === undefined) {
      from = i;
      continue;
    }
    // The underlined-fill extension ([linksPerRow]): past the fragment's last
    // content cell, through spaces wearing the underline attribute, never
    // through a plain cell — a second path later on the same row keeps its own
    // cells, underlined separator or not.
    let endX = last.x;
    for (let j = i; j < scanned.cells.length; j++) {
      const cell = scanned.cells[j];
      if (cell === undefined || cell.y !== last.y || !cell.u || scanned.text.charAt(j) !== ' ') {
        break;
      }
      endX = cell.x;
    }
    // A joined row's fill is not in the array at all — the drop that kept the
    // glued token whole took it — so its underlined stretch is read from the
    // tail the flattening remembered. The two sources are disjoint: a row
    // whose fill stayed in the array has no tail entry.
    const tail = scanned.underlineTails.get(last.y);
    if (tail !== undefined && tail > endX) endX = tail;
    links.push(
      build(scanned.text.slice(from, i), {
        // xterm's range is 1-based and inclusive at both ends.
        start: { x: first.x + 1, y: first.y + 1 },
        end: { x: endX + 1, y: last.y + 1 },
      }),
    );
    from = i;
  }
  return links;
}

/**
 * The links for one buffer line. Exported for testing without a live terminal. */
export function pathLinks(
  term: Terminal,
  bufferLineNumber: number,
  context: () => TerminalPathContext,
): ILink[] {
  return pathLinksFromScan(scanBufferLine(term, bufferLineNumber), context);
}

/** The path half of {@link lineLinks}, over an already-flattened line. */
function pathLinksFromScan(scanned: ScannedLine, context: () => TerminalPathContext): ILink[] {
  const links: ILink[] = [];

  for (const match of findPaths(scanned.text)) {
    // One link per row the path touches ({@link linksPerRow}), every one of
    // them opening `match.path` — deliberately, NOT the `text` xterm hands
    // back: that is the fragment underlined, which still carries the `:12:5`
    // suffix and, on a continuation row, none of the path's head.
    links.push(
      ...linksPerRow(scanned, match.start, match.end, (text, range) => ({
        range,
        text,
        decorations: { pointerCursor: true, underline: true },
        activate: () => {
          revealInFiles(context(), match.path);
        },
      })),
    );
  }
  return links;
}

/** What a multi-row URL click does. main allow-lists the scheme; see TerminalView. */
export type UrlOpener = (url: string) => void;

/**
 * The web links for one buffer line — but only the ones that SPAN rows, plus
 * the bare (schemeless) addresses that sit on one.
 *
 * A scheme URL on a single row is WebLinksAddon's to find, and stays so: the
 * addon has matched web links for years and the schemeless branch below
 * returns nothing for it precisely so the provider never answers those lines
 * and the addon keeps every cell it always owned. A bare `127.0.0.1:8300` is
 * the mirror case: the addon's regex is anchored on `https?://` and can never
 * see it, so if this provider also passed, the address would stay plain text
 * — the `claimSingleRow` flag is what takes it. A URL the remote CLI's
 * wrapper broke across rows is the addon's blind spot either way — it reads
 * one row at a time — and it is the whole reason these links exist: the
 * flattened line rejoins the fragments, the detector (./terminalUrls.ts)
 * finds the address in it, and one link per row the address covers is
 * registered (each opening the whole address).
 *
 * [open] is injected rather than imported so a click's behaviour stays a
 * TerminalView decision (and a test can observe it without a window).
 */
export function urlLinks(term: Terminal, bufferLineNumber: number, open: UrlOpener): ILink[] {
  return urlLinksFromScan(scanBufferLine(term, bufferLineNumber), open, true);
}

/** The URL half of {@link lineLinks}, over an already-flattened line. */
function urlLinksFromScan(
  scanned: ScannedLine,
  open: UrlOpener,
  claimSingleRow = false,
): ILink[] {
  const links: ILink[] = [];

  for (const match of findUrls(scanned.text)) {
    const from = scanned.cells[match.start];
    const to = scanned.cells[match.end - 1];
    if (from === undefined || to === undefined) continue;
    // A single-row address stays WebLinksAddon's — except a schemeless one,
    // whose only claimant this provider is ([claimSingleRow]; the at-rest
    // highlighter shares this scan and keeps the addon-era rule for both
    // kinds: a single-row address was never half-underlined by the remote
    // CLI, so there is nothing to repair).
    if (from.y === to.y && !(claimSingleRow && match.schemeless)) continue;

    links.push(
      ...linksPerRow(scanned, match.start, match.end, (text, range) => ({
        range,
        text,
        decorations: { pointerCursor: true, underline: true },
        activate: () => open(match.url),
      })),
    );
  }
  return links;
}

/**
 * One scan, both detectors — the at-rest highlighter's entry point.
 *
 * `pathLinks` and `urlLinks` each flatten the line they are asked about, and
 * the highlighter asks about every row the renderer touches; asking both
 * questions of one flattening halves that cost. The links come back in one
 * list because the highlighter does not care who a cell belongs to, only
 * which cells each link covers — and the two detectors can never contest a
 * cell: terminalPaths refuses any `://` token before it peels anything.
 */
export function lineLinks(
  term: Terminal,
  bufferLineNumber: number,
  context: () => TerminalPathContext,
  open: UrlOpener,
): ILink[] {
  const scanned = scanBufferLine(term, bufferLineNumber);
  return [...pathLinksFromScan(scanned, context), ...urlLinksFromScan(scanned, open)];
}

/**
 * A provider for TerminalView to register.
 *
 * It must be registered AFTER `WebLinksAddon` is loaded. xterm consults link
 * providers in registration order and drops a lower-priority link that
 * intersects a higher-priority one, so registering second is what guarantees a
 * URL stays a web link even if the path detector were ever to be fooled by one.
 * (It is not: terminalPaths.ts rejects any http(s) token outright, and a
 * `file://` token is not a web link at all — the detector strips its scheme and
 * opens the path.)
 */
export function createPathLinkProvider(
  term: Terminal,
  context: () => TerminalPathContext,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback): void {
      const links = pathLinks(term, bufferLineNumber, context);
      // `undefined`, not an empty array: xterm treats an array as "this
      // provider answered" when it decides which provider owns a cell.
      callback(links.length > 0 ? links : undefined);
    },
  };
}

/**
 * A provider for the web links that span rows.
 *
 * Registration order is the whole design, and it is the OPPOSITE of the path
 * provider's: this one must be registered BEFORE `WebLinksAddon`. xterm gives
 * an earlier provider priority for the same row and drops a later provider's
 * link where the cells intersect — and on a wrapped URL's FIRST row the addon
 * does report a link: the truncated `https://…/opik/` fragment, the very
 * thing the user complained sat underlined and half-usable. Registered first,
 * this row's fragment of the whole address claims those cells out from under
 * it (the two cover the same cells, ours being the one that opens the whole
 * address), and on the continuation rows the addon reports nothing at all, so
 * the address's fragment is the only link there. A single-row SCHEME URL never
 * gets here — the addon answers it, and this provider's `undefined` for the
 * line leaves the addon untouched there as it always was — but a single-row
 * BARE address (`127.0.0.1:8300`) does: the addon's regex is anchored on
 * `https?://` and can never see it, so this provider is its only claimant
 * ({@link urlLinks} for the split).
 */
export function createUrlLinkProvider(term: Terminal, open: UrlOpener): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback): void {
      const links = urlLinks(term, bufferLineNumber, open);
      callback(links.length > 0 ? links : undefined);
    },
  };
}

/**
 * Hand the path to the files store.
 *
 * The session's working directory is looked up HERE, at click time, rather than
 * being captured when the provider was built: a workspace opened by deep link
 * renders before the sessions store has been refreshed, so a path captured at
 * mount would be resolved against a cwd of `undefined`.
 */
function revealInFiles(context: TerminalPathContext, path: string): void {
  const sessions = useSessionsStore();
  const cwd = context.sessionName
    ? (sessions.sessions.find((s) => s.name === context.sessionName)?.path ?? null)
    : null;
  useFilesStore().requestReveal(path, cwd);
}
