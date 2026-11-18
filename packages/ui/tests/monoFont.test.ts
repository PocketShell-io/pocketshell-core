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
  SYMBOL_FALLBACK_FAMILY,
  TERMINAL_FONT_SIZE_COMPACT_DEFAULT,
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_SYMBOL_PROBE,
  COMPACT_FONT_SIZE_STEP,
  monoStackFor,
  withSymbolFallback,
  FONT_SIZE_STEP,
  clampFontSize,
  fontCssVariables,
  parseCompactFontSize,
  parseFontSize,
  remeasureAfterFontLoad,
  resolveMonoStack,
  terminalFontSizeFor,
} from '@ui/fonts';
import { bundledOnlyFontProfile, provideFontProfile } from '@ui/app/fontProfile';
import { coerceSettings, settingsDefaults } from '@ui/app/stores/settings';
import { woff2CodePoints } from './support/woff2Cmap';
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
    const urls = [...css.matchAll(/url\('([^']+JetBrainsMono-[^']+\.woff2)'\)/g)].map((m) => m[1]!);
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

describe('terminal size per layout (#3157: Termius density on a phone)', () => {
  it('ships 12px for compact and the unchanged 16px elsewhere, as two settings', () => {
    expect(TERMINAL_FONT_SIZE_COMPACT_DEFAULT).toBe(12);
    expect(TERMINAL_FONT_SIZE_DEFAULT).toBe(16);
    const defaults = settingsDefaults();
    expect(defaults.terminalFontSize).toBe(16);
    expect(defaults.compactTerminalFontSize).toBe(12);
    expect(terminalFontSizeFor(defaults, true)).toBe(12);
    expect(terminalFontSizeFor(defaults, false)).toBe(16);
  });

  it('defaults do not depend on the viewport the store boots in', () => {
    const at = (narrow: boolean) => vi.stubGlobal('matchMedia', (q: string) => ({
      matches: narrow && q.includes('max-width: 640px'), media: q,
      addEventListener() {}, removeEventListener() {},
    }));
    at(true);
    const phone = settingsDefaults();
    at(false);
    expect(settingsDefaults()).toEqual(phone);
  });

  it('migrates a phone whose stored blob carries the 16px an earlier build persisted: compact gets 12', () => {
    // The maintainer's phone: every setting write persisted the whole object,
    // so `terminalFontSize: 16` was stored without ever being chosen (#3157).
    const stored = coerceSettings({ terminalFontSize: 16, theme: 'dark' });
    expect(terminalFontSizeFor(stored, true)).toBe(12);
    expect(terminalFontSizeFor(stored, false)).toBe(16);
    // A phone size the user did choose is kept.
    expect(terminalFontSizeFor(coerceSettings({ compactTerminalFontSize: 14 }), true)).toBe(14);
  });

  it('the phone terminal size steps by half a pixel; every other size stays whole', () => {
    expect(COMPACT_FONT_SIZE_STEP).toBe(0.5);
    expect(parseCompactFontSize('11.5')).toBe(11.5);
    expect(parseCompactFontSize(11.3)).toBe(11.5);
    expect(parseCompactFontSize(11.2)).toBe(11);
    expect(parseCompactFontSize(4)).toBe(8);
    expect(coerceSettings({ compactTerminalFontSize: 12.5 }).compactTerminalFontSize).toBe(12.5);
    expect(coerceSettings({ terminalFontSize: 12.5, editorFontSize: 13.5 })).toMatchObject({ terminalFontSize: 13, editorFontSize: 14 });
  });

  it('12px of the 0.6em face (7.2px cell) is 56 columns across 411dp with the 2px compact gutters', () => {
    const cell = 0.6 * TERMINAL_FONT_SIZE_COMPACT_DEFAULT;
    const columns = Math.floor((411 - 2 - 2) / cell);
    expect(columns).toBe(56);
    expect(columns).toBeGreaterThanOrEqual(55);
    expect(columns).toBeLessThanOrEqual(60);
  });
});

describe('symbol fallback (#3157): no .notdef for what terminal agent UIs draw', () => {
  const read = (name: string) => readFileSync(resolve(SRC, 'assets/fonts', name));

  it('JetBrains Mono plus PocketShell Symbols map every probe character to a real glyph', () => {
    const mono = woff2CodePoints(read('JetBrainsMono-Regular.woff2'));
    const symbols = woff2CodePoints(read('PocketShellSymbols-Regular.woff2'));
    const probe = [...TERMINAL_SYMBOL_PROBE];
    expect(probe).toContain('⏵');
    const tofu = probe.filter((c) => !mono.has(c.codePointAt(0)!) && !symbols.has(c.codePointAt(0)!));
    expect(tofu).toEqual([]);
  });

  it('JetBrains Mono alone leaves the reported symbols as tofu (the fallback is load-bearing)', () => {
    const mono = woff2CodePoints(read('JetBrainsMono-Regular.woff2'));
    for (const c of '⏵✻⎿⧉') expect(mono.has(c.codePointAt(0)!)).toBe(false);
  });

  it('the fallback never answers letters, digits or box drawing (those stay JetBrains Mono)', () => {
    const symbols = woff2CodePoints(read('PocketShellSymbols-Regular.woff2'));
    for (const c of 'Aa0 │─╭') expect(symbols.has(c.codePointAt(0)!)).toBe(false);
  });

  it('is declared in fonts.css and joins the stack right after its first family on compact only', () => {
    const css = readFileSync(resolve(SRC, 'fonts.css'), 'utf8');
    expect(css).toMatch(/font-family:\s*'PocketShell Symbols'[^}]*unicode-range:/);
    expect(css).toContain("url('./assets/fonts/PocketShellSymbols-Regular.woff2')");
    expect(existsSync(resolve(SRC, 'assets/fonts/PocketShellSymbols-OFL.txt'))).toBe(true);
    const phone = `'${BUNDLED_MONO_FAMILY}', '${SYMBOL_FALLBACK_FAMILY}', ui-monospace, monospace`;
    expect(monoStackFor(null, BUNDLED_MONO_STACK, true)).toBe(phone);
    expect(monoStackFor(null, BUNDLED_MONO_STACK, false)).toBe(BUNDLED_MONO_STACK);
    expect(monoStackFor('Fira Code', BUNDLED_MONO_STACK, true))
      .toBe(`"Fira Code", '${SYMBOL_FALLBACK_FAMILY}', ${BUNDLED_MONO_STACK}`);
    expect(withSymbolFallback(phone)).toBe(phone); // idempotent
    const vars = fontCssVariables({ monospaceFontFamily: null, terminalFontSize: 12, editorFontSize: 13 }, BUNDLED_MONO_STACK, true);
    expect(vars['--font-mono']).toBe(phone);
  });
});

describe('D44: the phone slice (#3157) leaves the desktop exactly as it was', () => {
  // The pre-#3157 values, verbatim from core 7f40097.
  const BASE_DESKTOP_STACK = "'JetBrains Mono', Consolas, 'Cascadia Mono', ui-monospace, monospace";

  afterEach(() => { vi.unstubAllGlobals(); });

  it('pins the desktop mono stack, --font-mono default and the font variables', () => {
    expect(DEFAULT_MONO_STACK).toBe(BASE_DESKTOP_STACK);
    expect(resolveMonoStack(null)).toBe(BASE_DESKTOP_STACK);
    const css = readFileSync(resolve(SRC, 'fonts.css'), 'utf8');
    expect(css).toMatch(new RegExp(`--font-mono:\\s*${BASE_DESKTOP_STACK.replace(/[()]/g, '\\$&')};`));
    const vars = fontCssVariables({ monospaceFontFamily: null, terminalFontSize: 16, editorFontSize: 13 });
    expect(vars).toEqual({ '--font-mono': BASE_DESKTOP_STACK, '--term-font-size': '16px', '--code-font-size': '13px' });
    // Wide rendering on a phone/tablet (the Android profile at > 640px) is unchanged too.
    const BASE_PHONE_STACK = "'JetBrains Mono', ui-monospace, monospace";
    expect(BUNDLED_MONO_STACK).toBe(BASE_PHONE_STACK);
    expect(fontCssVariables({ monospaceFontFamily: null, terminalFontSize: 16, editorFontSize: 13 }, BUNDLED_MONO_STACK)['--font-mono'])
      .toBe(BASE_PHONE_STACK);
    expect(monoStackFor(null, undefined, false)).toBe(BASE_DESKTOP_STACK);
  });

  it('pins whole-pixel desktop sizes: step 1, round-to-whole clamp, 16px terminal default', () => {
    expect(FONT_SIZE_STEP).toBe(1);
    expect(clampFontSize(11.5)).toBe(12);
    expect(clampFontSize(11.2)).toBe(11);
    expect(parseFontSize('12.5')).toBe(13);
    expect(parseFontSize(4)).toBe(8);
    expect(settingsDefaults().terminalFontSize).toBe(16);
    expect(settingsDefaults().editorFontSize).toBe(13);
  });

  it('desktop Settings: whole-pixel steppers on the desktop terminal and editor sizes', async () => {
    setActivePinia(createPinia());
    localStorage.clear();
    const w = mount(SettingsMonospaceGroup);
    try {
      const terminal = w.get('input#terminal-size');
      expect(terminal.attributes('step')).toBe('1');
      expect((terminal.element as HTMLInputElement).value).toBe('16');
      expect(w.get('input#editor-size').attributes('step')).toBe('1');
      expect(w.find('[data-testid="terminal-size-compact-hint"]').exists()).toBe(false);
      (terminal.element as HTMLInputElement).value = '14.5';
      await terminal.trigger('change');
      const { useSettingsStore } = await import('@ui/app/stores/settings');
      expect(useSettingsStore().terminalFontSize).toBe(15);
    } finally {
      w.unmount(); // releases the shared layout-class listeners even on failure
    }
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
    let family = withSymbolFallback(BUNDLED_MONO_STACK);
    const term = { options: { get fontFamily() { return family; }, set fontFamily(v: string) { seen.push(v); family = v; } } };
    const refit = vi.fn();
    const done = remeasureAfterFontLoad(term, withSymbolFallback(BUNDLED_MONO_STACK), 13, refit);
    await Promise.resolve();
    expect(load).toHaveBeenCalledWith("400 13px 'JetBrains Mono'", undefined);
    expect(load).toHaveBeenCalledWith("700 13px 'JetBrains Mono'", undefined);
    // The symbol face loads up front with a symbol sample: its unicode-range
    // would skip the default space sample, and xterm caches glyph widths.
    expect(load).toHaveBeenCalledWith("400 13px 'PocketShell Symbols'", TERMINAL_SYMBOL_PROBE);
    expect(refit).not.toHaveBeenCalled();
    expect(seen).toEqual([]); // nothing re-measured before the face is ready
    release();
    await done;
    const compactStack = withSymbolFallback(BUNDLED_MONO_STACK);
    expect(seen).toEqual([`${compactStack}, monospace`, compactStack]);
    expect(family).toBe(compactStack);
    expect(refit).toHaveBeenCalledTimes(1);
  });

  it('writes nothing and does not throw when the terminal is disposed before the face resolves', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    Object.defineProperty(document, 'fonts', { configurable: true, value: { load: () => gate.then(() => []), ready: Promise.resolve() } });
    let disposed = false;
    const writes: string[] = [];
    const term = { options: {
      get fontFamily() { if (disposed) throw new Error('disposed'); return 'a'; },
      set fontFamily(v: string) { if (disposed) throw new Error('disposed'); writes.push(v); },
    } };
    const refit = vi.fn();
    const done = remeasureAfterFontLoad(term, 'a', 13, refit, () => disposed);
    disposed = true;
    release();
    await expect(done).resolves.toBeUndefined();
    expect(writes).toEqual([]);
    expect(refit).not.toHaveBeenCalled();
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
    w.unmount(); // releases the shared layout-class listeners for the next test
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
    w.unmount();
  });

  it('compact layout: the terminal size control edits the phone size, in half pixels (#3157)', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('max-width: 640px') || q.includes('max-width: 900px'), media: q,
      addEventListener() {}, removeEventListener() {},
    }));
    const { useSettingsStore } = await import('@ui/app/stores/settings');
    const settings = useSettingsStore();
    const w = mount(SettingsMonospaceGroup);
    const input = w.get('input#terminal-size');
    expect(input.attributes('step')).toBe('0.5');
    expect((input.element as HTMLInputElement).value).toBe('12');
    expect(w.find('[data-testid="terminal-size-compact-hint"]').exists()).toBe(true);
    (input.element as HTMLInputElement).value = '12.5';
    await input.trigger('change');
    expect(settings.compactTerminalFontSize).toBe(12.5);
    expect(settings.terminalFontSize).toBe(16);
    w.unmount();
  });

  it('a phone size chosen in Settings survives a restart: a fresh store reads it back from storage (#3157)', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('max-width: 640px') || q.includes('max-width: 900px'), media: q,
      addEventListener() {}, removeEventListener() {},
    }));
    const { useSettingsStore } = await import('@ui/app/stores/settings');
    const w = mount(SettingsMonospaceGroup);
    const input = w.get('input#terminal-size');
    (input.element as HTMLInputElement).value = '11.5';
    await input.trigger('change');
    w.unmount();
    // What is on disk now is what the next launch boots from.
    const stored = JSON.parse(localStorage.getItem('pocketshell.settings.v1')!);
    expect(stored.compactTerminalFontSize).toBe(11.5);
    expect(stored.terminalFontSize).toBe(16);
    // A restart: a new Pinia, so a new store constructed from storage alone.
    setActivePinia(createPinia());
    const restarted = useSettingsStore();
    expect(restarted.compactTerminalFontSize).toBe(11.5);
    expect(restarted.terminalFontSize).toBe(16);
    expect(terminalFontSizeFor(restarted, true)).toBe(11.5);
    expect(terminalFontSizeFor(restarted, false)).toBe(16);
    // And the Settings control shows the kept value.
    const again = mount(SettingsMonospaceGroup);
    expect((again.get('input#terminal-size').element as HTMLInputElement).value).toBe('11.5');
    again.unmount();
  });
});
