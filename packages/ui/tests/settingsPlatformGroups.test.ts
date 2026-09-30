// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import type { DiagnosticReport } from '@pocketshell/core';
import { provideApi } from '../src/app/ipc';
import type { PocketShellApi } from '../src/app/api';
import { useSettingsStore } from '../src/app/stores/settings';
import { registerSettingsSection } from '../src/app/settingsSections';
import SettingsPlatformGroups from '../src/app/components/settings/SettingsPlatformGroups.vue';

/** Desktop-style catch-all double: every `group.method` resolves undefined unless overridden. */
function catchAllTransport(overrides: Record<string, unknown> = {}): PocketShellApi {
  const group = (name: string) => new Proxy({}, {
    get: (_target, key: string) => (`${name}.${key}` in overrides
      ? overrides[`${name}.${key}`]
      : key.startsWith('on') ? () => () => undefined : async () => undefined),
  });
  return new Proxy({}, { get: (_target, name: string) => group(name) }) as unknown as PocketShellApi;
}

const REPORT: DiagnosticReport = { id: 'native:1', source: 'native-crash', at: 0, title: 'Native crash: IllegalStateException', body: 'trace' };

function androidTransport(reports: DiagnosticReport[] = [REPORT]): PocketShellApi {
  return {
    app: {
      onResumed: () => () => undefined,
      backgroundGrace: true,
      info: async () => ({ versionName: '0.6.0', versionCode: 612, applicationId: 'com.pocketshell.app' }),
    },
    diagnostics: {
      list: async () => reports,
      remove: async () => true,
      clear: async () => reports.length,
      share: async () => 'shared' as const,
    },
  } as unknown as PocketShellApi;
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

describe('Settings platform groups (0.5.x Connections, Advanced, Diagnostics, About)', () => {
  it('renders every group on a platform that declares grace, info and diagnostics', async () => {
    provideApi(androidTransport());
    const wrapper = mount(SettingsPlatformGroups);
    await flushPromises();
    expect(wrapper.find('[data-testid=settings-group-connections]').exists()).toBe(true);
    expect(wrapper.find('[data-testid=settings-group-advanced]').exists()).toBe(true);
    expect(wrapper.find('[data-testid=settings-group-diagnostics]').exists()).toBe(true);
    expect(wrapper.find('[data-testid=settings-installed-version]').text()).toBe('0.6.0 (612)');
    expect(wrapper.findAll('[data-testid=setting-background-grace] option').map((o) => o.element.getAttribute('value')))
      .toEqual(['30000', '60000', '90000', '300000', '600000']);
  });

  it('edits grace and reconnect-on-return in the one shared settings store', async () => {
    provideApi(androidTransport());
    const wrapper = mount(SettingsPlatformGroups);
    await flushPromises();
    const settings = useSettingsStore();
    await wrapper.find('[data-testid=setting-background-grace]').setValue('600000');
    expect(settings.backgroundGraceMs).toBe(600_000);
    await wrapper.find('[data-testid=setting-background-grace]').setValue('45000');
    expect(settings.backgroundGraceMs).toBe(600_000);
    const toggle = wrapper.find('[data-testid=setting-reconnect-on-return]');
    expect(toggle.attributes('aria-checked')).toBe('true');
    await toggle.trigger('click');
    expect(settings.reconnectOnReturn).toBe(false);
    expect(toggle.attributes('aria-checked')).toBe('false');
    expect(JSON.parse(localStorage.getItem('pocketshell.settings.v1') ?? '{}')).toMatchObject({ backgroundGraceMs: 600_000, reconnectOnReturn: false });
  });

  it('shows standard usage colours until a threshold is set, and resets both Advanced values', async () => {
    provideApi(androidTransport());
    const wrapper = mount(SettingsPlatformGroups);
    await flushPromises();
    const settings = useSettingsStore();
    const reset = wrapper.find('[data-testid=settings-reset-advanced]');
    expect(wrapper.find('[data-testid=setting-usage-warn-value]').text()).toBe('Standard');
    expect(reset.attributes('disabled')).toBeDefined();
    await wrapper.find('[data-testid=setting-usage-warn]').setValue('62');
    await wrapper.find('[data-testid=setting-enter-delay]').setValue('480');
    expect(settings.usageWarnPercent).toBe(60);
    expect(settings.submitEnterDelayMs).toBe(500);
    expect(wrapper.find('[data-testid=setting-usage-warn-value]').text()).toBe('60%');
    expect(wrapper.find('[data-testid=setting-enter-delay-value]').text()).toBe('500 ms');
    expect(reset.attributes('disabled')).toBeUndefined();
    await reset.trigger('click');
    expect(settings.usageWarnPercent).toBeNull();
    expect(settings.submitEnterDelayMs).toBe(250);
    expect(wrapper.find('[data-testid=setting-usage-warn-value]').text()).toBe('Standard');
  });

  it('renders registered platform sections as groups', async () => {
    provideApi(androidTransport());
    cleanups.push(registerSettingsSection({
      id: 'voice', title: 'Voice', component: defineComponent({ render: () => h('p', { 'data-testid': 'voice-body' }, 'dictation') }),
    }));
    const wrapper = mount(SettingsPlatformGroups);
    await flushPromises();
    const section = wrapper.find('[data-testid=settings-section-voice]');
    expect(section.find('.group-title').text()).toBe('Voice');
    expect(section.find('[data-testid=voice-body]').text()).toBe('dictation');
  });

  it('hides platform-only groups behind a catch-all double and a missing app group, without throwing', async () => {
    for (const transport of [catchAllTransport(), { diag: { log: vi.fn() } } as unknown as PocketShellApi]) {
      setActivePinia(createPinia());
      provideApi(transport);
      const wrapper = mount(SettingsPlatformGroups);
      await flushPromises();
      expect(wrapper.find('[data-testid=settings-group-connections]').exists()).toBe(false);
      expect(wrapper.find('[data-testid=settings-group-diagnostics]').exists()).toBe(false);
      expect(wrapper.find('[data-testid=settings-group-about]').exists()).toBe(false);
      expect(wrapper.find('[data-testid=settings-group-advanced]').exists()).toBe(true);
      wrapper.unmount();
    }
  });
});
