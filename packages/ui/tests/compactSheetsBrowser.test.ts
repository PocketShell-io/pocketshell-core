import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Cdp, gotoAndWait, sleep } from './support/cdp';

/**
 * #3123 S4a in REAL Chromium: computed boxes (getBoundingClientRect) of the real
 * OverlayPanel / CommandPalette / PopupMenu / SettingsView / NewSessionDialog at
 * 360x800 and 412x915 under an emulated COARSE pointer, with and without a
 * keyboard inset, plus the unchanged expanded / fine-pointer output at 1280x800.
 * A missing browser FAILS, it never skips.
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


beforeAll(async () => {
  vite = await createServer({
    root: resolve(PACKAGE_ROOT, 'tests/fixtures/compact-sheets'),
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
  debugPort = await freePort();
}, 60_000);

/** One Chromium at a time (a snap Chromium hands a second instance to the first). */
const COARSE = 'primaryPointerType=2,availablePointerTypes=2,primaryHoverType=1,availableHoverTypes=1';
const FINE = 'primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2';
async function startChrome(pointer: string): Promise<void> {
  chrome?.kill('SIGKILL');
  await new Promise((ok) => setTimeout(ok, 500));
  if (profile) rmSync(profile, { recursive: true, force: true });
  profile = mkdtempSync(join(tmpdir(), 'compact-sheets-'));
  chrome = spawn(findBrowser(), [
    '--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`, '--remote-allow-origins=*', `--blink-settings=${pointer}`, 'about:blank',
  ], { stdio: 'ignore' });
}


afterAll(async () => {
  chrome?.kill('SIGKILL');
  await vite?.close();
  if (profile) rmSync(profile, { recursive: true, force: true });
});

async function connect(port: number): Promise<Cdp> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
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


interface Box { left: number; top: number; right: number; bottom: number; width: number; height: number }
const SHOTS = process.env.S4A_SHOTS;

const BOX = `const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };`;

/** Open `case` at a viewport + pointer; optionally raise a keyboard inset; evaluate `probe`. */
async function run<T>(opts: { fine?: boolean; width: number; height: number; kb?: number; shot?: string }, which: string, probe: string, before = ''): Promise<T> {
  const cdp = await connect(debugPort);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: opts.width, height: opts.height, deviceScaleFactor: 1, mobile: !opts.fine });
  await gotoAndWait(cdp, `${origin}/?case=${which}`, READY[which] ?? '.overlay-title');
  await new Promise((ok) => setTimeout(ok, 500));
  if (before) await cdp.evaluate(before);
  if (opts.kb) await cdp.evaluate(`document.documentElement.style.setProperty('--ps-inset-keyboard', '${opts.kb}px')`);
  await new Promise((ok) => setTimeout(ok, 400));
  const out = await cdp.evaluate<T>(`(() => { ${BOX} return (${probe})(); })()`);
  if (SHOTS && opts.shot) {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(SHOTS, { recursive: true });
    const png = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(SHOTS, `${opts.shot}.png`), Buffer.from(png.result.data, 'base64'));
  }
  return out;
}

const READY: Record<string, string> = { 'overlay-in-host': '.overlay-title', palette: '.palette-item', menu: '.menu-item', newsession: '.commit-actions button', settings: '#settings-tab-keyboard' };
const PHONES = [{ width: 360, height: 800 }, { width: 412, height: 915 }];
const KB = 300;

describe.each(PHONES)('compact sheets at $width x $height, coarse pointer', ({ width, height }) => {
  beforeAll(() => startChrome(COARSE), 60_000);
  const at = (kb: number, shot: string) => ({ width, height, kb, shot: `${shot}-${width}${kb ? '-kb' : ''}` });

  it.each([0, KB])('OverlayPanel is the whole screen (keyboard inset %i)', async (kb) => {
    const m = await run<{ panel: Box; header: Box; back: Box; close: boolean; title: string }>(at(kb, 'overlay'), 'overlay', `() => ({
      panel: box(document.querySelector('.overlay-panel')), header: box(document.querySelector('.overlay-header')),
      back: box(document.querySelector('button[aria-label=Back]')), close: !!document.querySelector('button[title=Close]'),
      title: document.querySelector('.overlay-title').textContent })`);
    expect([m.panel.left, m.panel.top, m.panel.width]).toEqual([0, 0, width]);
    expect(m.panel.bottom).toBe(height - kb);
    expect(m.header.height).toBeGreaterThanOrEqual(56);
    expect(m.back.width).toBeGreaterThanOrEqual(48);
    expect(m.back.height).toBeGreaterThanOrEqual(48);
    expect(m.back.left).toBeLessThan(m.header.left + 24);
    expect(m.close).toBe(false);
  }, 60_000);

  it('OverlayPanel opened inside a transformed host still covers the whole viewport (seen on device: it started below the panel toolbar)', async () => {
    const m = await run<{ panel: Box }>(at(0, 'overlay-in-host'), 'overlay-in-host', `() => ({ panel: box(document.querySelector('.overlay-panel')) })`);
    expect([m.panel.left, m.panel.top, m.panel.width, m.panel.height]).toEqual([0, 0, width, height]);
  }, 60_000);

  it.each([0, KB])('CommandPalette is a bottom sheet, input at the bottom edge above the keyboard (inset %i)', async (kb) => {
    const m = await run<{ root: Box; input: Box; list: Box; items: Box[]; focused: boolean }>(at(kb, 'palette'), 'palette', `() => ({
      root: box(document.querySelector('.command-palette')), input: box(document.querySelector('.palette-input')),
      list: box(document.querySelector('.palette-list')), items: [...document.querySelectorAll('.palette-item')].map(box),
      focused: document.activeElement === document.querySelector('.palette-input') })`);
    expect([m.root.left, m.root.right]).toEqual([0, width]);
    expect(m.root.bottom).toBe(height - kb);
    expect(m.root.top, 'the sheet never rides off the top').toBeGreaterThanOrEqual(0);
    expect(m.input.bottom).toBeLessThanOrEqual(m.root.bottom);
    expect(m.input.top).toBeGreaterThanOrEqual(m.list.bottom - 0.5);
    expect(m.input.height).toBeGreaterThanOrEqual(48);
    expect(m.items.length).toBeGreaterThan(0);
    for (const item of m.items) expect(item.height).toBeGreaterThanOrEqual(48);
    expect(m.focused).toBe(false);
  }, 60_000);

  it.each([0, KB])('PopupMenu is a bottom sheet with 48px rows and a scrim (inset %i)', async (kb) => {
    const m = await run<{ menu: Box; scrim: Box | null; items: Box[] }>(at(kb, 'menu'), 'menu', `() => ({
      menu: box(document.querySelector('.popup-menu')), scrim: box(document.querySelector('.popup-scrim')),
      items: [...document.querySelectorAll('.menu-item')].map(box) })`);
    expect([m.menu.left, m.menu.right]).toEqual([0, width]);
    expect(m.menu.bottom).toBe(height - kb);
    expect(m.scrim).not.toBeNull();
    expect([m.scrim!.width, m.scrim!.height]).toEqual([width, height]);
    expect(m.items.length).toBe(4);
    for (const item of m.items) expect(item.height).toBeGreaterThanOrEqual(48);
  }, 60_000);

  it.each([0, KB])('NewSessionDialog: full-height sheet, one-line route labels and buttons that fit, no keyboard (inset %i)', async (kb) => {
    const m = await run<{
      panel: Box; tabs: { box: Box; fits: boolean; lines: number }[]; strip: Box; buttons: { text: string; box: Box; fits: boolean; lines: number }[];
      commit: Box; list: Box; docX: number[]; focused: boolean }>(at(kb, 'newsession'), 'newsession', `() => {
      const lines = (el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight || '20'));
      const fits = (el) => el.scrollWidth <= el.clientWidth + 1;
      return {
        panel: box(document.querySelector('.overlay-panel')), strip: box(document.querySelector('.routes')),
        tabs: [...document.querySelectorAll('.route')].map((e) => ({ box: box(e), fits: fits(e), lines: e.scrollHeight <= e.clientHeight + 1 ? 1 : 2 })),
        buttons: [...document.querySelectorAll('.commit-actions button')].map((e) => ({ text: e.textContent.trim(), box: box(e), fits: fits(e), lines: e.scrollHeight <= e.clientHeight + 1 ? 1 : 2 })),
        commit: box(document.querySelector('.commit')), list: box(document.querySelector('.folder-rows')),
        docX: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
        focused: document.activeElement?.tagName === 'INPUT' }; }`);
    expect(m.panel.height).toBe(height - kb);
    expect(m.tabs.map((t) => t.lines)).toEqual([1, 1, 1]);
    for (const t of m.tabs) { expect(t.fits).toBe(true); expect(t.box.right).toBeLessThanOrEqual(m.strip.right); expect(t.box.height).toBeGreaterThanOrEqual(48); }
    expect(m.buttons.map((b) => b.text)).toEqual(['Cancel', 'Start shell', 'Start session…']);
    for (const b of m.buttons) {
      expect(b.lines, b.text).toBe(1);
      expect(b.fits, b.text).toBe(true);
      expect(b.box.left, b.text).toBeGreaterThanOrEqual(0);
      expect(b.box.right, b.text).toBeLessThanOrEqual(width);
      expect(b.box.bottom, b.text).toBeLessThanOrEqual(height - kb);
      expect(b.box.height, b.text).toBeGreaterThanOrEqual(48);
    }
    expect(m.commit.bottom).toBeLessThanOrEqual(height - kb);
    expect(m.list.height).toBeGreaterThan(96);
    expect(m.docX[0]).toBeLessThanOrEqual(m.docX[1]);
    expect(m.focused).toBe(false);
  }, 60_000);

  it('NewSessionDialog: the focused New-folder field stays above the action bar with the keyboard up', async () => {
    const m = await run<{ field: Box; commit: Box; panelBottom: number }>(at(KB, 'newsession-field-kb'), 'newsession', `() => ({
      field: box(document.querySelector('.field .text-input')), commit: box(document.querySelector('.commit')),
      panelBottom: document.querySelector('.overlay-panel').getBoundingClientRect().bottom })`,
      `(() => { document.querySelector('.route:nth-child(2)').click();
        return new Promise((ok) => setTimeout(() => { document.documentElement.style.setProperty('--ps-inset-keyboard', '${KB}px');
          setTimeout(() => { document.querySelector('.field .text-input').focus(); setTimeout(ok, 300); }, 300); }, 300)); })()`);
    expect(m.field.bottom, 'field not under the sticky bar').toBeLessThanOrEqual(m.commit.top + 1);
    expect(m.field.top).toBeGreaterThanOrEqual(0);
    expect(m.commit.bottom).toBeLessThanOrEqual(m.panelBottom);
  }, 60_000);

  it('Settings > Keyboard: one "Keyboard shortcuts" row, then the editor with no horizontal overflow', async () => {
    const m = await run<{ rowH: number; collapsed: boolean; open: boolean; docX: number[]; railFits: boolean }>(
      at(0, 'settings-shortcuts'), 'settings', `() => {
      const row = document.querySelector('button.shortcuts-row');
      const collapsed = !document.querySelector('.keyboard');
      const rowH = row.getBoundingClientRect().height;
      row.click();
      return new Promise((done) => setTimeout(() => done({ rowH, collapsed, open: !!document.querySelector('.keyboard'),
        docX: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
        railFits: document.querySelector('.keys-rail').getBoundingClientRect().right <= innerWidth }), 300)); }`,
      "document.querySelector('#settings-tab-keyboard').click()");
    expect(m.collapsed).toBe(true);
    expect(m.rowH).toBeGreaterThanOrEqual(48);
    expect(m.open).toBe(true);
    expect(m.docX[0]).toBeLessThanOrEqual(m.docX[1]);
    expect(m.railFits).toBe(true);
  }, 60_000);
});

describe('expanded / fine pointer output is unchanged at 1280x800', () => {
  beforeAll(() => startChrome(FINE), 60_000);
  const at = { fine: true, width: 1280, height: 800 };

  it('OverlayPanel: a centred dialog capped at 960, X close, no Back', async () => {
    const m = await run<{ panel: Box; back: boolean; close: boolean }>({ ...at, shot: 'overlay-desktop' }, 'overlay', `() => ({
      panel: box(document.querySelector('.overlay-panel')), back: !!document.querySelector('button[aria-label=Back]'), close: !!document.querySelector('button[title=Close]') })`);
    expect(m.panel.width).toBeCloseTo(960, -1); // 960 + the 1px borders; the harness has no global border-box
    expect(m.panel.left).toBeCloseTo(160, -1);
    expect(m.back).toBe(false);
    expect(m.close).toBe(true);
  }, 60_000);

  it('CommandPalette: 520 wide, top-centre at 10vh, input focused', async () => {
    const m = await run<{ root: Box; focused: boolean }>({ ...at, shot: 'palette-desktop' }, 'palette', `() => ({
      root: box(document.querySelector('.command-palette')), focused: document.activeElement === document.querySelector('.palette-input') })`);
    expect(m.root.width).toBeCloseTo(520, -1);
    expect(m.root.top).toBeCloseTo(80, -1);
    expect(m.focused).toBe(true);
  }, 60_000);

  it('PopupMenu: min-width 180, hangs off the anchor, no scrim', async () => {
    const m = await run<{ menu: Box; scrim: boolean }>({ ...at, shot: 'menu-desktop' }, 'menu', `() => ({
      menu: box(document.querySelector('.popup-menu')), scrim: !!document.querySelector('.popup-scrim') })`);
    expect(m.menu.width).toBeGreaterThanOrEqual(180);
    expect(m.menu.left).toBe(200);
    expect(m.menu.top).toBeGreaterThanOrEqual(300);
    expect(m.scrim).toBe(false);
  }, 60_000);

  it('NewSessionDialog: full route labels on one line, search focused', async () => {
    const m = await run<{ labels: string[]; focused: boolean; width: number }>({ ...at, shot: 'newsession-desktop' }, 'newsession', `() => ({
      labels: [...document.querySelectorAll('.route')].map((e) => e.textContent.trim()),
      focused: document.activeElement?.getAttribute('aria-label') === 'Search folders in this directory',
      width: document.querySelector('.overlay-panel').getBoundingClientRect().width })`);
    expect(m.labels).toEqual(['Existing folder', 'New folder', 'Clone from GitHub']);
    expect(m.focused).toBe(true);
    expect(m.width).toBeCloseTo(720, -1);
  }, 60_000);
});
