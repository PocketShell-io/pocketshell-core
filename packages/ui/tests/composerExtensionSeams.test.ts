// @vitest-environment jsdom
// The composer seams a platform input source drives (PocketShell #3128): the
// `composer.launcher` slot beside the closed composer's toggle, and the
// context's open / readDraft / setDraft / submit({enter}) — a phone's one-tap
// dictation opens the composer, streams words into the draft, then Inserts
// (no submit key) or Sends.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { PocketShellApi } from '../src/app/api';
import { provideApi } from '../src/app/ipc';
import { provideExtensions, type ComposerExtensionContext } from '../src/app/extensions';

let launcherContext: ComposerExtensionContext | null = null;
let sourceContext: ComposerExtensionContext | null = null;

const Launcher = defineComponent({
  props: { context: { type: Object, required: true } },
  setup(props) {
    return () => {
      launcherContext = props.context as ComposerExtensionContext;
      return h('button', { class: 'probe-launcher' }, 'mic');
    };
  },
});
const Source = defineComponent({
  props: { context: { type: Object, required: true } },
  setup(props) {
    return () => {
      sourceContext = props.context as ComposerExtensionContext;
      return h('span', { class: 'probe-source' });
    };
  },
});

// The SFC's first import compiles the whole composer tree; keep that out of
// the first test's clock.
beforeAll(async () => {
  await import('../src/app/components/PromptComposer.vue');
}, 60_000);

afterEach(() => {
  provideExtensions({});
  launcherContext = null;
  sourceContext = null;
  document.body.innerHTML = '';
});

async function mountComposer() {
  const writes: string[] = [];
  const input = vi.fn(async (_id: string, data: string) => {
    writes.push(data);
    return true;
  });
  provideApi({
    ssh: { onState: vi.fn(() => () => undefined) },
    shell: { input, onData: vi.fn(() => () => undefined) },
    attachments: { stage: vi.fn(), pickFiles: vi.fn() },
  } as unknown as PocketShellApi);
  const pinia = createPinia();
  setActivePinia(pinia);
  provideExtensions({
    'composer.launcher': [{ id: 'probe-launcher', component: Launcher }],
    'composer.inputSources': [{ id: 'probe-source', component: Source }],
  });
  const { default: PromptComposer } = await import('../src/app/components/PromptComposer.vue');
  const { useComposerStore } = await import('../src/app/stores/composer');
  const { useShellsStore } = await import('../src/app/stores/shells');
  const { useSettingsStore } = await import('../src/app/stores/settings');
  const composer = useComposerStore();
  const settings = useSettingsStore();
  const w = mount(PromptComposer, {
    props: { connectionId: 'conn-1', sessionName: 'demo', connected: true },
    global: { plugins: [pinia] },
    attachTo: document.body,
  });
  await flushPromises();
  composer.setMode('hidden');
  await flushPromises();
  const shells = useShellsStore();
  return { w, composer, shells, settings, writes };
}

describe('composer.launcher (#3128)', () => {
  it('renders beside the toggle only while the composer is closed', async () => {
    const { w, composer } = await mountComposer();
    expect(w.find('[data-extension-slot="composer.launcher"] .probe-launcher').exists()).toBe(true);
    composer.setMode('docked');
    await flushPromises();
    expect(w.find('.probe-launcher').exists()).toBe(false);
    w.unmount();
  });

  it('open() opens the composer without taking the keyboard focus', async () => {
    const { w, composer } = await mountComposer();
    (document.activeElement as HTMLElement | null)?.blur();
    launcherContext!.open();
    await flushPromises();
    expect(composer.mode).not.toBe('hidden');
    expect(w.find('textarea').exists()).toBe(true);
    expect(document.activeElement).not.toBe(w.find('textarea').element);
    expect(w.find('.probe-source').exists()).toBe(true);
    w.unmount();
  });
});

describe('ComposerExtensionContext draft and submit seams (#3128)', () => {
  it('setDraft replaces the draft with the caret at the end; readDraft reads it back', async () => {
    const { w, composer } = await mountComposer();
    launcherContext!.open();
    await flushPromises();
    sourceContext!.setDraft('check the deploy');
    await flushPromises();
    expect((w.get('textarea').element as HTMLTextAreaElement).value).toBe('check the deploy');
    expect(sourceContext!.readDraft()).toBe('check the deploy');
    sourceContext!.setDraft('check the deploy log');
    await flushPromises();
    const key = composer.targetKey('conn-1', 'demo', sourceContext!.sessionKey);
    expect(composer.states[key]?.caret).toBe('check the deploy log'.length);
    w.unmount();
  });

  it('a context stays bound to its session: a late write after a switch never reaches the next session', async () => {
    const { w, composer } = await mountComposer();
    launcherContext!.open();
    await flushPromises();
    const demo = sourceContext!;
    demo.setDraft('for demo');
    await w.setProps({ sessionName: 'other' });
    await flushPromises();
    expect(sourceContext!.sessionName).toBe('other');
    expect(sourceContext!.sessionKey).not.toBe(demo.sessionKey);
    demo.setDraft('for demo, late');
    await flushPromises();
    expect((w.get('textarea').element as HTMLTextAreaElement).value).toBe('');
    expect(sourceContext!.readDraft()).toBe('');
    expect(demo.readDraft()).toBe('for demo, late');
    // A stale context cannot deliver into the session now showing.
    await expect(demo.submit({ enter: true })).resolves.toBe(false);
    expect(composer.mode).not.toBe('hidden');
    w.unmount();
  });

  it('submit({enter:false}) is Insert: the exact draft bytes, no submit key, the composer stays open', async () => {
    const { w, composer, shells, settings, writes } = await mountComposer();
    settings.closeComposerOnSend = true;
    launcherContext!.open();
    await flushPromises();
    shells.register(sourceContext!.sessionKey, 'shell-1' as never);
    sourceContext!.setDraft('git status');
    await expect(sourceContext!.submit({ enter: false })).resolves.toBe(true);
    await flushPromises();
    expect(writes).toEqual(['git status']);
    expect(sourceContext!.readDraft()).toBe('');
    expect(composer.mode).not.toBe('hidden');
    w.unmount();
  });

  it('submit({enter:true}) is Send: the draft then the submit key', async () => {
    const { w, shells, settings, writes } = await mountComposer();
    settings.submitEnterDelayMs = 0;
    launcherContext!.open();
    await flushPromises();
    shells.register(sourceContext!.sessionKey, 'shell-1' as never);
    sourceContext!.setDraft('explain the failing test');
    await expect(sourceContext!.submit({ enter: true })).resolves.toBe(true);
    expect(writes).toEqual(['explain the failing test', '\r']);
    expect(sourceContext!.readDraft()).toBe('');
    w.unmount();
  });
});

describe('the open card reports its top edge (#3128 terminal lift)', () => {
  it('emits the card top in viewport px when open, and null when closed', async () => {
    const rect = (top: number, bottom: number) =>
      ({ top, bottom, left: 0, right: 400, width: 400, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('composer-root')) return rect(0, 800);
      if (this.classList.contains('composer')) return rect(520, 788);
      return rect(0, 0);
    });
    try {
      const { w, composer } = await mountComposer();
      const last = () => (w.emitted('card-top') ?? []).at(-1)?.[0];
      expect(last()).toBeNull();
      composer.setMode('docked');
      await flushPromises();
      expect(last()).toBe(520);
      composer.setMode('hidden');
      await flushPromises();
      expect(last()).toBeNull();
      w.unmount();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('a phone composer never raises the soft keyboard on its own (#3128: no remote resize)', () => {
  function stubCompact(compact: boolean) {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: compact && query.includes('640'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    return () => {
      window.matchMedia = original;
    };
  }

  it.each([
    [true, 0],
    [false, 1],
  ] as const)('compact=%s: closing hands focus to the terminal %s time(s)', async (compact, expected) => {
    const restore = stubCompact(compact);
    try {
      const { w, composer } = await mountComposer();
      composer.setMode('docked');
      await flushPromises();
      await w.get('button[aria-label="Close the prompt panel"]').trigger('click');
      await flushPromises();
      expect(composer.mode).toBe('hidden');
      expect(w.emitted('focus-terminal') ?? []).toHaveLength(expected);
      w.unmount();
    } finally {
      restore();
    }
  });

  it('a source submit leaves focus alone, even when the send closes the composer', async () => {
    const { w, shells, settings, composer } = await mountComposer();
    settings.submitEnterDelayMs = 0;
    settings.closeComposerOnSend = true;
    launcherContext!.open();
    await flushPromises();
    shells.register(sourceContext!.sessionKey, 'shell-1' as never);
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    sourceContext!.setDraft('hello');
    await expect(sourceContext!.submit({ enter: true })).resolves.toBe(true);
    await flushPromises();
    expect(composer.mode).toBe('hidden');
    expect(document.activeElement).toBe(outside);
    expect(w.emitted('focus-terminal') ?? []).toHaveLength(0);
    w.unmount();
  });
});
