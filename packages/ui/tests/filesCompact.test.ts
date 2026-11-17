// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { provideApi } from '../src/app/ipc';
import type { PocketShellApi } from '../src/app/api';
import { useFilesStore } from '../src/app/stores/files';
import { useConnectionStore } from '../src/app/stores/connection';
import { dismissTopLayer, openDismissLayerCount } from '../src/app/extensions';
import FilesView from '../src/app/views/FilesView.vue';
import PortPanelView from '../src/app/views/PortPanelView.vue';

/**
 * #3125 (S4c): compact Files is single-pane and wired into app.dismissLayers;
 * the Ports panel marks itself compact. Every rule is paired with the expanded
 * output being unchanged. (Real layout - scroll offset, boxes, overflow - is
 * asserted in filesPortsLayoutBrowser.test.ts.)
 */
function setWidth(width: number): void {
  const matchMedia = (query: string) => {
    const max = Number(/max-width:\s*(\d+)px/.exec(query)?.[1]);
    return {
      matches: width <= max,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
  };
  vi.stubGlobal('matchMedia', matchMedia);
  Object.defineProperty(window, 'matchMedia', { value: matchMedia, configurable: true, writable: true });
}

const entry = { name: 'a.bin', longname: '', type: 'file', size: 5, modifyTime: 0, accessTime: 0, rights: { user: 'rw-', group: 'r--', other: 'r--' }, owner: 0, group: 0 };

function provide(): void {
  provideApi({
    ssh: { onState: () => () => undefined },
    preview: { onStats: () => () => undefined, release: () => undefined },
    forwards: {
      isAutoEnabled: async () => false,
      onStates: () => () => undefined,
      list: async () => [],
      discovered: async () => [],
      status: async () => null,
      scan: async () => [],
      startAuto: async () => undefined,
    },
    sftp: {
      list: vi.fn(async () => [entry]),
      stat: vi.fn(async () => ({ type: 'file', size: 5, modifyTime: 0, accessTime: 0 })),
      realPath: vi.fn(async (_c: string, p: string) => (p === '.' ? '/home/u' : p)),
      readBinary: vi.fn(async () => new Uint8Array([0, 1, 2])),
    },
  } as unknown as PocketShellApi);
}

async function mountFiles() {
  provide();
  const connection = useConnectionStore();
  connection.connectionId = 'c1' as never;
  const wrapper = mount(FilesView, { attachTo: document.body });
  await flushPromises();
  return { wrapper, files: useFilesStore() };
}

beforeEach(() => {
  setActivePinia(createPinia());
  window.localStorage.clear();
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('Files compact single pane (#3125)', () => {
  it('compact, nothing open: tree only, no splitter, no dismiss layer', async () => {
    setWidth(360);
    const { wrapper } = await mountFiles();
    const root = wrapper.find('.files-view');
    expect(root.classes()).toContain('compact');
    expect(root.classes()).not.toContain('detail-open');
    expect(wrapper.find('.tree-splitter').exists()).toBe(false);
    expect(openDismissLayerCount()).toBe(0);
    wrapper.unmount();
  });

  it('compact: opening a file shows the editor and the back chevron returns to the SAME tree node', async () => {
    setWidth(360);
    const { wrapper, files } = await mountFiles();
    const tree = wrapper.find('.file-tree').element;
    const list = wrapper.find('.entries').element as HTMLElement;
    list.scrollTop = 120;

    files.openPath = '/home/u/a.bin';
    await nextTick();
    expect(wrapper.find('.files-view').classes()).toContain('detail-open');
    expect(wrapper.find('[data-testid=files-back]').exists()).toBe(true);
    expect(wrapper.find('.close-btn').exists()).toBe(false);

    await wrapper.find('[data-testid=files-back]').trigger('click');
    await nextTick();
    expect(wrapper.find('.files-view').classes()).not.toContain('detail-open');
    // Same node, never remounted: the scroll offset travels with it.
    expect(wrapper.find('.file-tree').element).toBe(tree);
    expect((wrapper.find('.entries').element as HTMLElement).scrollTop).toBe(120);
    wrapper.unmount();
  });

  it('compact: an open file is a dismiss layer; Android Back closes it, then falls through', async () => {
    setWidth(360);
    const { wrapper, files } = await mountFiles();
    files.openPath = '/home/u/a.bin';
    await nextTick();
    expect(openDismissLayerCount()).toBe(1);
    expect(dismissTopLayer()).toBe(true);
    await nextTick();
    expect(wrapper.find('.files-view').classes()).not.toContain('detail-open');
    expect(openDismissLayerCount()).toBe(0);
    expect(dismissTopLayer()).toBe(false);
    wrapper.unmount();
    expect(openDismissLayerCount()).toBe(0);
  });

  async function openDraft(wrapper: Awaited<ReturnType<typeof mountFiles>>['wrapper'], files: ReturnType<typeof useFilesStore>) {
    files.openPath = '/home/u/a.bin';
    files.openMode = 'text';
    files.openContent = 'my unsaved draft';
    files.dirty = true;
    await nextTick();
    expect(wrapper.find('.files-view').classes()).toContain('detail-open');
  }

  it('compact: Back (chevron) keeps an unsaved draft, marks it in the tree, and tapping the row resumes it', async () => {
    setWidth(360);
    const { wrapper, files } = await mountFiles();
    await openDraft(wrapper, files);
    await wrapper.find('[data-testid=files-back]').trigger('click');
    await nextTick();
    expect(wrapper.find('.files-view').classes()).not.toContain('detail-open');
    expect(files.dirty).toBe(true);
    expect(files.openContent).toBe('my unsaved draft');
    expect(files.openPath).toBe('/home/u/a.bin');
    expect(wrapper.find('[data-testid=files-draft-marker]').exists()).toBe(true);

    await wrapper.find('.entries .entry:not(.up)').trigger('click');
    await flushPromises();
    expect(wrapper.find('.files-view').classes()).toContain('detail-open');
    expect(files.dirty).toBe(true);
    expect(files.openContent).toBe('my unsaved draft');
    wrapper.unmount();
  });

  it('compact: Android Back (dismiss layer) keeps the unsaved draft too', async () => {
    setWidth(360);
    const { wrapper, files } = await mountFiles();
    await openDraft(wrapper, files);
    expect(dismissTopLayer()).toBe(true);
    await nextTick();
    expect(files.dirty).toBe(true);
    expect(files.openContent).toBe('my unsaved draft');
    expect(wrapper.find('[data-testid=files-draft-marker]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('expanded: no draft marker is added to the tree rows', async () => {
    setWidth(1200);
    const { wrapper, files } = await mountFiles();
    files.openPath = '/home/u/a.bin';
    files.openMode = 'text';
    files.openContent = 'draft';
    files.dirty = true;
    await nextTick();
    expect(wrapper.find('[data-testid=files-draft-marker]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('expanded: unchanged - splitter, Close button, no back chevron, no layer, no compact classes', async () => {
    setWidth(1200);
    const { wrapper, files } = await mountFiles();
    files.openPath = '/home/u/a.bin';
    await nextTick();
    const root = wrapper.find('.files-view');
    expect(root.classes()).toEqual(['files-view']);
    expect(wrapper.find('.tree-splitter').exists()).toBe(true);
    expect(wrapper.find('[data-testid=files-back]').exists()).toBe(false);
    expect(wrapper.find('.close-btn').exists()).toBe(true);
    expect(openDismissLayerCount()).toBe(0);
    expect(wrapper.find('.file-tree').attributes('style')).toContain('flex');
    wrapper.unmount();
  });
});

describe('Ports panel compact class (#3125)', () => {
  it('compact marks the panel; expanded leaves the DOM class list alone', async () => {
    for (const [width, expected] of [[360, ['port-panel', 'compact']], [1200, ['port-panel']]] as const) {
      setActivePinia(createPinia());
      setWidth(width);
      provide();
      useConnectionStore().connectionId = 'c1' as never;
      const wrapper = mount(PortPanelView);
      await flushPromises();
      expect(wrapper.find('.port-panel').classes()).toEqual(expected);
      wrapper.unmount();
    }
  });
});
