import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * #3121 (Mobile S2) in REAL Chromium layout: the actual HostWorkspaceView with
 * the shipped CSS and tokens (jsdom has no layout), at 360 and 412 dp.
 * `pointer: coarse` is a real media match (Blink's primaryPointerType), not a
 * rewritten stylesheet. Measured with getBoundingClientRect:
 *
 *   coarse, compact, folder open: no 36px rail; the pane starts at x=0 and is
 *     the full viewport wide; the tab strip is 44px high; every tab and the `+`
 *     are 44px tall / 48px wide where icon-only; no `×`; the overflow sheet's
 *     rows are labelled and >= 48px; no horizontal page scroll.
 *   coarse, compact, session list: the header is exactly four >= 48px controls.
 *   fine (a narrow desktop window): no rail, desktop density (strip 32px).
 *   fine, expanded: the desktop layout, measured, equals its old numbers.
 *
 * Needs a Chromium (CHROMIUM_BIN / CHROME_BIN / chromium / google-chrome); a
 * missing browser FAILS, it never skips.
 */
const PACKAGE_ROOT = resolve(__dirname, '..');

function findBrowser(): string {
  for (const candidate of [process.env.CHROMIUM_BIN, process.env.CHROME_BIN, 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
    if (candidate && spawnSync(candidate, ['--version'], { encoding: 'utf8' }).status === 0) return candidate;
  }
  throw new Error('Could not find Chromium or Chrome; set CHROMIUM_BIN to its executable.');
}

let vite: ViteDevServer;
let origin = '';
const chromes: ChildProcess[] = [];
const profiles: string[] = [];

async function freePort(): Promise<number> {
  const { createServer: net } = await import('node:net');
  return new Promise((ok) => {
    const s = net();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });
}

class Cdp {
  private id = 0;
  private waiting = new Map<number, (m: { result?: unknown; error?: unknown }) => void>();
  constructor(private ws: WebSocket) {
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      this.waiting.get(msg.id)?.(msg);
    };
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<{ result?: any }> {
    return new Promise((ok, fail) => {
      const id = ++this.id;
      this.waiting.set(id, (m) => (m.error ? fail(new Error(JSON.stringify(m.error))) : ok(m as { result?: any })));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result.result.value as T;
  }
}

beforeAll(async () => {
  vite = await createServer({
    root: resolve(PACKAGE_ROOT, 'tests/fixtures/compact-chrome'),
    configFile: false,
    logLevel: 'error',
    plugins: [vue()],
    resolve: {
      alias: [
        { find: /^@ui\/(.*)$/, replacement: `${resolve(PACKAGE_ROOT, 'src')}/$1` },
        { find: /^@pocketshell\/core\/(.*)$/, replacement: `${resolve(PACKAGE_ROOT, '../../src')}/$1` },
        { find: /^@pocketshell\/core$/, replacement: resolve(PACKAGE_ROOT, '../../src/index.ts') },
      ],
    },
    server: { port: 0, host: '127.0.0.1', fs: { strict: false } },
  });
  await vite.listen();
  origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
}, 60_000);

afterEach(() => {
  // One Chromium per test, gone before the next starts.
  for (const c of chromes.splice(0)) c.kill('SIGKILL');
});

afterAll(async () => {
  for (const c of chromes) c.kill('SIGKILL');
  await vite?.close();
  for (const p of profiles) rmSync(p, { recursive: true, force: true });
});

/** One Chromium start attempt; null when it never exposed a page target in time. */
async function startOnce(pointer: 'coarse' | 'fine'): Promise<Cdp | null> {
  const debugPort = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'compact-chrome-'));
  profiles.push(profile);
  const pointerFlags =
    pointer === 'coarse'
      ? '--blink-settings=primaryPointerType=2,availablePointerTypes=2,primaryHoverType=1,availableHoverTypes=1'
      : '--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2';
  const chrome = spawn(findBrowser(), [
    '--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`, '--remote-allow-origins=*', pointerFlags, 'about:blank',
  ], { stdio: 'ignore' });
  chromes.push(chrome);
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      const page = targets.find((t) => t.type === 'page');
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
        return new Cdp(ws);
      }
    } catch { /* still starting */ }
    await new Promise((ok) => setTimeout(ok, 100));
  }
  chrome.kill('SIGKILL');
  return null;
}

/**
 * A fresh Chromium whose primary pointer is coarse or fine, driven over CDP.
 * A cold start on a busy box occasionally never comes up (seen ~1 in 5 first
 * launches); that is retried, and three misses in a row still FAIL.
 */
async function launch(pointer: 'coarse' | 'fine'): Promise<Cdp> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const cdp = await startOnce(pointer);
    if (cdp) return cdp;
  }
  throw new Error('Chromium did not expose a page target after 3 starts');
}

async function open(cdp: Cdp, width: number, height: number, route: 'pane' | 'panel'): Promise<void> {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 700 });
  await cdp.send('Page.navigate', { url: `${origin}/?route=${route}` });
  const ready = route === 'pane' ? '.folder-bar' : '.tree-header';
  for (let i = 0; i < 150; i += 1) {
    if (await cdp.evaluate<boolean>(`!!document.querySelector('${ready}')`)) break;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  await new Promise((ok) => setTimeout(ok, 400));
}

const BOX = `(sel) => [...document.querySelectorAll(sel)].map((e) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100, x: Math.round(r.left * 100) / 100, cls: e.className, label: e.getAttribute('aria-label') || e.getAttribute('title') || e.textContent.trim() }; })`;
const boxes = (cdp: Cdp, sel: string) => cdp.evaluate<{ w: number; h: number; x: number; cls: string; label: string }[]>(`(${BOX})(${JSON.stringify(sel)})`);

describe.each([360, 412])('coarse pointer, compact, at %i dp', (width) => {
  it('folder open: no rail, full-width pane, 44px tab strip, no ×, 48px app-bar and sheet rows', async () => {
    const cdp = await launch('coarse');
    await open(cdp, width, 800, 'pane');
    expect(await cdp.evaluate<boolean>("matchMedia('(pointer: coarse)').matches")).toBe(true);

    expect(await boxes(cdp, '.collapsed-rail')).toEqual([]);
    const [pane] = await boxes(cdp, 'main.session-pane');
    expect(pane!.x).toBe(0);
    expect(pane!.w).toBe(width);

    const [strip] = await boxes(cdp, '.folder-bar');
    expect(strip!.h).toBe(44);
    const tabs = await boxes(cdp, '.tabs .tab');
    expect(tabs).toHaveLength(3);
    for (const t of tabs) expect(t.h, `tab ${t.label}`).toBe(44);
    for (const b of await boxes(cdp, '.tab.add, .tab.capture-open')) {
      expect(b.w, `icon tab ${b.label}`).toBeGreaterThanOrEqual(48);
      expect(b.h).toBe(44);
    }
    expect(await boxes(cdp, '.tab-close')).toEqual([]);

    const bar = await boxes(cdp, '[data-testid="compact-app-bar"] button');
    expect(bar.map((b) => b.label)).toEqual(['Back to sessions', expect.stringContaining('switch folder'), 'More']);
    for (const b of bar) expect(b.h, `app bar ${b.label}`).toBeGreaterThanOrEqual(48);
    expect(bar[0]!.w).toBeGreaterThanOrEqual(48);
    expect(bar[2]!.w).toBeGreaterThanOrEqual(48);
    for (const b of [...bar, ...tabs]) {
      if (b.cls.includes('tab') && !b.cls.includes('add')) continue; // tabs scroll; the strip itself must fit
      expect(b.x + b.w, `${b.label} right`).toBeLessThanOrEqual(width);
    }

    await cdp.evaluate("document.querySelector('button[aria-label=\"More\"]').click()");
    await new Promise((ok) => setTimeout(ok, 200));
    const rows = await boxes(cdp, '[data-testid="host-overflow-sheet"] .sheet-row');
    expect(rows.map((r) => r.label)).toEqual(['Port forwarding', 'Provider usage', 'Host monitor', 'Quick actions', 'Settings']);
    for (const r of rows) expect(r.h, `row ${r.label}`).toBeGreaterThanOrEqual(48);

    expect(await cdp.evaluate<[number, number]>('[document.documentElement.scrollWidth, document.documentElement.clientWidth]'))
      .toEqual([width, width]);
    await cdp.evaluate('0');
  }, 150_000);

  it('session list: the header is back, refresh, new session and overflow, each >= 48px', async () => {
    const cdp = await launch('coarse');
    await open(cdp, width, 800, 'panel');
    const header = await boxes(cdp, '[data-testid="session-tree-compact-header"] button');
    expect(header.map((b) => b.label)).toEqual(['Back to hosts', 'Refresh', 'New session in any folder', 'More']);
    for (const b of header) {
      expect(b.w, b.label).toBeGreaterThanOrEqual(48);
      expect(b.h, b.label).toBeGreaterThanOrEqual(48);
    }
    // Nothing in the header may spill past the viewport (a header gear at
    // x=424 on a 412 phone once made Settings unreachable): every control sits
    // inside [0, width], and Settings is a labelled row behind the overflow.
    for (const b of header) {
      expect(b.x, `${b.label} left`).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w, `${b.label} right`).toBeLessThanOrEqual(width);
    }
    await cdp.evaluate("document.querySelector('[data-testid=\"session-tree-compact-header\"] button[aria-label=\"More\"]').click()");
    await new Promise((ok) => setTimeout(ok, 200));
    const rows = await boxes(cdp, '[data-testid="host-overflow-sheet"] .sheet-row');
    expect(rows.map((r) => r.label)).toContain('Settings');
    for (const r of rows) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(width);
    }
    const [panel] = await boxes(cdp, 'aside.session-panel');
    expect(panel!.w).toBe(width);
  }, 150_000);
});

describe('fine pointer', () => {
  it('a narrow desktop window has no rail and keeps desktop density (32px strip)', async () => {
    const cdp = await launch('fine');
    await open(cdp, 400, 800, 'pane');
    expect(await cdp.evaluate<boolean>("matchMedia('(pointer: fine)').matches")).toBe(true);
    expect(await boxes(cdp, '.collapsed-rail')).toEqual([]);
    expect((await boxes(cdp, '.folder-bar'))[0]!.h).toBe(32);
    expect(await boxes(cdp, '.tab-close')).toEqual([]);
  }, 150_000);

  it('expanded desktop: panel + splitter + pane, 40px strip with × on every tab, nine-square header', async () => {
    const cdp = await launch('fine');
    await open(cdp, 1200, 800, 'pane');
    expect(await boxes(cdp, '.collapsed-rail')).toEqual([]);
    expect(await boxes(cdp, '[data-testid="compact-app-bar"]')).toEqual([]);
    expect((await boxes(cdp, '.folder-bar'))[0]!.h).toBe(40);
    expect(await boxes(cdp, '.tab-close')).toHaveLength(3);
    const header = await boxes(cdp, '.tree-header .icon-btn');
    expect(header).toHaveLength(9);
    for (const b of header) {
      expect(b.w).toBe(28);
      expect(b.h).toBe(28);
    }
    expect((await boxes(cdp, 'aside.session-panel'))[0]!.w).toBe(312);
  }, 150_000);
});
