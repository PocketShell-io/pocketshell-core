import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * #3191: the composer card never paints one row over another. On a phone the
 * docked card is short; with a platform chip row (an upload refusal), the
 * error banner, the uploading line and staged tiles all showing, the draft
 * wrap used to shrink under its textarea (min-height: 0) and the next row
 * painted on top of the draft. Mounts the REAL PromptComposer docked in a
 * 411x914 pane and asserts no two of those rows intersect; .panel-body
 * scrolls instead. A missing browser FAILS, it never skips.
 *
 * (Harness shape borrowed from sessionTreeRowsBrowser.test.ts.)
 * #3145 G9 (original note): the session tree's compact density in REAL Chromium layout
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
    root: resolve(PACKAGE_ROOT, 'tests/fixtures/composer-layout'),
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
  profile = mkdtempSync(join(tmpdir(), 'composer-layout-'));
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

const FILL = `(async () => {
  const composer = window.__composer;
  const key = Object.keys(composer.states)[0];
  for (let i = 0; i < 3; i += 1) composer.seedAttachment(key, '/home/u/.pocketshell/attachments/sess/20261118-1000' + i + '-0' + i + '-photo.jpg');
  composer.states[key].uploadingCount = 1;
  composer.states[key].error = 'Attachment failed: second.jpg: No space left on device';
  await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
  return key;
})()`;

const MEASURE = `(() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { name: el.className || el.tagName, top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; };
  const rows = [
    ...document.querySelectorAll('.composer .test-chip'),
    ...document.querySelectorAll('.composer textarea.draft'),
    ...document.querySelectorAll('.composer .banner'),
    ...document.querySelectorAll('.composer .uploading'),
    ...document.querySelectorAll('.composer .tiles .tile'),
  ].map(box);
  const body = document.querySelector('.composer .panel-body');
  return { rows, draftHeight: document.querySelector('.composer textarea.draft')?.getBoundingClientRect().height ?? 0,
    scrolls: body ? body.scrollHeight > body.clientHeight : false, cardHeight: document.querySelector('.composer')?.getBoundingClientRect().height ?? 0 };
})()`;

interface Box { name: string; top: number; bottom: number; left: number; right: number; height: number }

function overlaps(a: Box, b: Box): boolean {
  return Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5 && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5;
}

describe('Prompt composer rows in real Chromium at 411x914 (#3191)', () => {
  it('a chip row, the error banner, the uploading line and tiles never paint over the draft', async () => {
    const cdp = await connect();
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 411, height: 914, deviceScaleFactor: 1, mobile: true });
    await cdp.send('Page.navigate', { url: `${origin}/` });
    for (let i = 0; i < 200; i += 1) {
      if (await cdp.evaluate<boolean>("!!window.__composer && !!document.querySelector('.composer textarea.draft')")) break;
      await new Promise((ok) => setTimeout(ok, 100));
    }
    await cdp.evaluate<string>(FILL);
    await new Promise((ok) => setTimeout(ok, 300));
    const m = await cdp.evaluate<{ rows: Box[]; draftHeight: number; scrolls: boolean; cardHeight: number }>(MEASURE);
    const names = m.rows.map((row) => row.name);
    expect(names.filter((n) => n.includes('tile')).length, JSON.stringify(m)).toBe(3);
    expect(names.some((n) => n.includes('test-chip'))).toBe(true);
    expect(names.some((n) => n.includes('uploading'))).toBe(true);
    expect(names.some((n) => n.includes('banner'))).toBe(true);
    // The draft keeps its two-line floor.
    expect(m.draftHeight).toBeGreaterThanOrEqual(46);
    const collisions: string[] = [];
    for (let i = 0; i < m.rows.length; i += 1) {
      for (let j = i + 1; j < m.rows.length; j += 1) {
        if (overlaps(m.rows[i]!, m.rows[j]!)) collisions.push(`${m.rows[i]!.name} x ${m.rows[j]!.name}`);
      }
    }
    expect(collisions, JSON.stringify(m)).toEqual([]);
  }, 90_000);
});
