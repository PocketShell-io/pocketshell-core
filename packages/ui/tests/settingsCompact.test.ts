// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { useSettingsStore } from '../src/app/stores/settings';
import { provideApi } from '../src/app/ipc';
import type { PocketShellApi } from '../src/app/api';
import SettingsView from '../src/app/views/SettingsView.vue';

/**
 * #3139: a host that declares `app.desktopChrome === false` (Android) gets no
 * desktop-only settings or copy; a catch-all desktop double (every key a
 * function) keeps everything. jsdom has no layout, so the no-horizontal-overflow
 * and single-column assertions at 360 and 412 dp live in
 * settingsLayoutBrowser.test.ts (real Chromium).
 */
function desktopDouble(): PocketShellApi {
  const group = (name: string) => new Proxy({}, {
    get: (_t, key: string) => (name === 'ssh' && key === 'listConfigHosts' ? async () => [] : key.startsWith('on') ? () => () => undefined : async () => undefined),
  });
  return new Proxy({}, {
    get: (_t, name: string) => (name === 'hosts' || name === 'workspaces' ? undefined : group(name)),
  }) as unknown as PocketShellApi;
}

function androidDouble(): PocketShellApi {
  const base = desktopDouble();
  return new Proxy({}, {
    get: (_t, name: string) => (name === 'app' ? { onResumed: () => () => undefined, desktopChrome: false } : (base as never)[name]),
  }) as unknown as PocketShellApi;
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

describe('Settings without desktop chrome (Android)', () => {
  it('drops the Keyboard tab, the zoom row and the Follow-Windows theme copy', async () => {
    provideApi(androidDouble());
    const wrapper = mount(SettingsView);
    await flushPromises();
    expect(wrapper.findAll('[role=tab]').map((t) => t.text())).toEqual(['General', 'Sessions', 'Appearance', 'Advanced']);
    expect(wrapper.find('#settings-panel-keyboard').exists()).toBe(false);
    expect(wrapper.find('#zoom-label').exists()).toBe(false);
    const text = wrapper.text();
    expect(text).not.toContain('Follow Windows');
    expect(text).not.toContain('Ctrl');
    expect(text).not.toContain('Electron');
    wrapper.unmount();
  });

  it('a stored `system` theme still selects a visible, valid option (relabelled for the phone)', async () => {
    provideApi(androidDouble());
    useSettingsStore().set('theme', 'system');
    const wrapper = mount(SettingsView);
    await flushPromises();
    const select = wrapper.get('#theme-choice').element as HTMLSelectElement;
    expect(select.value).toBe('system');
    expect(select.selectedOptions[0]?.textContent?.trim()).toBe('Follow system');
    wrapper.unmount();
  });

  it('keeps all of it on a desktop host that does not declare the flag', async () => {
    provideApi(desktopDouble());
    const wrapper = mount(SettingsView);
    await flushPromises();
    expect(wrapper.findAll('[role=tab]').map((t) => t.text())).toContain('Keyboard');
    expect(wrapper.find('#zoom-label').exists()).toBe(true);
    expect(wrapper.text()).toContain('Follow Windows');
    wrapper.unmount();
  });
});
