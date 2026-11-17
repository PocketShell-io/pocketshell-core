import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * #3145 G9: the session tree's compact density in REAL Chromium layout
 * (mobile emulation => pointer: coarse => --row-h 48px). Mounts the actual
 * SessionTreeRowsView over a realistic tree (many single-session projects,
 * multi-session ones, deleted directories) at 360 and 412 dp and asserts each
 * acceptance criterion: single-session projects are ONE row with the session
 * name as a secondary line; names use one UI face (no mono); no "(deleted)"
 * text, a trash mark instead; rows are 48px and >= 14 fit on 412x915; the
 * desktop (non-compact) rows keep their group + leaf-less shape and mono for
 * untracked labels. CI provisions Chrome (CHROMIUM_BIN); a missing browser
 * FAILS, it never skips.
 */
const PACKAGE_ROOT = resolve(__dirname, '..');

function findBrowser(): string {
  for (const candidate of [process.env.CHROMIUM_BIN, process.env.CHROME_BIN, 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
    if (candidate && spawnSync(candidate, ['--version'], { encoding: 'utf8' }).status === 0) return candidate;
  }
  throw new Error('Could not find Chromium or Chrome; set CHROMIUM_BIN to its executable.');
}

let vite: ViteDevServer;
let chrome: ChildProcess;
let profile: string;
let origin = '';
let debugPort = 0;

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
    root: resolve(PACKAGE_ROOT, 'tests/fixtures/session-tree-rows'),
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
  debugPort = await freePort();
  profile = mkdtempSync(join(tmpdir(), 'session-tree-rows-'));
  chrome = spawn(findBrowser(), [
    '--headless=new', '--no-sandbox',
    // Touch phone input: (pointer: coarse) and (hover: none), which is what makes --row-h 48px.
    '--blink-settings=primaryPointerType=2,availablePointerTypes=2,primaryHoverType=1,availableHoverTypes=1', '--disable-gpu', `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`, '--remote-allow-origins=*', 'about:blank',
  ], { stdio: 'ignore' });
}, 60_000);

afterAll(async () => {
  chrome?.kill('SIGKILL');
  await vite?.close();
  if (profile) rmSync(profile, { recursive: true, force: true });
});

async function connect(): Promise<Cdp> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      const page = targets.find((t) => t.type === 'page');
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
        return new Cdp(ws);
      }
    } catch { /* browser still starting */ }
    await new Promise((ok) => setTimeout(ok, 100));
  }
  throw new Error('Chromium did not expose a page target');
}

const MEASURE = `(() => {
  const rect = (el) => el.getBoundingClientRect();
  const rows = [...document.querySelectorAll('.dir-header, .session-leaf, .folder-header')].filter((r) => r.offsetParent);
  const visible = rows.filter((r) => rect(r).bottom <= innerHeight);
  const fams = (sel) => [...document.querySelectorAll(sel)].map((e) => getComputedStyle(e).fontFamily);
  const named = (name) => document.querySelector('.dir-header[data-session-name="' + name + '"]');
  return {
    coarse: matchMedia('(pointer: coarse)').matches,
    classes28: rows.filter((r) => Math.round(rect(r).height) < 48).map((r) => r.className + ':' + r.textContent.slice(0, 30)),
    text: document.body.innerText,
    rowHeights: rows.map((r) => Math.round(rect(r).height)),
    visibleRows: visible.length,
    scrollW: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
    nameFams: [...fams('.label'), ...fams('.secondary')],
    trash: document.querySelectorAll('.deleted-mark').length,
    // a single-session project is one .dir-header and no leaf list under it
    orchestrator: (() => { const el = named('orchestrator-main'); return el && {
      primary: el.querySelector('.label')?.textContent, secondary: el.querySelector('.secondary')?.textContent,
      leavesAfter: !!el.parentElement.querySelector('.session-leaves'),
      primarySize: getComputedStyle(el.querySelector('.label')).fontSize,
      secondarySize: getComputedStyle(el.querySelector('.secondary')).fontSize,
    }; })(),
    leafCount: document.querySelectorAll('.session-leaf').length,
    dirCount: document.querySelectorAll('.dir-header').length,
    sortButtons: document.querySelectorAll('.root-sort').length,
  };
})()`;

interface Measure {
  text: string; rowHeights: number[]; visibleRows: number; scrollW: number[]; nameFams: string[]; trash: number;
  orchestrator: { primary: string; secondary: string | null; leavesAfter: boolean; primarySize: string; secondarySize: string | null } | null;
  leafCount: number; dirCount: number; sortButtons: number;
}

async function measure(layout: 'compact' | 'desktop', width: number, height = 915): Promise<Measure> {
  const cdp = await connect();
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Page.navigate', { url: `${origin}/?layout=${layout}` });
  for (let i = 0; i < 100; i += 1) {
    if (await cdp.evaluate<boolean>("!!document.querySelector('.dir-header')")) break;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  await new Promise((ok) => setTimeout(ok, 300));
  return cdp.evaluate<Measure>(MEASURE);
}

describe.each([360, 412])('Session tree compact rows in real Chromium at %i dp', (width) => {
  it('collapses single-session projects, one UI face, 48px rows, no (deleted) text', async () => {
    const m = await measure('compact', width);
    expect(m.scrollW[0], 'no horizontal overflow').toBeLessThanOrEqual(m.scrollW[1]);
    // One row for a single-session project: name + secondary session name, no leaf list.
    expect(m.orchestrator).toEqual({
      primary: 'orchestrator', secondary: 'orchestrator-main', leavesAfter: false, primarySize: '15px', secondarySize: '13px',
    });
    // Only the multi-session project (pocketshell, ai-shipping-labs) draws leaves.
    expect(m.leafCount).toBe(5);
    // One face: no row name is mono.
    for (const fam of m.nameFams) expect(fam, 'name font family').not.toMatch(/mono|consolas/i);
    // "(deleted)" is an icon, not text.
    expect(m.text).not.toContain('(deleted)');
    expect(m.trash).toBeGreaterThanOrEqual(2);
    // Every row is the touch target height.
    expect(m.coarse).toBe(true);
    expect((m as any).classes28).toEqual([]);
    for (const h of m.rowHeights) expect(h).toBeGreaterThanOrEqual(48);
    // No stray per-root sort door on the compact rows.
    expect(m.sortButtons).toBe(0);
  }, 60_000);

  it('shows at least 14 rows on a phone-height (915) screen', async () => {
    const m = await measure('compact', width, 915);
    expect(m.visibleRows).toBeGreaterThanOrEqual(14);
  }, 60_000);

  it('desktop (non-compact) rows are unchanged: leaf-less, group rows only, sort door kept', async () => {
    const m = await measure('desktop', width);
    expect(m.leafCount).toBe(0);
    expect(m.orchestrator).toBeNull();
    expect(m.sortButtons).toBeGreaterThan(0);
    expect(m.text).toContain('(deleted)');
  }, 60_000);
});
