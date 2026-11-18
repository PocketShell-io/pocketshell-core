// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import OverlayPanel from '../src/app/components/OverlayPanel.vue';
import CommandPalette from '../src/app/components/CommandPalette.vue';
import PopupMenu from '../src/app/components/PopupMenu.vue';
import SettingsView from '../src/app/views/SettingsView.vue';
import NewSessionDialog from '../src/app/components/NewSessionDialog.vue';
import { provideApi } from '../src/app/ipc';
import type { PocketShellApi } from '../src/app/api';
import type { PaletteCommand } from '../src/app/commandPalette';

/**
 * #3123 S4a: compact sheets. A matchMedia that answers by width AND pointer, so
 * each rule is asserted both ways: the compact/coarse output AND the unchanged
 * expanded/fine output. (Real computed boxes: compactSheetsBrowser.test.ts.)
 */
function media(width: number, coarse: boolean): void {
  const mm = (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query)?.[1];
    const matches = max ? width <= Number(max) : /pointer:\s*coarse/.test(query) ? coarse : false;
    return { matches, media: query, addEventListener: () => undefined, removeEventListener: () => undefined };
  };
  vi.stubGlobal('matchMedia', mm);
  Object.defineProperty(window, 'matchMedia', { value: mm, configurable: true, writable: true });
}
const PHONE = (): void => media(360, true);
const DESKTOP = (): void => media(1280, false);

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'matchMedia');
  document.body.innerHTML = '';
});

describe('OverlayPanel', () => {
  it('compact: a full-screen page with a Back arrow that closes; no X', async () => {
    PHONE();
    const w = mount(OverlayPanel, { props: { title: 'Ports' }, attachTo: document.body });
    // Teleported to body on compact: positioned against the viewport, not the opener's panel.
    expect(w.find('.overlay-panel').exists()).toBe(false);
    expect(document.body.querySelector('.overlay-panel')!.classList).toContain('compact');
    const back = document.body.querySelector('button[aria-label="Back"]') as HTMLElement;
    expect(back).not.toBeNull();
    expect(back.querySelector('svg')).not.toBeNull();
    expect(document.body.querySelector('button[title="Close"]')).toBeNull();
    back.click();
    expect(w.emitted('close')).toHaveLength(1);
    w.unmount();
  });

  it('expanded: unchanged - X close, no Back, no compact class', () => {
    DESKTOP();
    const w = mount(OverlayPanel, { props: { title: 'Ports', size: 'md' }, attachTo: document.body });
    expect(w.find('.overlay-panel').classes()).toEqual(['overlay-panel', 'md']);
    expect(w.find('button[title="Close"]').exists()).toBe(true);
    expect(w.find('button[aria-label="Back"]').exists()).toBe(false);
    w.unmount();
  });
});

const COMMANDS: PaletteCommand[] = [
  { id: 'a', label: 'Open Files', group: 'Go', run: vi.fn() },
  { id: 'b', label: 'Open Ports', group: 'Go', run: vi.fn() },
];

describe('CommandPalette', () => {
  it('compact: a bottom sheet that does not raise the keyboard on open', async () => {
    PHONE();
    const w = mount(CommandPalette, { props: { commands: COMMANDS }, attachTo: document.body });
    await nextTick();
    await nextTick();
    expect(document.querySelector('.command-palette')!.classList).toContain('sheet');
    expect(document.activeElement).not.toBe(document.querySelector('.palette-input'));
    w.unmount();
  });

  it('compact: a keyboard-driven resize or an in-list scroll does not dismiss it', async () => {
    PHONE();
    const w = mount(CommandPalette, { props: { commands: COMMANDS }, attachTo: document.body });
    window.dispatchEvent(new Event('resize'));
    document.querySelector('.palette-list')!.dispatchEvent(new Event('scroll'));
    expect(w.emitted('close')).toBeUndefined();
    w.unmount();
  });

  it('expanded: unchanged - top-centre surface, input focused, resize closes', async () => {
    DESKTOP();
    const w = mount(CommandPalette, { props: { commands: COMMANDS }, attachTo: document.body });
    await nextTick();
    await nextTick();
    expect(document.querySelector('.command-palette')!.classList).not.toContain('sheet');
    expect(document.activeElement).toBe(document.querySelector('.palette-input'));
    window.dispatchEvent(new Event('resize'));
    expect(w.emitted('close')).toHaveLength(1);
    w.unmount();
  });
});

describe('PopupMenu', () => {
  const anchor = { left: 100, top: 100, width: 20, height: 20 };
  it('compact + touch: a bottom sheet with a scrim; tapping the scrim closes', async () => {
    PHONE();
    const w = mount(PopupMenu, { props: { anchor }, slots: { default: '<button class="menu-item">Rename</button>' }, attachTo: document.body });
    await nextTick();
    await nextTick();
    const menu = document.querySelector('.popup-menu') as HTMLElement;
    expect(menu.classList).toContain('sheet');
    expect(menu.style.left).toBe('');
    expect(menu.style.visibility).toBe('');
    const scrim = document.querySelector('.popup-scrim') as HTMLElement;
    expect(scrim).not.toBeNull();
    scrim.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(w.emitted('close')).toHaveLength(1);
    w.unmount();
  });

  it('compact: scrolling inside the sheet does not close it', async () => {
    PHONE();
    const w = mount(PopupMenu, { props: { anchor }, slots: { default: '<button class="menu-item">x</button>' }, attachTo: document.body });
    await nextTick();
    document.querySelector('.popup-menu')!.dispatchEvent(new Event('scroll'));
    expect(w.emitted('close')).toBeUndefined();
    w.unmount();
  });

  it.each([
    ['desktop', DESKTOP],
    ['a narrow window with a mouse (compact width, fine pointer)', () => media(360, false)],
  ])('%s: unchanged - anchored at the click point, no sheet, no scrim', async (_n, setup) => {
    setup();
    const w = mount(PopupMenu, { props: { anchor }, slots: { default: '<button class="menu-item">x</button>' }, attachTo: document.body });
    await nextTick();
    await nextTick();
    const menu = document.querySelector('.popup-menu') as HTMLElement;
    expect(menu.classList).not.toContain('sheet');
    expect(menu.style.left).not.toBe('');
    expect(document.querySelector('.popup-scrim')).toBeNull();
    w.unmount();
  });
});

function desktopDouble(desktopChrome: boolean): PocketShellApi {
  const group = (name: string) => new Proxy({}, {
    get: (_t, key: string) => (name === 'ssh' && key === 'listConfigHosts' ? async () => [] : key.startsWith('on') ? () => () => undefined : async () => undefined),
  });
  return new Proxy({}, {
    get: (_t, name: string) =>
      name === 'app' ? { onResumed: () => () => undefined, desktopChrome }
      : name === 'hosts' || name === 'workspaces' ? undefined : group(name),
  }) as unknown as PocketShellApi;
}

describe('Settings keyboard shortcuts (K2)', () => {
  it('compact: one "Keyboard shortcuts" row; the editor stays collapsed until opened', async () => {
    PHONE();
    provideApi(desktopDouble(true));
    const w = mount(SettingsView, { attachTo: document.body });
    await flushPromises();
    const panel = w.get('#settings-panel-keyboard');
    expect(panel.find('.keyboard').exists()).toBe(false);
    const row = panel.get('button.shortcuts-row');
    expect(row.text()).toContain('Keyboard shortcuts');
    expect(row.attributes('aria-expanded')).toBe('false');
    await row.trigger('click');
    expect(panel.find('.keyboard').exists()).toBe(true);
    expect(panel.get('button.shortcuts-row').attributes('aria-expanded')).toBe('true');
    w.unmount();
  });

  it('expanded: unchanged - the editor renders straight away, no row', async () => {
    DESKTOP();
    provideApi(desktopDouble(true));
    const w = mount(SettingsView, { attachTo: document.body });
    await flushPromises();
    expect(w.find('#settings-panel-keyboard .keyboard').exists()).toBe(true);
    expect(w.find('button.shortcuts-row').exists()).toBe(false);
    w.unmount();
  });
});

describe('NewSessionDialog', () => {
  async function open() {
    provideApi(desktopDouble(true));
    const w = mount(NewSessionDialog, { attachTo: document.body });
    await flushPromises();
    await nextTick();
    return w;
  }

  it('compact: short non-wrapping route labels, full labels kept for assistive tech, no keyboard on open', async () => {
    PHONE();
    const w = await open();
    const tabs = [...document.body.querySelectorAll('[role=tab]')];
    expect(tabs.map((t) => t.textContent?.trim())).toEqual(['Existing', 'New', 'Clone']);
    expect(tabs.map((t) => t.getAttribute('aria-label'))).toEqual(['Existing folder', 'New folder', 'Clone from GitHub']);
    expect(document.activeElement).not.toBe(document.body.querySelector('input[aria-label="Search folders in this directory"]'));
    w.unmount();
  });

  it('expanded: unchanged - full labels, search focused on open', async () => {
    DESKTOP();
    const w = await open();
    expect(w.findAll('[role=tab]').map((t) => t.text())).toEqual(['Existing folder', 'New folder', 'Clone from GitHub']);
    expect(w.find('[role=tab]').attributes('aria-label')).toBeUndefined();
    expect(document.activeElement).toBe(w.find('input[aria-label="Search folders in this directory"]').element);
    w.unmount();
  });
});
