// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { provideApi } from '../src/app/ipc';
import type { PocketShellApi } from '../src/app/api';
import SettingsView from '../src/app/views/SettingsView.vue';

/**
 * #3139: a host that declares `app.desktopChrome === false` (Android) gets no
 * desktop-only settings or copy; a catch-all desktop double (every key a
 * function) keeps everything. jsdom has no layout, so the no-horizontal-overflow
 * assertion (scrollWidth <= clientWidth at 360 and 412) runs in real Chromium:
 * the host app's settings-compact-overflow check. Here the compact-width CSS
 * that makes it true is pinned at the source.
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

describe('Settings compact layout source', () => {
  const read = (rel: string) => readFileSync(join(__dirname, '../src/app', rel), 'utf8');

  it('stacks rows to one column at phone width in the view and the shared group css', () => {
    for (const file of ['views/SettingsView.vue', 'components/settings/settingsGroup.css']) {
      const css = read(file);
      const media = css.slice(css.indexOf('@media (max-width: 480px)'));
      expect(media, file).toMatch(/\.row\s*\{[^}]*flex-direction:\s*column/);
      expect(media, file).toMatch(/\.row-hint\s*\{[^}]*max-width:\s*none/);
    }
  });

  it('lets the tab strip scroll inside itself instead of widening the body', () => {
    const tabs = read('components/settings/SettingsTabs.vue');
    expect(tabs).toMatch(/\.strip\s*\{[^}]*overflow-x:\s*auto/);
    expect(tabs).toMatch(/\.tab\s*\{[^}]*flex:\s*none/);
  });
});
