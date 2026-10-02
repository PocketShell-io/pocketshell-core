// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { provideApi } from '../src/app/ipc';
import type { PocketShellApi } from '../src/app/api';
import { provideExtensions } from '../src/app/extensions';
import { useSettingsStore } from '../src/app/stores/settings';
import SettingsView from '../src/app/views/SettingsView.vue';

/**
 * The Settings overlay's tabs: General / Sessions / Appearance / Keyboard /
 * Advanced. The panels are v-show — mounted for the overlay's whole life — so
 * the assertions below are about what is SELECTED and what is REACHABLE, not
 * about what exists: everything always exists. Harness follows
 * settingsPlatformGroups.test.ts (the same catch-all transport double).
 */

/**
 * Desktop-style catch-all double: every `group.method` resolves undefined
 * unless overridden. Groups named in `missing` are absent entirely (the double
 * would otherwise fake `api.hosts.store`, sending loadHosts down the
 * store-owned branch instead of listConfigHosts, and fake `api.workspaces`,
 * making the roots section read as host-managed and read-only before any
 * connection); desktop's shape — no hosts store, no workspaces, no update
 * seam — is the default.
 */
function catchAllTransport(
  overrides: Record<string, unknown> = {},
  missing: readonly string[] = ['hosts', 'workspaces'],
): PocketShellApi {
  const group = (name: string) => new Proxy({}, {
    get: (_target, key: string) => (`${name}.${key}` in overrides
      ? overrides[`${name}.${key}`]
      : key.startsWith('on') ? () => () => undefined : async () => undefined),
  });
  return new Proxy({}, {
    get: (_target, name: string) => (missing.includes(name as string) ? undefined : group(name as string)),
  }) as unknown as PocketShellApi;
}

/** Two config hosts, so the default-host select and the roots instance picker have entries. */
const HOSTS = [{ name: 'aws' }, { name: 'hetzner' }];

function mountSettings(
  overrides: Record<string, unknown> = {},
  opts: { missing?: readonly string[]; attach?: boolean } = {},
) {
  provideApi(catchAllTransport({ 'ssh.listConfigHosts': async () => HOSTS, ...overrides }, opts.missing));
  return mount(SettingsView, opts.attach ? { attachTo: document.body } : undefined);
}

async function selectTab(wrapper: Awaited<ReturnType<typeof mountSettings>>, id: string): Promise<void> {
  await wrapper.get(`[role=tab]#settings-tab-${id}`).trigger('click');
}

const panelOf = (wrapper: Awaited<ReturnType<typeof mountSettings>>, id: string) =>
  wrapper.get(`#settings-panel-${id}`);

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  provideExtensions({});
});

describe('Settings tabs', () => {
  it('opens on General with the five tabs in reading order', async () => {
    const wrapper = mountSettings();
    await flushPromises();

    const tabs = wrapper.findAll('[role=tab]');
    expect(tabs.map((tab) => tab.text())).toEqual(['General', 'Sessions', 'Appearance', 'Keyboard', 'Advanced']);
    expect(wrapper.get('[role=tablist]').attributes('aria-label')).toBe('Settings sections');
    expect(tabs.map((tab) => tab.attributes('aria-selected'))).toEqual(['true', 'false', 'false', 'false', 'false']);
    // Roving tabindex: exactly the selected tab sits in the Tab order.
    expect(tabs.map((tab) => tab.attributes('tabindex'))).toEqual(['0', '-1', '-1', '-1', '-1']);

    expect(panelOf(wrapper, 'general').element.style.display).not.toBe('none');
    expect(panelOf(wrapper, 'sessions').element.style.display).toBe('none');
    wrapper.unmount();
  });

  it("shows a tab's panel on click and keeps the hidden ones mounted", async () => {
    const wrapper = mountSettings();
    await flushPromises();
    await selectTab(wrapper, 'sessions');

    expect(panelOf(wrapper, 'sessions').element.style.display).not.toBe('none');
    expect(panelOf(wrapper, 'general').element.style.display).toBe('none');
    // Still in the DOM — drafts and platform probes survive the round trip.
    expect(wrapper.find('#settings-panel-general').exists()).toBe(true);
    expect(wrapper.find('[data-testid=settings-group-sessions]').exists()).toBe(true);
    expect(wrapper.find('#session-tree-sort').exists()).toBe(true);
    wrapper.unmount();
  });

  it('moves selection AND focus with the arrow keys (roving tabindex)', async () => {
    const wrapper = mountSettings({}, { attach: true });
    await flushPromises();
    const general = wrapper.get('[role=tab]#settings-tab-general');
    general.element.focus();

    await general.trigger('keydown', { key: 'ArrowRight' });
    const sessions = wrapper.get('[role=tab]#settings-tab-sessions');
    expect(sessions.attributes('aria-selected')).toBe('true');
    expect(sessions.attributes('tabindex')).toBe('0');
    expect(general.attributes('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(sessions.element);

    // End jumps to the last tab; selection follows.
    await sessions.trigger('keydown', { key: 'End' });
    expect(wrapper.get('[role=tab]#settings-tab-advanced').attributes('aria-selected')).toBe('true');
    wrapper.unmount();
  });

  it("edits a host's project roots inside the Sessions tab", async () => {
    const wrapper = mountSettings();
    await flushPromises();
    const settings = useSettingsStore();
    await selectTab(wrapper, 'sessions');

    // Opened from the picker (no active connection), the section asks which
    // instance to edit before its controls go live.
    await wrapper.get('#root-host').setValue('aws');
    const input = wrapper.get('input[aria-label="Add a project root for aws"]');
    await input.setValue('~/work');
    await input.trigger('keydown', { key: 'Enter' });

    expect(settings.sessionRootsFor('aws')).toEqual(['~/work']);
    expect(wrapper.findAll('[data-testid=workspace-roots] .root-path').map((el) => el.text())).toEqual(['~/work']);
    wrapper.unmount();
  });

  it('keeps the roots draft across a round trip through another tab', async () => {
    const wrapper = mountSettings();
    await flushPromises();
    await selectTab(wrapper, 'sessions');
    await wrapper.get('#root-host').setValue('aws');
    const input = wrapper.get('input[aria-label="Add a project root for aws"]');
    await input.setValue('~/draft');

    await selectTab(wrapper, 'general');
    await selectTab(wrapper, 'sessions');
    expect(wrapper.get('input[aria-label="Add a project root for aws"]').element.value).toBe('~/draft');
    wrapper.unmount();
  });

  it('parks the platform groups, contributed sections and Updates under Advanced', async () => {
    provideExtensions({ 'settings.sections': [{ id: 'voice', title: 'Voice', component: defineComponent({ render: () => h('p', { 'data-testid': 'voice-body' }, 'dictation') }) }] });
    cleanups.push(() => provideExtensions({}));
    const wrapper = mountSettings();
    await flushPromises();
    await selectTab(wrapper, 'advanced');

    expect(wrapper.find('[data-testid=setting-enter-delay]').exists()).toBe(true);
    expect(wrapper.find('[data-testid=settings-section-voice]').exists()).toBe(true);
    // The catch-all answers every group, so the desktop-only Updates seam reads present.
    expect(wrapper.find('[data-testid=settings-group-updates]').exists()).toBe(true);
    // Document order preserved: the keyboard group precedes the advanced panel.
    const groups = wrapper.findAll('section.group').map((g) => g.element);
    const keyboard = groups.findIndex((g) => g.textContent?.includes('Keyboard'));
    const voice = groups.findIndex((g) => g.textContent?.includes('Voice'));
    expect(voice).toBeGreaterThan(keyboard);
    wrapper.unmount();
  });

  it('hides the Updates group over a platform without the update seam', async () => {
    const wrapper = mountSettings({}, { missing: ['hosts', 'update'] });
    await flushPromises();
    await selectTab(wrapper, 'advanced');

    expect(wrapper.find('[data-testid=settings-group-updates]').exists()).toBe(false);
    expect(wrapper.find('[data-testid=settings-group-advanced]').exists()).toBe(true);
    wrapper.unmount();
  });
});
