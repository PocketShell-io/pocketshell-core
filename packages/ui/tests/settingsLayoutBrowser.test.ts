import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Cdp, warmBrowser, warmServer, gotoAndWait, sleep, waitForSelector } from './support/cdp';

/**
 * #3139 G9: the Settings acceptance in REAL Chromium layout (jsdom has none).
 * Mounts the actual SettingsView inside OverlayPanel through Vite, drives
 * Chromium over raw CDP at 360 and 412 dp (mobile emulation) and, for every tab,
 * asserts: the dialog frame, the active panel and the dialog body do not scroll
 * horizontally (scrollWidth <= clientWidth); no setting row of ANY shape is
 * side by side (every flex row container that holds a `.row-text`); on an
 * Android-style host (app.desktopChrome === false) no desktop-only copy shows
 * and a stored `system` theme still selects a visible option. A desktop-style
 * host keeps its Keyboard tab. CI provisions Chrome (CHROMIUM_BIN); a missing
 * browser FAILS, it never skips.
 */
const PACKAGE_ROOT = resolve(__dirname, '..');
const BANNED = ['Follow Windows', 'Ctrl', 'Electron', 'installed on this machine', 'Consolas'];

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
    root: resolve(PACKAGE_ROOT, 'tests/fixtures/settings-layout'),
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
  await warmServer(origin);
  debugPort = await freePort();
  profile = mkdtempSync(join(tmpdir(), 'settings-layout-'));
  chrome = spawn(findBrowser(), [
    '--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`, '--remote-allow-origins=*', 'about:blank',
  ], { stdio: 'ignore' });
  await warmBrowser(await connect(), origin);
}, 180_000);

afterAll(async () => {
  chrome?.kill('SIGKILL');
  await vite?.close();
  // Chrome's helper processes can still be writing into the profile right
  // after SIGKILL; retry so teardown never races them (ENOTEMPTY in CI).
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
    await new Promise<void>((resolve) => { chrome!.once('exit', () => resolve()); setTimeout(resolve, 5_000); });
  }
  // Best effort: Chrome's crashpad/helper processes can outlive the browser
  // and keep writing into the throwaway /tmp profile (ENOTEMPTY in CI).
  // A leftover temp dir must never fail the suite.
  try {
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // ignore
  }
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

const MEASURE = (tab: string) => `(() => {
  document.querySelector('#settings-tab-${tab}').click();
  return new Promise((done) => setTimeout(() => {
    const panel = document.querySelector('#settings-panel-${tab}');
    const frame = document.querySelector('.settings');
    const body = frame.parentElement;
    const rows = [...panel.querySelectorAll('.row, .row-main, .key-row')].filter((r) => r.offsetParent);
    const sideBySide = [...panel.querySelectorAll('*')].filter((el) => el.offsetParent
      && getComputedStyle(el).display === 'flex' && getComputedStyle(el).flexDirection === 'row'
      && el.querySelector(':scope > .row-text, :scope > * > .row-text')
      && el.querySelector(':scope > .control, :scope > .switch, :scope > .stepper, :scope > .range-control, :scope > select, :scope > input'))
      .map((el) => el.className);
    const theme = document.querySelector('#theme-choice');
    done({
      frame: [frame.scrollWidth, frame.clientWidth],
      panel: [panel.scrollWidth, panel.clientWidth],
      body: [body.scrollWidth, body.clientWidth],
      doc: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
      sideBySide,
      rowCount: rows.length,
      text: panel.innerText,
      theme: theme ? { value: theme.value, label: theme.selectedOptions[0]?.textContent ?? null } : null,
    });
  }, 150));
})()`;

interface Measure {
  frame: number[]; panel: number[]; body: number[]; doc: number[]; sideBySide: string[]; rowCount: number; text: string;
  theme: { value: string; label: string | null } | null;
}

async function measureAll(host: 'android' | 'desktop', width: number): Promise<{ tabs: string[]; byTab: Record<string, Measure> }> {
  const cdp = await connect();
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: true });
  await gotoAndWait(cdp, `${origin}/?host=${host}`, '.settings');
  await waitForSelector(cdp, '#settings-tab-general');
  await sleep(300);
  const tabs = await cdp.evaluate<string[]>("[...document.querySelectorAll('[role=tab]')].map((e) => e.id.replace('settings-tab-', ''))");
  const byTab: Record<string, Measure> = {};
  for (const tab of tabs) byTab[tab] = await cdp.evaluate<Measure>(MEASURE(tab));
  return { tabs, byTab };
}

describe.each([360, 412])('Settings in real Chromium at %i dp', (width) => {
  it('android host: no horizontal overflow, single-column rows, no desktop copy, a visible theme', async () => {
    const { tabs, byTab } = await measureAll('android', width);
    expect(tabs).toEqual(['general', 'sessions', 'appearance', 'advanced']);
    for (const tab of tabs) {
      const m = byTab[tab];
      expect(m.rowCount, `${tab} has rows`).toBeGreaterThan(0);
      expect(m.frame[0], `${tab} frame scrollWidth`).toBeLessThanOrEqual(m.frame[1]);
      expect(m.panel[0], `${tab} panel scrollWidth`).toBeLessThanOrEqual(m.panel[1]);
      expect(m.body[0], `${tab} body scrollWidth`).toBeLessThanOrEqual(m.body[1]);
      expect(m.doc[0], `${tab} document scrollWidth`).toBeLessThanOrEqual(m.doc[1]);
      expect(m.sideBySide, `${tab} side-by-side setting rows`).toEqual([]);
      for (const word of BANNED) expect(m.text, `${tab} shows "${word}"`).not.toContain(word);
    }
    expect(byTab.appearance.theme).toEqual({ value: 'system', label: 'Follow system' });
  }, 60_000);

  it('desktop host: keeps the Keyboard tab and Follow Windows', async () => {
    const { tabs, byTab } = await measureAll('desktop', width);
    expect(tabs).toContain('keyboard');
    expect(byTab.appearance.text).toContain('Follow Windows');
  }, 60_000);
});
