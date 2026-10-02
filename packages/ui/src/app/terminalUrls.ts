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
 * The one family matched WITHOUT a scheme is a bare IPv4 address — the
 * `127.0.0.1:8300` a dev box prints when it reports where a server it just
 * started listens. Nothing else claims it: WebLinksAddon's regex is anchored
 * on `https?://`, and the path detector refuses any first segment of the
 * shape (terminalPaths.ts, beside its hostname rule). The match's `url`
 * carries the `http://` a click needs — the only scheme the allow-lists
 * between here and the browser admit for an address like this — while
 * `start`/`end` span what the user reads, the bare address whole. A `:port`
 * and a `/path?query` ride along; the octets are validated 0–255; a letter,
 * digit or dot against the address's left shoulder (`v1.2.3.4`,
 * `256.0.0.1` read from its second octet) refuses it, as does a fifth group.
 * The false-positive cost is known and accepted: a four-part version number
 * is the same shape and will linkify — the three-part semver everyone
 * prints is not the shape and never matches. IPv6 stays out: an unbracketed
 * `::1` is colons all the way down, the same character tmux separates its
 * targets with, and the bracketed forms are rare enough in this pane that
 * guessing is not worth it.
 */
import { hasControlChar, peelTrailingDecoration } from './terminalPaths';

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

/**
 * The whole schemeless address, anchored on the peeled token: four octets,
 * then an optional `:port` and an optional `/path?query`, then the token
 * must END. A fifth group (`1.2.3.4.5`) and a colon that is not a port
 * (`127.0.0.1:8300:8080`) fail the anchor and stay plain text.
 */
const SCHEMELESS = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}(?::\\d{1,5})?(?:[/?].*)?$`);

/** The same shape, loose about what follows — the scout for candidate STARTS. */
const QUAD = new RegExp(`${OCTET}(?:\\.${OCTET}){3}`, 'g');

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

  QUAD.lastIndex = 0;
  for (let m = QUAD.exec(line); m !== null; m = QUAD.exec(line)) {
    const start = m.index;
    if (spans.some((s) => start >= s.start && start < s.end)) continue;
    // `v1.2.3.4` is a version and `a.127.0.0.1` a five-label name; the
    // shoulder check is also what keeps an over-large first octet's tail
    // (`256.0.0.1`, scouted as `56.0.0.1` from its second digit) out.
    if (start > 0 && /[\w.]/.test(line.charAt(start - 1))) continue;

    let end = start;
    while (end < line.length && !/\s/.test(line.charAt(end))) end++;
    const address = peelTrailingDecoration(line.slice(start, end));
    if (!SCHEMELESS.test(address)) continue;
    if (hasControlChar(address)) continue;

    out.push({ start, end: start + address.length, url: `http://${address}`, schemeless: true });
  }
  return out.sort((a, b) => a.start - b.start);
}
