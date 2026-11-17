import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * #3125 (S4c) acceptance in REAL Chromium layout (jsdom has none): the real
 * FilesView and PortPanelView through Vite, driven over raw CDP.
 *  - compact (360 / 412): the file tree and the editor are never both visible;
 *    opening a file shows the editor; Back returns to the tree with its scroll
 *    offset kept; no splitter. Forward cards have no horizontal scroll and no
 *    nine-column table.
 *  - expanded (1200): the splitter, the table and its min-width are unchanged.
 * Set FILES_PORTS_SHOTS=<dir> to also write screenshots. A missing browser
 * FAILS, it never skips.
 */
const PACKAGE_ROOT = resolve(__dirname, '..');
const SHOTS = process.env.FILES_PORTS_SHOTS;

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
  async shot(name: string): Promise<void> {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.result.data as string, 'base64'));
  }
}

beforeAll(async () => {
  vite = await createServer({
    root: resolve(PACKAGE_ROOT, 'tests/fixtures/files-ports-layout'),
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
  profile = mkdtempSync(join(tmpdir(), 'files-ports-layout-'));
  chrome = spawn(findBrowser(), [
    '--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`, '--remote-allow-origins=*', 'about:blank',
  ], { stdio: 'ignore' });
}, 60_000);

afterAll(async () => {
  chrome?.kill('SIGKILL');
  await vite?.close();
  // Chrome's helper processes can still be writing into the profile right
  // after SIGKILL; retry so teardown never races them (ENOTEMPTY in CI).
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
    await new Promise<void>((resolve) => { chrome!.once('exit', () => resolve()); setTimeout(resolve, 5_000); });
  }
  if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
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

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

async function openPage(view: 'files' | 'ports', width: number, ready: string): Promise<Cdp> {
  const cdp = await connect();
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 2, mobile: width < 700 });
  await cdp.send('Page.navigate', { url: `${origin}/?view=${view}` });
  for (let i = 0; i < 150; i += 1) {
    if (await cdp.evaluate<boolean>(`!!document.querySelector('${ready}')`)) break;
    await sleep(100);
  }
  await sleep(400);
  return cdp;
}

const BOXES = `(() => {
  const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const tree = document.querySelector('.file-tree');
  const editor = document.querySelector('.editor-area');
  return {
    treeVisible: vis(tree), editorVisible: vis(editor),
    splitter: !!document.querySelector('.tree-splitter'),
    back: !!document.querySelector('[data-testid=files-back]'),
    docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    scrollTop: document.querySelector('.entries').scrollTop,
    editorText: editor ? editor.innerText : '',
  };
})()`;

interface FilesBoxes {
  treeVisible: boolean; editorVisible: boolean; splitter: boolean; back: boolean;
  docOverflow: boolean; scrollTop: number; editorText: string;
}

describe.each([360, 412])('Files in real Chromium at %i dp (compact)', (width) => {
  it('tree and editor never share the screen; Back keeps the scroll offset; no splitter', async () => {
    const cdp = await openPage('files', width, '.entries .entry');
    const before = await cdp.evaluate<FilesBoxes>(BOXES);
    expect(before.treeVisible).toBe(true);
    expect(before.editorVisible).toBe(false);
    expect(before.splitter).toBe(false);
    expect(before.docOverflow).toBe(false);
    await cdp.shot(`files-tree-${width}`);

    await cdp.evaluate("(() => { document.querySelector('.entries').scrollTop = 240; })()");
    await sleep(100);
    const scrolled = await cdp.evaluate<number>("document.querySelector('.entries').scrollTop");
    expect(scrolled).toBeGreaterThan(100);

    // Open a file by tapping a row (rows 6.. are files).
    await cdp.evaluate("(() => { const rows = [...document.querySelectorAll('.entries .entry')]; rows.find((r) => r.textContent.includes('notes-30')).click(); })()");
    for (let i = 0; i < 50; i += 1) {
      if (await cdp.evaluate<boolean>("!!document.querySelector('.editor-bar')")) break;
      await sleep(100);
    }
    await sleep(300);
    const open = await cdp.evaluate<FilesBoxes>(BOXES);
    expect(open.editorVisible).toBe(true);
    expect(open.treeVisible).toBe(false);
    expect(open.back).toBe(true);
    expect(open.editorText).toContain('notes-30');
    expect(open.docOverflow).toBe(false);
    await cdp.shot(`files-editor-${width}`);

    await cdp.evaluate("document.querySelector('[data-testid=files-back]').click()");
    await sleep(300);
    const after = await cdp.evaluate<FilesBoxes>(BOXES);
    expect(after.treeVisible).toBe(true);
    expect(after.editorVisible).toBe(false);
    expect(after.scrollTop).toBe(scrolled);
  }, 60_000);
});

describe('Files in real Chromium at 1200 dp (expanded, unchanged)', () => {
  it('keeps the splitter and shows tree and editor side by side with no Back chevron', async () => {
    const cdp = await openPage('files', 1200, '.entries .entry');
    await cdp.evaluate("(() => { const rows = [...document.querySelectorAll('.entries .entry')]; rows.find((r) => r.textContent.includes('notes-30')).click(); })()");
    for (let i = 0; i < 50; i += 1) {
      if (await cdp.evaluate<boolean>("!!document.querySelector('.editor-bar')")) break;
      await sleep(100);
    }
    await sleep(300);
    const m = await cdp.evaluate<FilesBoxes>(BOXES);
    expect(m.splitter).toBe(true);
    expect(m.treeVisible).toBe(true);
    expect(m.editorVisible).toBe(true);
    expect(m.back).toBe(false);
    expect(await cdp.evaluate<boolean>("!!document.querySelector('.close-btn')")).toBe(true);
  }, 60_000);
});

const PORTS = `(() => {
  const panel = document.querySelector('.port-panel');
  const wrap = document.querySelector('.table-wrap');
  const table = document.querySelector('.fwd-table');
  const rows = [...document.querySelectorAll('.fwd-table tbody tr')].filter((r) => r.getBoundingClientRect().height > 0 && !r.classList.contains('more-row'));
  const pr = panel.getBoundingClientRect();
  return {
    docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    wrapOverflow: wrap.scrollWidth > wrap.clientWidth,
    panelOverflow: panel.scrollWidth > panel.clientWidth,
    tableMinWidth: getComputedStyle(table).minWidth,
    tableWidth: table.getBoundingClientRect().width,
    panelWidth: pr.width,
    rowCount: rows.length,
    rowsInside: rows.every((r) => { const b = r.getBoundingClientRect(); return b.left >= pr.left - 1 && b.right <= pr.right + 1; }),
    rowDisplays: [...new Set(rows.map((r) => getComputedStyle(r).display))],
    headerDisplay: getComputedStyle(document.querySelector('.fwd-table thead')).position,
    firstRowText: rows[0] ? rows[0].innerText : '',
    // card lines: distinct vertical bands of its cells
    firstRowLines: rows[0] ? new Set([...rows[0].children].map((c) => Math.round(c.getBoundingClientRect().top))).size : 0,
    compactClass: panel.classList.contains('compact'),
    inArrow: getComputedStyle(rows[0].querySelector('.c-in'), '::before').content,
    outArrow: getComputedStyle(rows[0].querySelector('.c-out'), '::before').content,
    inLabel: rows[0].querySelector('.c-in').getAttribute('aria-label'),
    folders: rows.map((r) => r.querySelector('.c-folder').innerText.trim()),
    // every card variant shares one geometry
    nameWidths: [...new Set(rows.map((r) => Math.round(r.querySelector('.c-name').getBoundingClientRect().width)))],
    localLefts: [...new Set(rows.map((r) => Math.round(r.querySelector('.c-local').getBoundingClientRect().left)))],
    actionRights: [...new Set(rows.map((r) => Math.round(r.querySelector('.c-actions').getBoundingClientRect().right)))],
  };
})()`;

interface PortsBoxes {
  docOverflow: boolean; wrapOverflow: boolean; panelOverflow: boolean; tableMinWidth: string; tableWidth: number;
  panelWidth: number; rowCount: number; rowsInside: boolean; rowDisplays: string[]; headerDisplay: string;
  firstRowText: string; firstRowLines: number; compactClass: boolean;
  inArrow: string; outArrow: string; inLabel: string | null; folders: string[];
  nameWidths: number[]; localLefts: number[]; actionRights: number[];
}

describe.each([360, 412])('Ports in real Chromium at %i dp (compact)', (width) => {
  it('forwards are cards: no horizontal scroll, no min-width table, rows inside the panel', async () => {
    const cdp = await openPage('ports', width, '.fwd-table tbody tr');
    const m = await cdp.evaluate<PortsBoxes>(PORTS);
    expect(m.rowCount).toBeGreaterThanOrEqual(3);
    expect(m.compactClass).toBe(true);
    expect(m.docOverflow).toBe(false);
    expect(m.wrapOverflow).toBe(false);
    expect(m.panelOverflow).toBe(false);
    expect(m.tableMinWidth).not.toBe('860px');
    expect(m.tableWidth).toBeLessThanOrEqual(m.panelWidth);
    expect(m.rowsInside).toBe(true);
    expect(m.rowDisplays).toEqual(['grid']);
    expect(m.headerDisplay).toBe('absolute');
    expect(m.firstRowText).toContain('3000');
    expect(m.inArrow).toContain('↓');
    expect(m.outArrow).toContain('↑');
    expect(m.inLabel).toMatch(/^Received /);
    expect(m.folders[0]).toBe('frontend');
    expect(m.nameWidths).toHaveLength(1);
    expect(m.localLefts).toHaveLength(1);
    expect(m.actionRights).toHaveLength(1);
    await cdp.shot(`ports-${width}`);
  }, 60_000);
});

describe('Ports in real Chromium at 1200 dp (expanded, unchanged)', () => {
  it('keeps the nine-column table with its min-width', async () => {
    const cdp = await openPage('ports', 1200, '.fwd-table tbody tr');
    const m = await cdp.evaluate<PortsBoxes>(PORTS);
    expect(m.compactClass).toBe(false);
    expect(m.tableMinWidth).toBe('860px');
    expect(m.rowDisplays).toEqual(['table-row']);
    expect(await cdp.evaluate<number>("document.querySelectorAll('.fwd-table thead th').length")).toBe(9);
  }, 60_000);
});
