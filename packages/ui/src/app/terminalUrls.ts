/**
 * Finding http(s) URLs in a line of terminal output.
 *
 * Pure like terminalPaths.ts, and for the same reason: the only input is a
 * string already flattened out of the buffer, the only output offsets into
 * it. The flattening and the join rules live in terminalLinks.ts — this
 * module is nothing but the verdict on a finished line.
 *
 * Why a second detector when WebLinksAddon has matched web links all along:
 * the addon reads ONE buffer row at a time, so a URL the remote CLI's own
 * wrapper broke across rows reaches it as a fragment — the first row's
 * `https://www.comet.com/opik/` linkifies and opens, and the continuation
 * (`alexey-grigorev/projects/…`) sits plain. The join rules reconstruct the
 * whole line; this detector claims the URL in it. Single-row URLs are left
 * to the addon (the provider in terminalLinks.ts skips them), so everything
 * the addon already did well keeps behaving exactly as before.
 *
 * What counts as a URL is deliberately thinner than the addon's regex: the
 * scheme anchors the match, whitespace ends it, and the same trailing
 * decoration the path detector peels — sentence punctuation, closers with no
 * opener inside — comes off the end. `(https://host/x).` underlines
 * `https://host/x`; `%5B` and friends need no special case, because a
 * percent sign is just a character. The one URL-shaped thing refused outright
 * is a scheme with no authority (`https:///x`) — nothing a click could open.
 *
 * The family matched WITHOUT a scheme is the one a dev box prints when it
 * reports where something lives: bare IPv4 addresses (`127.0.0.1:8300`) and
 * bare domains with somewhere to go (`datatalks.club/blog/sponsor-…html`).
 * Nothing else claims them: WebLinksAddon's regex is anchored on
 * `https?://`, and the path detector refuses address-shaped first segments
 * beside its hostname rule. The match's `url` carries the `http://` a click
 * needs — the only scheme the allow-lists between here and the browser admit
 * for an address like this — while `start`/`end` span what the user reads,
 * the bare address whole.
 *
 * The two halves of the family are deliberately NOT symmetric. An address
 * may stand alone: a dotted quad is rare enough in prose that its shape IS
 * the evidence (the four-part version number it collides with is the known,
 * accepted cost; three-part semver is not the shape). A domain may not: a
 * bare `datatalks.club` is a hostname being MENTIONED — and the tail of
 * `alexey@datatalks.club` — as often as an address, so a `:port` or a `/path`
 * is the belief it needs. One carve-out beside that: a `.js` domain with a
 * single extension-less path segment stays prose (`Node.js/Python`), the
 * same standard the path detector applies to a single-slash relative path,
 * narrowed to the one TLD that is also a filename extension.
 *
 * The rest is refusal: octets validate 0–255 and a fifth group refuses; a
 * letter, digit or dot against the address's left shoulder refuses it
 * (`v1.2.3.4`, `256.0.0.1` read from its second octet); a colon that is not
 * a port (`127.0.0.1:8300:8080`) and an scp-shaped `host:/path` fail the
 * anchor. IPv6 stays out — an unbracketed `::1` is colons all the way down,
 * the same character tmux separates its targets with, and the bracketed
 * forms are rare enough in this pane that guessing is not worth it.
 */
import {
  hasControlChar,
  HAS_EXTENSION,
  HOSTNAME,
  peelTrailingDecoration,
} from './terminalPaths';

export interface UrlMatch {
  /** Offset of the first character (`h` of the scheme) within the line. */
  start: number;
  /** Offset one past the last character of the URL, decoration excluded. */
  end: number;
  /** The URL itself: no enclosing parenthesis, no trailing sentence dot. */
  url: string;
  /**
   * True when the line carried no scheme and this module supplied the
   * `http://` in `url` — a bare `127.0.0.1:8300`. WebLinksAddon's regex
   * admits only scheme-bearing addresses, so on a single row these have no
   * other claimant; terminalLinks.ts reads the flag to take them there,
   * where a scheme URL would stay the addon's.
   */
  schemeless?: boolean;
}

/** Same budget as terminalPaths.ts: a scan nobody can read anyway. */
const MAX_LINE = 4096;

/**
 * The schemes this app opens. xterm core (OSC 8), WebLinksAddon and main's
 * window-open allow-list all draw the same line: http and https, nothing
 * else — so a `file://` URL stays the path detector's claim and `ssh://`
 * stays nobody's.
 */
const SCHEME = /https?:\/\//g;

/**
 * One octet: 0–255, and no leading zero — `01` is not how an address is
 * written. Strict here, so most junk never becomes a candidate at all.
 */
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';

/** A dotted quad — the bare-IP half of the schemeless family. */
const QUAD = `${OCTET}(?:\\.${OCTET}){3}`;

/** A candidate that IS a quad, not a longer domain whose tail looks like one. */
const QUAD_ONLY = new RegExp(`^${QUAD}$`);

/**
 * The whole schemeless address, anchored on the peeled token: a dotted quad
 * or a hostname, then an optional `:port` and an optional `/path?query`,
 * then the token must END. A fifth group (`1.2.3.4.5`), a colon that is not
 * a port (`127.0.0.1:8300:8080`), and a domain followed by anything but a
 * port or path (`datatalks.club:/tmp/x`, the scp shape) fail the anchor and
 * stay plain text. Group 1 is the host part, which the family rules below
 * read the rest against.
 */
const SCHEMELESS = new RegExp(`^(${QUAD}|${HOSTNAME.source})(?::\\d{1,5})?(?:[/?][^\\s]*)?$`);

/** The same shape, loose about what follows — the scout for candidate STARTS. */
const SCHEMELESS_SCOUT = new RegExp(`${QUAD}|${HOSTNAME.source}`, 'gi');

/**
 * The one TLD that is also a filename extension. `Node.js/Python` is prose
 * with a slash in it, and a `.js` domain therefore needs the same evidence a
 * single-slash relative path needs in terminalPaths.ts — more than one path
 * segment, or an extension-shaped one — before the slash is believed to be
 * an address's. Every other TLD collides with nothing: `.com`-shaped tails
 * on words are addresses by construction.
 */
const JS_TLD = /\.js$/i;

/** Every http(s) URL in `line`, left to right. */
export function findUrls(line: string): UrlMatch[] {
  const out: UrlMatch[] = [];
  if (line.length === 0 || line.length > MAX_LINE) return out;

  // Where the scheme-bearing addresses landed, so the schemeless scan below
  // never claims an octet run inside one (`http://127.0.0.1/x` is ONE
  // address, the scheme's).
  const spans: { start: number; end: number }[] = [];

  SCHEME.lastIndex = 0;
  for (let m = SCHEME.exec(line); m !== null; m = SCHEME.exec(line)) {
    const start = m.index;
    // The token runs to the next whitespace — the only boundary terminal
    // output reliably gives, and the one the join rules preserve when they
    // glue a wrapped URL back together.
    let end = start;
    while (end < line.length && !/\s/.test(line.charAt(end))) end++;

    const url = peelTrailingDecoration(line.slice(start, end));
    if (url.length <= m[0].length) continue;
    const authority = url.slice(m[0].length).split('/')[0] ?? '';
    if (authority.length === 0) continue;
    if (hasControlChar(url)) continue;

    spans.push({ start, end: start + url.length });
    out.push({ start, end: start + url.length, url });
    // Scan on past this URL: a query string embedding a second `https://`
    // (`?redirect=https://…`) is ONE address, not two links.
    SCHEME.lastIndex = start + url.length;
  }

  SCHEMELESS_SCOUT.lastIndex = 0;
  for (let m = SCHEMELESS_SCOUT.exec(line); m !== null; m = SCHEMELESS_SCOUT.exec(line)) {
    const start = m.index;
    if (spans.some((s) => start >= s.start && start < s.end)) continue;
    // `v1.2.3.4` is a version and `a.127.0.0.1` a five-label name; the
    // shoulder check is also what keeps an over-large first octet's tail
    // (`256.0.0.1`, scouted as `56.0.0.1` from its second digit) out.
    if (start > 0 && /[\w.]/.test(line.charAt(start - 1))) continue;

    let end = start;
    while (end < line.length && !/\s/.test(line.charAt(end))) end++;
    const address = peelTrailingDecoration(line.slice(start, end));
    const whole = SCHEMELESS.exec(address);
    if (whole === null) continue;

    // The family rules read what follows the host. A quad may stand alone —
    // its shape IS the evidence, and the four-part version number it collides
    // with is the accepted cost. A domain may not: a bare `datatalks.club` is
    // a hostname being mentioned (and the half of `alexey@datatalks.club`)
    // as often as an address, so a port or a path is the belief it needs.
    const host = whole[1] ?? '';
    const rest = address.slice(host.length);
    if (rest === '' && !QUAD_ONLY.test(host)) continue;
    if (schemelessProse(host, rest)) continue;
    if (hasControlChar(address)) continue;

    out.push({ start, end: start + address.length, url: `http://${address}`, schemeless: true });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * The `.js` carve-out ([JS_TLD]): one extension-less path segment is
 * prose with a slash (`Node.js/Python`), not an address. A `:port` is
 * evidence on its own and skips the carve-out, as do a trailing slash
 * (`node.js/blog/`, the shape a server prints) and an extension-shaped
 * or multi-segment path.
 */
function schemelessProse(host: string, rest: string): boolean {
  return (
    JS_TLD.test(host) &&
    rest.startsWith('/') &&
    !rest.endsWith('/') &&
    !HAS_EXTENSION.test(rest) &&
    rest.split('/').filter((s) => s !== '').length < 2
  );
}

/**
 * Could [token] be a SCHEMELESS address so far — the bare family above, cut
 * mid-address at a wrapper's `/` break? The fourteenth report's transcript
 * wrapped `https://` onto one row's last token and the address's rest onto
 * the next (`…app.css https://` / `github.com/DataTalksClub/dapier/` /
 * `commit/4b…`): the middle row's tail IS this family's so-far shape, but
 * the scheme anchor sees nothing (no `://` on that row) and the path
 * detector refuses hostname first segments — so the join gate would refuse
 * the very tail this module exists to rejoin. The anchor and family rules
 * are the scan's own, minus what needs line context: a bare hostname still
 * refuses (a hostname mentioned is prose; the `:port`/`/path` evidence is
 * required) and the `.js` carve-out holds.
 */
export function continuesSchemelessAddress(token: string): boolean {
  if (token.length === 0 || token.length > MAX_LINE) return false;
  const whole = SCHEMELESS.exec(token);
  if (whole === null) return false;
  const host = whole[1] ?? '';
  const rest = token.slice(host.length);
  if (rest === '') return false;
  if (schemelessProse(host, rest)) return false;
  if (hasControlChar(token)) return false;
  return true;
}
