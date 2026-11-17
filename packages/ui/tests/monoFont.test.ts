// @vitest-environment jsdom
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import {
  BUNDLED_MONO_FAMILY,
  BUNDLED_MONO_STACK,
  DEFAULT_MONO_STACK,
  MONOSPACE_FAMILIES,
  TERMINAL_FONT_SIZE_COMPACT_DEFAULT,
  TERMINAL_FONT_SIZE_DEFAULT,
  fontCssVariables,
  remeasureAfterFontLoad,
  resolveMonoStack,
  terminalFontSizeDefault,
} from '@ui/fonts';
import { bundledOnlyFontProfile, provideFontProfile } from '@ui/app/fontProfile';
import { settingsDefaults } from '@ui/app/stores/settings';
import SettingsMonospaceGroup from '@ui/app/components/settings/SettingsMonospaceGroup.vue';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

afterEach(() => {
  provideFontProfile();
  vi.unstubAllGlobals();
});

describe('bundled monospace face (#3138): stack resolution', () => {
  it('is the first family of the default stack, the phone stack and --font-mono', () => {
    expect(DEFAULT_MONO_STACK.startsWith(`'${BUNDLED_MONO_FAMILY}'`)).toBe(true);
    expect(BUNDLED_MONO_STACK).toBe(`'${BUNDLED_MONO_FAMILY}', ui-monospace, monospace`);
    expect(resolveMonoStack(null)).toBe(DEFAULT_MONO_STACK);
    const vars = fontCssVariables({ monospaceFontFamily: null, terminalFontSize: 13, editorFontSize: 13 });
    expect(vars['--font-mono']!.startsWith(`'${BUNDLED_MONO_FAMILY}'`)).toBe(true);
    expect(MONOSPACE_FAMILIES[0]).toBe(BUNDLED_MONO_FAMILY);
  });

  it('keeps a chosen family first and the bundled face behind it', () => {
    expect(resolveMonoStack('Fira Code', BUNDLED_MONO_STACK)).toBe(`"Fira Code", ${BUNDLED_MONO_STACK}`);
    expect(resolveMonoStack(null, BUNDLED_MONO_STACK)).toBe(BUNDLED_MONO_STACK);
    expect(BUNDLED_MONO_STACK).not.toContain('Consolas');
  });

  it('declares both weights in fonts.css pointing at real, complete woff2 files', () => {
    const css = readFileSync(resolve(SRC, 'fonts.css'), 'utf8');
    expect(css).toMatch(/font-family:\s*'JetBrains Mono'[^}]*font-weight:\s*400/);
    expect(css).toMatch(/font-family:\s*'JetBrains Mono'[^}]*font-weight:\s*700/);
    expect(css).toMatch(/--font-mono:\s*'JetBrains Mono'/);
    expect(readFileSync(resolve(SRC, 'styles.css'), 'utf8')).toContain("@import './fonts.css'");
    const urls = [...css.matchAll(/url\('([^']+\.woff2)'\)/g)].map((m) => m[1]!);
    expect(urls).toHaveLength(2);
    for (const url of urls) {
      const file = resolve(SRC, url);
      expect(existsSync(file)).toBe(true);
      // A subset is ~20KB and lacks box-drawing; the complete face is ~90KB.
      expect(statSync(file).size).toBeGreaterThan(80_000);
      expect(readFileSync(file).subarray(0, 4).toString('latin1')).toBe('wOF2');
    }
    expect(existsSync(resolve(SRC, 'assets/fonts/JetBrainsMono-OFL.txt'))).toBe(true);
  });
});

describe('terminal default size follows the layout', () => {
  it('maps compact to 13 and wide to the unchanged 16', () => {
    expect(terminalFontSizeDefault(true)).toBe(TERMINAL_FONT_SIZE_COMPACT_DEFAULT);
    expect(TERMINAL_FONT_SIZE_COMPACT_DEFAULT).toBe(13);
    expect(terminalFontSizeDefault(false)).toBe(TERMINAL_FONT_SIZE_DEFAULT);
    expect(TERMINAL_FONT_SIZE_DEFAULT).toBe(16);
  });

  it('settingsDefaults() picks 13 at a phone width and 16 at a desktop width', () => {
    const at = (narrow: boolean) => vi.stubGlobal('matchMedia', (q: string) => ({
      matches: narrow && q.includes('max-width: 640px'), media: q,
      addEventListener() {}, removeEventListener() {},
    }));
    at(true);
    expect(settingsDefaults().terminalFontSize).toBe(13);
    at(false);
    expect(settingsDefaults().terminalFontSize).toBe(16);
  });

  it('13px of a 0.6em face fits 50 columns across a full-width 412dp (the rail-framed layout is narrower)', () => {
    expect(Math.floor((412 - 16) / (0.6 * TERMINAL_FONT_SIZE_COMPACT_DEFAULT))).toBeGreaterThanOrEqual(50);
  });
});

describe('remeasureAfterFontLoad', () => {
  it('waits for the face, bounces the font option so xterm re-measures, then refits', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const load = vi.fn(() => gate.then(() => []));
    vi.stubGlobal('document', Object.assign(Object.create(document), {}));
    Object.defineProperty(document, 'fonts', { configurable: true, value: { load, ready: Promise.resolve() } });
    const seen: string[] = [];
    let family = BUNDLED_MONO_STACK;
    const term = { options: { get fontFamily() { return family; }, set fontFamily(v: string) { seen.push(v); family = v; } } };
    const refit = vi.fn();
    const done = remeasureAfterFontLoad(term, BUNDLED_MONO_STACK, 13, refit);
    await Promise.resolve();
    expect(load).toHaveBeenCalledWith("400 13px 'JetBrains Mono'");
    expect(load).toHaveBeenCalledWith("700 13px 'JetBrains Mono'");
    expect(refit).not.toHaveBeenCalled();
    expect(seen).toEqual([]); // nothing re-measured before the face is ready
    release();
    await done;
    expect(seen).toEqual([`${BUNDLED_MONO_STACK}, monospace`, BUNDLED_MONO_STACK]);
    expect(family).toBe(BUNDLED_MONO_STACK);
    expect(refit).toHaveBeenCalledTimes(1);
  });

  it('still refits when the FontFaceSet API is missing or the load rejects', async () => {
    Object.defineProperty(document, 'fonts', { configurable: true, value: { load: () => Promise.reject(new Error('x')), ready: Promise.resolve() } });
    const refit = vi.fn();
    await remeasureAfterFontLoad({ options: { fontFamily: 'a' } }, 'a', 13, refit);
    expect(refit).toHaveBeenCalledTimes(1);
  });
});

describe('Settings font picker per client profile', () => {
  beforeEach(() => { setActivePinia(createPinia()); localStorage.clear(); });

  it('desktop: free-text input with the suggestions, defaulting to the bundled face', () => {
    const w = mount(SettingsMonospaceGroup);
    expect(w.find('input#mono-family').exists()).toBe(true);
    expect(w.find('input#mono-family').attributes('placeholder')).toBe('JetBrains Mono (default)');
    expect(w.text()).not.toContain('falls back to Consolas');
  });

  it('phone: only bundled fonts, no Consolas copy, no free text', () => {
    provideFontProfile(bundledOnlyFontProfile(BUNDLED_MONO_STACK));
    const w = mount(SettingsMonospaceGroup);
    expect(w.find('input#mono-family').exists()).toBe(false);
    expect(w.find('datalist').exists()).toBe(false);
    const options = w.findAll('select#mono-family option').map((o) => o.text());
    expect(options).toEqual(['JetBrains Mono (default)']);
    expect(w.text()).not.toContain('Consolas');
    expect(w.get('[data-testid="mono-family-hint"]').text()).toContain('bundled');
  });
});
