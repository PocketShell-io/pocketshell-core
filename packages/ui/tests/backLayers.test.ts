// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { HostKeyTrustChoice, HostKeyTrustRequest } from '@pocketshell/core';
import type { PocketShellApi } from '../src/app/api';
import { provideApi } from '../src/app/ipc';
import { useProjectsStore } from '../src/app/stores/projects';
import { useConnectionStore } from '../src/app/stores/connection';
import { dismissTopLayer, openDismissLayerCount } from '../src/app/extensions';
import HostKeyTrustGate from '../src/app/components/HostKeyTrustGate.vue';
import StopSessionDialog from '../src/app/components/StopSessionDialog.vue';
import LaunchSessionDialog from '../src/app/components/LaunchSessionDialog.vue';
import NewSessionDialog from '../src/app/components/NewSessionDialog.vue';

const REQUEST: HostKeyTrustRequest = {
  hostLabel: 'fixture', hostname: '10.0.2.2', port: 2245, user: 'testuser',
  keyType: 'ssh-ed25519', fingerprintSha256: 'SHA256:q0Yx1S9hN1Yy4oX1fqmE0Q6y2G3cVbJb3fYbq8kT2p8',
};

afterEach(() => { expect(openDismissLayerCount()).toBeGreaterThanOrEqual(0); });

describe('Back and the host-key trust prompt (#3140)', () => {
  it('answers a pending first-contact key with reject, never trust, and releases the layer', async () => {
    let decider: ((r: HostKeyTrustRequest) => Promise<HostKeyTrustChoice>) | null = null;
    provideApi({
      ssh: {
        onState: () => () => undefined,
        onTrustDecision: (d: (r: HostKeyTrustRequest) => Promise<HostKeyTrustChoice>) => { decider = d; return () => undefined; },
        close: async () => true,
      },
    } as unknown as PocketShellApi);
    const pinia = createPinia();
    setActivePinia(pinia);
    const connection = useConnectionStore();
    const gate = mount(HostKeyTrustGate, { global: { plugins: [pinia] }, attachTo: document.body });
    expect(openDismissLayerCount()).toBe(0);
    const answered = decider!(REQUEST);
    await flushPromises();
    expect(gate.find('[data-testid="host-key-trust-gate"]').exists()).toBe(true);
    expect(openDismissLayerCount()).toBe(1);

    expect(dismissTopLayer()).toBe(true);
    await expect(answered).resolves.toBe('reject');
    await flushPromises();
    expect(connection.pendingTrust).toBeNull();
    expect(openDismissLayerCount()).toBe(0);
    expect(dismissTopLayer()).toBe(false);
    gate.unmount();
  });
});

describe('Back closes each dialog layer (#3140)', () => {
  const mounted: VueWrapper[] = [];
  afterEach(() => { for (const w of mounted.splice(0)) w.unmount(); });

  function setup(): void {
    provideApi({
      ssh: { onState: vi.fn(() => () => undefined) },
      agent: { kinds: async () => ['claude'], binaries: async () => ['pocketshell', 'claude'], profiles: async () => [] },
      projects: { list: async () => [], reposList: async () => [], home: async () => ({ ok: true, home: '/home/alexey' }) },
    } as unknown as PocketShellApi);
    const pinia = createPinia();
    setActivePinia(pinia);
    useConnectionStore().connectionId = 'conn-1';
    useProjectsStore().home = '/home/alexey';
    pinia_ = pinia;
  }
  let pinia_: ReturnType<typeof createPinia>;

  it.each([
    ['stop-session', StopSessionDialog, { session: 'demo', busy: false }],
    ['launch-session', LaunchSessionDialog, { folderPath: '/home/alexey/git/demo', folderLabel: 'demo' }],
    ['new-session', NewSessionDialog, { startIn: null, roots: [] }],
  ] as const)('%s: Back closes the dialog (emits close) and releases the layer', async (name, component, props) => {
    setup();
    const w = mount(component as never, { props: props as never, attachTo: document.body, global: { plugins: [pinia_] } });
    mounted.push(w);
    await flushPromises();
    expect(openDismissLayerCount(), name).toBeGreaterThanOrEqual(1);
    expect(dismissTopLayer()).toBe(true);
    expect(w.emitted('close'), name).toHaveLength(1);
  });
});

describe('Back and the inline composer (#3140)', () => {
  it('an open composer is the topmost layer: Back collapses it, keeps the draft and writes no bytes to the shell', async () => {
    const input = vi.fn(async () => undefined);
    provideApi({
      ssh: { onState: vi.fn(() => () => undefined) },
      shell: { input, onData: vi.fn(() => () => undefined) },
      attachments: { stage: vi.fn(), pickFiles: vi.fn() },
    } as unknown as PocketShellApi);
    const pinia = createPinia();
    setActivePinia(pinia);
    const { default: PromptComposer } = await import('../src/app/components/PromptComposer.vue');
    const { useComposerStore } = await import('../src/app/stores/composer');
    const composer = useComposerStore();
    const before = openDismissLayerCount();
    const w = mount(PromptComposer, {
      props: { connectionId: 'conn-1', sessionName: 'demo', connected: true },
      global: { plugins: [pinia] },
      attachTo: document.body,
    });
    await flushPromises();
    composer.setMode('docked');
    await flushPromises();
    expect(openDismissLayerCount()).toBe(before + 1);
    await w.get('textarea').setValue('a draft longer than five characters');
    expect(dismissTopLayer()).toBe(true);
    await flushPromises();
    expect(composer.mode).toBe('hidden');
    expect(openDismissLayerCount()).toBe(before);
    expect(input).not.toHaveBeenCalled();
    composer.setMode('docked');
    await flushPromises();
    expect((w.get('textarea').element as HTMLTextAreaElement).value).toBe('a draft longer than five characters');
    w.unmount();
  });
});
