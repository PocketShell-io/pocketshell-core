import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * NOT a measurement: a static proxy. The real computed-box check (headless
 * Chromium, emulated `pointer: coarse`, getBoundingClientRect, fine-pointer
 * snapshot from origin/main) is scripts/verify-hit-targets.mjs, run by
 * `npm test` after vitest. These cases are the fast, browserless guard on the
 * token values and on the "no per-component coarse blocks" rule.
 *
 * Token-resolution tests for the hit-target token. jsdom does not evaluate @media
 * rules, so the shipped CSS is read and its custom properties resolved here:
 * `fine` is the tokens with no media block applied, `coarse` adds the
 * `@media (pointer: coarse)` override. The sizes asserted for `fine` are the
 * numbers the app drew BEFORE --hit-min existed (a snapshot of today).
 */
const SRC = join(__dirname, '../src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

function blockBody(source: string, header: string): string {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, (c) => ' '.repeat(c.length));
  const start = css.indexOf(header);
  if (start < 0) throw new Error(`no block ${header}`);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error('unbalanced');
}

function decls(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const bare = body.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of bare.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

function tokens(mode: 'fine' | 'coarse'): Record<string, string> {
  const css = read('tokens.css');
  // The first :root block that carries the density tokens is the base.
  const base = decls(blockBody(css, ':root {\n  color-scheme'));
  if (mode === 'fine') return base;
  const coarse = decls(blockBody(blockBody(css, '@media (pointer: coarse)'), ':root'));
  return { ...base, ...coarse };
}

function px(value: string, vars: Record<string, string>): number {
  const v = value.replace(/var\((--[a-z0-9-]+)\)/g, (_, name: string) => {
    if (!(name in vars)) throw new Error(`unknown token ${name}`);
    return `(${vars[name]})`;
  });
  const max = /^max\((.+),(.+)\)$/.exec(v.trim());
  if (max) return Math.max(px(max[1]!, {}), px(max[2]!, {}));
  const n = /^\(*\s*(-?[\d.]+)px\s*\)*$/.exec(v.trim());
  if (!n) throw new Error(`cannot evaluate ${value}`);
  return Number(n[1]);
}

/** Box a rule gives an element: width/height, then lifted by min-*. */
function box(css: string, selector: string, vars: Record<string, string>, extra: string[] = []) {
  const d: Record<string, string> = { ...decls(blockBody(css, `${selector} {`)) };
  for (const e of extra) Object.assign(d, decls(blockBody(css, `${e} {`)));
  const size = (dim: 'width' | 'height'): number | null => {
    const set = d[dim] && !d[dim]!.endsWith('%') ? px(d[dim]!, vars) : null;
    const min = d[`min-${dim}`] ? px(d[`min-${dim}`]!, vars) : 0;
    return set === null ? (min > 0 ? min : null) : Math.max(set, min);
  };
  return { width: size('width'), height: size('height') };
}

const prim = read('primitives.css');
const rows = (() => {
  const vue = read('app/components/SessionTreeRowsView.vue');
  return vue.slice(vue.indexOf('<style'));
})();

describe('--hit-min and the coarse density tokens', () => {
  it('is zero on a fine pointer and 48px on a coarse one', () => {
    expect(px(tokens('fine')['--hit-min']!, {})).toBe(0);
    expect(px(tokens('coarse')['--hit-min']!, {})).toBe(48);
  });

  it('leaves every fine-pointer density token at today\'s value', () => {
    const t = tokens('fine');
    const num = (n: string) => px(t[n]!, t);
    expect({
      row: num('--row-h'),
      control: num('--control-h'),
      controlSm: num('--control-h-sm'),
      topbar: num('--topbar-h'),
      tabbar: num('--tabbar-h'),
    }).toEqual({ row: 28, control: 28, controlSm: 24, topbar: 40, tabbar: 32 });
  });

  it('raises the coarse density tokens as designed', () => {
    const t = tokens('coarse');
    const num = (n: string) => px(t[n]!, t);
    expect({ row: num('--row-h'), control: num('--control-h'), topbar: num('--topbar-h'), tabbar: num('--tabbar-h') }).toEqual({
      row: 48,
      control: 40,
      topbar: 56,
      tabbar: 44,
    });
  });

  describe('fine pointer: computed sizes equal today\'s (snapshot)', () => {
    const t = tokens('fine');
    it('.icon-btn is 28x28 and .icon-btn.sm is 24x24', () => {
      expect(box(prim, '.icon-btn', t)).toEqual({ width: 28, height: 28 });
      expect(box(prim, '.icon-btn', t, ['.icon-btn.sm'])).toEqual({ width: 24, height: 24 });
    });
    it('.btn-ghost is 28px high with no minimum width', () => {
      expect(box(prim, '.btn-ghost', t)).toEqual({ width: null, height: 28 });
    });
    it('list rows are 28px', () => {
      for (const sel of ['.folder-header', '.dir-header', '.session-leaf', '.empty-root']) {
        expect(box(rows, sel, t).height, sel).toBe(28);
      }
    });
  });

  describe('coarse pointer: every target is at least 48x48', () => {
    const t = tokens('coarse');
    it('.icon-btn, .icon-btn.sm', () => {
      expect(box(prim, '.icon-btn', t)).toEqual({ width: 48, height: 48 });
      expect(box(prim, '.icon-btn', t, ['.icon-btn.sm'])).toEqual({ width: 48, height: 48 });
    });
    it('.btn-ghost is 48 high and 48 wide at minimum', () => {
      expect(box(prim, '.btn-ghost', t)).toEqual({ width: 48, height: 48 });
    });
    it('list rows are 48 high', () => {
      for (const sel of ['.folder-header', '.dir-header', '.session-leaf', '.empty-root']) {
        expect(box(rows, sel, t).height, sel).toBeGreaterThanOrEqual(48);
      }
    });
    it('vault and trust-prompt controls keep their fine size and gain 48 on coarse', () => {
      const vault = read('app/components/vault/vault.css');
      const trust = read('app/components/HostKeyTrustPrompt.vue');
      const fine = tokens('fine');
      expect(box(vault, '.vault-btn', fine).height).toBe(28);
      expect(box(vault, '.vault-btn', t).height).toBe(48);
      expect(box(vault, '.vault-radio', t).height).toBe(48);
      expect(box(trust.slice(trust.indexOf('<style')), '.btn-primary,\n.btn-secondary', fine).height).toBe(28);
      expect(box(trust.slice(trust.indexOf('<style')), '.btn-primary,\n.btn-secondary', t).height).toBe(48);
    });
  });
});

describe('no per-component coarse blocks', () => {
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(vue|css)$/.test(name)) files.push(p);
    }
  })(SRC);

  it('only tokens.css decides touch density with `pointer: coarse`', () => {
    // HostKeyTrustPrompt keeps a coarse block for LAYOUT (one answer per row);
    // it must not size anything, checked below.
    const offenders = files.filter(
      (f) => /pointer:\s*coarse/.test(readFileSync(f, 'utf8')) && !f.endsWith('tokens.css') && !f.endsWith('HostKeyTrustPrompt.vue'),
    );
    expect(offenders).toEqual([]);
  });

  it('the trust prompt coarse block sets layout only, no min-height/height', () => {
    const vue = read('app/components/HostKeyTrustPrompt.vue');
    const body = blockBody(vue.slice(vue.indexOf('<style')), '@media (pointer: coarse)');
    expect(body).not.toMatch(/min-height|[^-]height\s*:/);
  });
});

describe('workspace height', () => {
  it('fills #app (the inset-padded body) instead of 100vh', () => {
    const vue = read('app/views/HostWorkspaceView.vue');
    const style = vue.slice(vue.indexOf('<style'));
    const d = decls(blockBody(style, '.workspace {'));
    expect(d.height).toBe('100%');
    expect(d.height).not.toMatch(/vh/);
    // The chain it relies on: html, body and #app are all 100% high, and the
    // inset padding lives on #app (border-box) with its min-height neutralised.
    const root = read('app/AppRoot.vue');
    const rootStyle = root.slice(root.indexOf('<style'));
    expect(decls(blockBody(rootStyle, 'html,\nbody {')).height).toBe('100%');
    const app = decls(blockBody(rootStyle, 'html body #app {'));
    expect(app.height).toBe('100%');
    expect(app['min-height']).toBe('0');
    expect(app.padding).toMatch(/--ps-inset-top/);
    expect(decls(blockBody(rootStyle, 'body {\n  background')).padding).toBeUndefined();
  });
});
