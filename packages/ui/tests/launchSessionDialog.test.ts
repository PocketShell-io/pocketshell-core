// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PocketShellApi } from '../src/app/api';
import { provideApi } from '../src/app/ipc';
import LaunchSessionDialog from '../src/app/components/LaunchSessionDialog.vue';
import { useConnectionStore } from '../src/app/stores/connection';
import { useProjectsStore } from '../src/app/stores/projects';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

interface AgentApiOptions {
  kinds?: () => Promise<string[] | null>;
  binaries?: () => Promise<string[] | null>;
}

function installApi(options: AgentApiOptions = {}) {
  const kinds = vi.fn(options.kinds ?? (async () => ['claude']));
  const binaries = vi.fn(options.binaries ?? (async () => ['pocketshell', 'claude']));
  const profiles = vi.fn(async () => []);

  provideApi({
    ssh: { onState: vi.fn(() => () => undefined) },
    agent: { kinds, binaries, profiles },
  } as unknown as PocketShellApi);

  return { kinds, binaries, profiles };
}

const mounted: VueWrapper[] = [];

function mountDialog(): VueWrapper {
  const pinia = createPinia();
  setActivePinia(pinia);

  useConnectionStore().connectionId = 'conn-1';
  useProjectsStore().home = '/home/alexey';

  const wrapper = mount(LaunchSessionDialog, {
    props: { folderPath: '/home/alexey/git/demo', folderLabel: 'demo' },
    global: { plugins: [pinia] },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

function agentSegmentTexts(wrapper: VueWrapper): string[] {
  const agentField = wrapper
    .findAll('section.field')
    .find((field) => field.find('.field-label').text() === 'Agent');
  if (!agentField) throw new Error('Agent field was not rendered');
  return agentField.findAll('button.segment').map((button) => button.text());
}

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  localStorage.clear();
});

describe('LaunchSessionDialog engine catalog', () => {
  it('shows a loading state without the offline fallback, then renders only live non-shell engines', async () => {
    const liveKinds = deferred<string[] | null>();
    const liveBinaries = deferred<string[] | null>();
    const api = installApi({ kinds: () => liveKinds.promise, binaries: () => liveBinaries.promise });
    const wrapper = mountDialog();

    expect(api.kinds).toHaveBeenCalledWith('conn-1');
    expect(wrapper.text()).toContain('Checking this host’s engine catalog…');
    expect(agentSegmentTexts(wrapper)).toEqual([]);
    expect(wrapper.text()).not.toContain('OpenCode');

    liveKinds.resolve(['custom-engine', 'shell', 'claude']);
    liveBinaries.resolve(['pocketshell']);
    await flushPromises();

    expect(agentSegmentTexts(wrapper)).toEqual(['Custom Engine', 'Claude']);
    const customEngine = wrapper.findAll('section.field')
      .find((field) => field.find('.field-label').text() === 'Agent')!
      .findAll('button.segment')[0]!;
    expect(customEngine.classes()).not.toContain('unavailable');
    expect(customEngine.attributes('title')).toBe('');
  });

  it('treats a successful empty catalog as no engines instead of showing offline defaults', async () => {
    installApi({ kinds: async () => [], binaries: async () => ['pocketshell', 'claude', 'codex'] });
    const wrapper = mountDialog();
    await flushPromises();

    expect(wrapper.text()).toContain('No available agent engines on this host.');
    expect(agentSegmentTexts(wrapper)).toEqual([]);
  });

  it('uses the static engine fallback only when the live catalog query fails', async () => {
    installApi({
      kinds: async () => { throw new Error('a engines unavailable'); },
      binaries: async () => ['pocketshell', 'claude', 'codex'],
    });
    const wrapper = mountDialog();
    await flushPromises();

    expect(agentSegmentTexts(wrapper)).toEqual(['Claude', 'Codex', 'OpenCode', 'Grok', 'Antigravity']);
    const agentField = wrapper.findAll('section.field')
      .find((field) => field.find('.field-label').text() === 'Agent')!;
    const claude = agentField.findAll('button.segment')[0]!;
    const codex = agentField.findAll('button.segment')[1]!;
    const openCode = agentField.findAll('button.segment')[2]!;
    expect(claude.classes()).not.toContain('unavailable');
    expect(codex.classes()).not.toContain('unavailable');
    expect(openCode.classes()).toContain('unavailable');
  });
});
