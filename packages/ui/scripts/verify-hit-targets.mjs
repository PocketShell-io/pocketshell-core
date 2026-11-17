/**
 * Real-browser measurement of the shared hit-target contract (#3120, S1).
 *
 * Loads the SHIPPED css (tokens.css, primitives.css, the style blocks of the
 * row/vault/trust-prompt components) into headless Chromium and reads
 * getBoundingClientRect() — computed boxes, not parsed declarations:
 *
 *   - pointer: coarse  -> every .icon-btn, .btn-ghost, list row, vault and
 *     trust-prompt control measures >= 48x48 (height only where the control is
 *     intentionally full width).
 *   - pointer: fine    -> every measured size equals the snapshot in
 *     tests/fixtures/hit-target-fine.snapshot.json, which was taken from the
 *     CSS on origin/main (a97d029) BEFORE --hit-min existed.
 *   - workspace        -> with non-zero insets (and a keyboard inset) the
 *     .workspace bottom edge lands inside the viewport; the old `100vh` rule
 *     is measured as a negative control and must overflow.
 *
 * Pointer type is emulated with Blink's primaryPointerType setting (a real
 * `(pointer: coarse)` match, verified in-page), not by rewriting the CSS.
 * Needs a Chromium: CHROMIUM_BIN / CHROME_BIN, else chromium, chromium-browser,
 * google-chrome. No browser is a FAILURE, never a skip.
 *
 *   node scripts/verify-hit-targets.mjs [--root <ui src dir>] [--write-snapshot] [--out <measured.json>]
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const SRC = resolve(opt('--root') ?? join(HERE, '../src'));
const SNAPSHOT = join(HERE, '../tests/fixtures/hit-target-fine.snapshot.json');
const WRITE = args.includes('--write-snapshot');
const OUT = opt('--out');
const evidence = { root: SRC, fine: null, coarse: null, workspace: [] };

function findBrowser() {
  const candidates = [process.env.CHROMIUM_BIN, process.env.CHROME_BIN, 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'].filter(Boolean);
  for (const c of candidates) if (spawnSync(c, ['--version'], { encoding: 'utf8' }).status === 0) return c;
  throw new Error('verify-hit-targets: no Chromium/Chrome found; set CHROMIUM_BIN. (Not skipping: a skipped measurement is a vacuous green.)');
}

const read = (rel) => readFileSync(join(SRC, rel), 'utf8');
const styleOf = (rel) => {
  const s = read(rel);
  const start = s.indexOf('<style');
  return s.slice(s.indexOf('>', start) + 1, s.indexOf('</style>', start));
};

const css = [
  read('tokens.css'),
  read('primitives.css'),
  read('app/components/vault/vault.css'),
  styleOf('app/components/SessionTreeRowsView.vue'),
  styleOf('app/components/vault/VaultKeyList.vue'),
  styleOf('app/components/HostKeyTrustPrompt.vue'),
  // The REAL global block (box-sizing, html/body/#app 100%, body inset padding).
  styleOf('app/AppRoot.vue'),
  // Components whose own rules touch .btn-ghost / .icon-btn sizing.
  styleOf('app/components/DiagnosticsPanel.vue'),
  // Scoped in the app, so it only ever hits its own icon buttons: prefix it.
  styleOf('app/components/RemoteImagePicker.vue').replace(/(^|\n)(\.icon-btn)/g, '$1.rip $2'),
  styleOf('app/views/EnvPanelView.vue'),
].join('\n');

// Selector -> element markup. Keys are what the snapshot is keyed on.
const SUBJECTS = {
  '.icon-btn': '<button class="icon-btn">x</button>',
  '.icon-btn.sm': '<button class="icon-btn sm">x</button>',
  '.btn-ghost': '<button class="btn-ghost">Ports</button>',
  '.folder-header': '<div class="folder-header"><span class="label">f</span></div>',
  '.dir-header': '<div class="dir-header"><span class="label">d</span></div>',
  '.session-leaf': '<div class="session-leaf"><span class="label">s</span></div>',
  '.empty-root': '<div class="empty-root">empty</div>',
  '.vault-btn': '<button class="vault-btn">Save</button>',
  '.vault-radio': '<label class="vault-radio"><input type="radio" />opt</label>',
  '.vault-field input': '<div class="vault-field"><input type="text" /></div>',
  '.vault-field select': '<div class="vault-field"><select><option>a</option></select></div>',
  '.diagnostics .actions .btn-ghost': '<div class="diagnostics"><div class="actions"><button class="btn-ghost">Share report</button></div></div>',
  '.rip .icon-btn': '<div class="rip"><button class="icon-btn">x</button></div>',
  '.env-bulk-toggle': '<button class="btn-ghost bulk-toggle">Select</button>',
  '.row-actions .btn-ghost': '<div class="row-actions"><button class="btn-ghost">Del</button></div>',
  '.trust-actions .btn-primary': '<div class="trust-actions"><button class="btn-primary">Trust</button></div>',
  '.trust-actions .btn-secondary': '<div class="trust-actions"><button class="btn-secondary">Reject</button></div>',
};
// Full-width-by-design controls: only the height is held to 48.
const HEIGHT_ONLY = new Set(['.folder-header', '.dir-header', '.session-leaf', '.empty-root', '.trust-actions .btn-primary', '.trust-actions .btn-secondary', '.vault-radio', '.vault-field input', '.vault-field select']);

function page(mode) {
  const keys = Object.keys(SUBJECTS);
  const body = keys.map((k) => `<div class="cell" data-key="${k}" style="width:380px">${SUBJECTS[k]}</div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style>
<style>.cell{position:relative}</style></head><body><div id="app"><div id="cells">${body}</div></div>
<output id="result"></output><script>
const out = { pointer: { coarse: matchMedia('(pointer: coarse)').matches, fine: matchMedia('(pointer: fine)').matches }, sizes: {} };
for (const cell of document.querySelectorAll('.cell')) {
  const key = cell.dataset.key;
  const sel = key;
  const target = cell.querySelector(sel) || cell.firstElementChild;
  const r = target.getBoundingClientRect();
  out.sizes[key] = { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 };
}
document.getElementById('result').setAttribute('data-result', JSON.stringify(out));
</script></body></html>`;
}

// The real HostWorkspaceView root element and its real <style>, not a copy:
// the template's root class is read from the component, and the rule set that
// sizes it comes from its own style block (plus the real AppRoot/body chain in
// `css`). If either regresses (workspace sizing, body inset padding, root 100%)
// the measurement below moves.
const wsSource = read('app/views/HostWorkspaceView.vue');
const rootClass = /<template>\s*<div class="([^"]+)"/.exec(wsSource)?.[1];
if (!rootClass) throw new Error('HostWorkspaceView template root has no class');
const wsStyle = styleOf('app/views/HostWorkspaceView.vue');

function workspacePage({ top, bottom, keyboard }, override) {
  // `override` only drives the old-100vh negative control.
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}
${wsStyle}
:root { --ps-inset-top:${top}px; --ps-inset-bottom:${bottom}px; --ps-inset-keyboard:${keyboard}px; --ps-inset-left:0px; --ps-inset-right:0px; }
${override ? `.${rootClass} { height: ${override} !important; }` : ''}
</style></head><body><div id="app"><div class="${rootClass}"><div style="flex:1"></div></div></div>
<output id="result"></output><script>
const r = document.querySelector('.${rootClass.split(' ')[0]}').getBoundingClientRect();
document.getElementById('result').setAttribute('data-result', JSON.stringify({ top: r.top, bottom: r.bottom, viewport: innerHeight, display: getComputedStyle(document.querySelector('.${rootClass.split(' ')[0]}')).display }));
</script></body></html>`;
}

// What the shipped workspace rule declares, for the evidence file.
const workspaceHeight = (() => {
  const block = wsStyle.slice(wsStyle.indexOf('.workspace {'));
  const m = /height:\s*([^;]+);/.exec(block.slice(0, block.indexOf('}')));
  if (!m) throw new Error('HostWorkspaceView .workspace declares no height');
  return m[1].trim();
})();


// --- The REAL mounted root chain ---------------------------------------------
// Vite-builds tests/fixtures/rootChainEntry.ts (real AppRoot + its <style>,
// real router/HostWorkspaceView, real tokens.css/primitives.css) and mounts it
// in Chromium under the host page chrome the packaged Android app ships
// (index.html: `#app { min-height: 100dvh }`, html/body min-height 100%). Measured, not
// parsed: .workspace bottom vs innerHeight and the last control's reachability.
const HOST_PAGES = {
  bare: '',
  // The packaged host's index.html inline <style>, verbatim. The shared shell
  // loads no other host stylesheet (src/styles.css belongs to the legacy shell).
  androidHost: 'html, body { margin: 0; min-height: 100%; background: #0d1117; } #app { min-height: 100dvh; }',
};
async function buildRootChain(outDir) {
  const { build } = await import('vite');
  const vue = (await import('@vitejs/plugin-vue')).default;
  const ui = resolve(HERE, '..');
  const src = SRC;
  await build({
    root: ui,
    configFile: false,
    logLevel: 'error',
    plugins: [vue()],
    define: { 'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false' },
    resolve: {
      alias: [
        { find: /^@ui\/(.*)$/, replacement: `${src}/$1` },
        { find: /^@pocketshell\/core\/(.*)$/, replacement: `${resolve(ui, '../../src')}/$1` },
        { find: /^@pocketshell\/core$/, replacement: resolve(ui, '../../src/index.ts') },
      ],
    },
    build: {
      outDir, emptyOutDir: true, minify: false, cssCodeSplit: false,
      lib: { entry: join(ui, 'tests/fixtures/rootChainEntry.ts'), formats: ['iife'], name: 'RootChain', fileName: () => 'root-chain.js' },
    },
  });
  const cssFile = readdirSync(outDir).find((f) => f.endsWith('.css'));
  return { js: join(outDir, 'root-chain.js'), css: cssFile ? join(outDir, cssFile) : null };
}

function rootChainPage(built, hostCss, insets) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>${hostCss}</style>
${built.css ? `<link rel="stylesheet" href="file://${built.css}">` : ''}
<style>:root { --ps-inset-top:${insets.top}px; --ps-inset-bottom:${insets.bottom}px; --ps-inset-keyboard:${insets.keyboard}px; --ps-inset-left:0px; --ps-inset-right:0px; }</style>
</head><body><div id="app"></div>
<output id="result"></output>
<script src="file://${built.js}"></script>
<script>
(function poll(n) {
  const ws = document.querySelector('.workspace');
  if (!ws && n < 60) return setTimeout(() => poll(n + 1), 100);
  const out = { innerHeight, innerWidth, mounted: !!ws, errors: window.__rootChainErrors || [] };
  if (ws) {
    const r = ws.getBoundingClientRect();
    out.workspace = { top: r.top, bottom: r.bottom };
    // Last interactive control inside the workspace that is laid out.
    const ctl = [...ws.querySelectorAll('button, a[href], input, select, textarea, [role=button]')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; });
    const last = ctl.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
    if (last) {
      const b = last.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, Math.min(b.top + b.height / 2, innerHeight - 1));
      out.last = { desc: last.tagName + '.' + last.className, top: b.top, bottom: b.bottom, hitInside: !!hit && (last === hit || last.contains(hit)) };
    }
    out.bodyScroll = { scrollH: document.body.scrollHeight, clientH: document.body.clientHeight };
  }
  document.getElementById('result').setAttribute('data-result', JSON.stringify(out));
})(0);
</script></body></html>`;
}

const browser = findBrowser();
const tmp = mkdtempSync(join(homedir(), 'hit-targets-')); // snap Chromium cannot read /tmp

async function run(html, pointer, size = '412,915') {
  const file = join(tmp, `p${Math.random().toString(36).slice(2)}.html`);
  writeFileSync(file, html);
  const flags = [];
  if (pointer === 'coarse') flags.push('--blink-settings=primaryPointerType=2,availablePointerTypes=2,primaryHoverType=1,availableHoverTypes=1');
  if (pointer === 'fine') flags.push('--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2');
  const child = spawn(browser, ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', `--window-size=${size}`, '--virtual-time-budget=8000', ...flags, '--dump-dom', `file://${file}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', (c) => (stdout += c));
  child.stderr.setEncoding('utf8').on('data', (c) => (stderr += c));
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  const code = await new Promise((res, rej) => { child.once('error', rej); child.once('close', res); }).finally(() => clearTimeout(timer));
  if (code !== 0) throw new Error(`browser exited ${code}: ${stderr.slice(-800)}`);
  const m = stdout.match(/data-result="([^"]*)"/);
  if (!m) throw new Error(`no result marker:\n${stdout.slice(0, 500)}`);
  return JSON.parse(m[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
}

const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };
let assertions = 0;
const expect = (ok, msg) => { assertions += 1; check(ok, msg); };

try {
  const fine = await run(page('fine'), 'fine');
  const coarse = await run(page('coarse'), 'coarse');
  evidence.fine = fine;
  evidence.coarse = coarse;
  expect(fine.pointer.fine && !fine.pointer.coarse, `emulation: fine run did not match (pointer: fine): ${JSON.stringify(fine.pointer)}`);
  expect(coarse.pointer.coarse && !coarse.pointer.fine, `emulation: coarse run did not match (pointer: coarse): ${JSON.stringify(coarse.pointer)}`);

  if (WRITE) {
    writeFileSync(SNAPSHOT, JSON.stringify(fine.sizes, null, 2) + '\n');
    console.log(`wrote ${SNAPSHOT}`);
  } else {
    const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
    for (const key of Object.keys(SUBJECTS)) {
      expect(!!snap[key], `snapshot missing ${key}`);
      expect(JSON.stringify(fine.sizes[key]) === JSON.stringify(snap[key]), `fine ${key}: ${JSON.stringify(fine.sizes[key])} != snapshot ${JSON.stringify(snap[key])}`);
    }
    for (const key of Object.keys(snap)) expect(key in SUBJECTS, `snapshot has stale key ${key}`);
  }
  for (const key of Object.keys(SUBJECTS)) {
    const s = coarse.sizes[key];
    expect(s.h >= 48, `coarse ${key} height ${s.h} < 48`);
    if (!HEIGHT_ONLY.has(key)) expect(s.w >= 48, `coarse ${key} width ${s.w} < 48`);
  }

  // Workspace bottom edge vs the viewport, with insets (and with a keyboard).
  for (const insets of [{ top: 24, bottom: 48, keyboard: 0 }, { top: 24, bottom: 48, keyboard: 300 }]) {
    const ok = await run(workspacePage(insets, null), 'coarse');
    const limit = ok.viewport - insets.bottom - insets.keyboard;
    expect(ok.top >= insets.top - 0.5, `workspace top ${ok.top} above top inset ${insets.top}`);
    expect(ok.bottom <= limit + 0.5, `workspace bottom ${ok.bottom} past ${limit} (viewport ${ok.viewport}, ${JSON.stringify(insets)})`);
    expect(Math.abs(ok.bottom - limit) <= 0.5, `workspace bottom ${ok.bottom} does not reach ${limit}`);
    const old = await run(workspacePage(insets, '100vh'), 'coarse');
    evidence.workspace.push({ insets, height: workspaceHeight, shipped: ok, oldVh: old });
    expect(old.bottom > limit + 0.5, `negative control: 100vh bottom ${old.bottom} should overflow ${limit}`);
  }

  // The real chain, built once. Each scenario is a fresh page.
  const rcDir = join(tmp, 'rc');
  const built = await buildRootChain(rcDir);
  evidence.rootChain = [];
  const SCENARIOS = [
    // [label, window, insets, how the keyboard shows up]
    ['412x915 top52', '412,915', { top: 52, bottom: 0, keyboard: 0 }],
    ['412x915 top52 bottom48', '412,915', { top: 52, bottom: 48, keyboard: 0 }],
    ['360x800 top52', '360,800', { top: 52, bottom: 0, keyboard: 0 }],
    ['360x800 top52 bottom48', '360,800', { top: 52, bottom: 48, keyboard: 0 }],
    // IME up, platform resizes the WebView (visual viewport shrinks, token 0).
    ['412x915 IME resized 595', '412,595', { top: 52, bottom: 0, keyboard: 0 }],
    ['360x800 IME resized 480', '360,480', { top: 52, bottom: 0, keyboard: 0 }],
    // IME up as an overlay: the keyboard token reduces the available height.
    ['412x915 IME token 320', '412,915', { top: 52, bottom: 0, keyboard: 320 }],
    ['360x800 IME token 320', '360,800', { top: 52, bottom: 48, keyboard: 320 }],
  ];
  for (const [label, size, insets] of SCENARIOS) {
    for (const [hostName, hostCss] of Object.entries(HOST_PAGES)) {
      const r = await run(rootChainPage(built, hostCss, insets), 'coarse', size);
      evidence.rootChain.push({ label, host: hostName, insets, ...r });
      const tag = `[real chain ${hostName} ${label}]`;
      expect(r.mounted && r.errors.length === 0, `${tag} real HostWorkspaceView did not mount cleanly: ${JSON.stringify(r.errors)} mounted=${r.mounted}`);
      if (!r.mounted) continue;
      const limit = r.innerHeight - insets.bottom - insets.keyboard;
      expect(r.workspace.top >= insets.top - 0.5, `${tag} workspace top ${r.workspace.top} above top inset ${insets.top}`);
      expect(r.workspace.bottom <= r.innerHeight + 0.5, `${tag} workspace bottom ${r.workspace.bottom} > innerHeight ${r.innerHeight}`);
      expect(r.workspace.bottom <= limit + 0.5, `${tag} workspace bottom ${r.workspace.bottom} past ${limit} (bottom/keyboard insets)`);
      expect(!!r.last && r.last.bottom <= limit + 0.5 && r.last.hitInside, `${tag} last control not reachable: ${JSON.stringify(r.last)} limit ${limit}`);
    }
  }
} finally {
  if (OUT) writeFileSync(OUT, JSON.stringify(evidence, null, 2) + '\n');
  rmSync(tmp, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`hit targets FAILED (${failures.length}/${assertions}):\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`hit targets: OK assertions=${assertions}`);
