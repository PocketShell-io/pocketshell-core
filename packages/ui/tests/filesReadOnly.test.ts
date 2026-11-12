// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { provideApi } from '../src/app/ipc';
import type { PocketShellApi } from '../src/app/api';
import { useFilesStore } from '../src/app/stores/files';
import { useConnectionStore } from '../src/app/stores/connection';
import { fileTransportCapabilities } from '../src/app/platformCapabilities';
import FileTree from '../src/app/components/FileTree.vue';

/**
 * #3086 review B3 — the Files pane is honest about the platform's file
 * transport (`sftp.capabilities`, D42: core decides from the platform's own
 * declaration):
 *  - a file over the platform's read cap is shown as over the limit and is
 *    never read, so a cut copy can never open as if complete;
 *  - when the size is unknown and the read stops at the cap, it is not opened;
 *  - a read-only platform gets no Save, no create, no delete and no download,
 *    and a save chord does not reach `writeFile`.
 * A platform that declares nothing keeps every affordance.
 */
const ANDROID_CAPS = {
  write: false,
  download: false,
  readOnlyReason: 'Editing files over this connection is not available on Android yet.',
  maxReadBytes: 512 * 1024,
};

function provide(options: { caps?: unknown; size?: number | null; read?: Uint8Array } = {}) {
  const readBinary = vi.fn(async (_c: string, _p: string, max?: number) => (options.read ?? new TextEncoder().encode('hello')).slice(0, max));
  const writeFile = vi.fn(async () => true);
  provideApi({
    ssh: { onState: () => () => undefined },
    preview: { onStats: () => () => undefined, release: () => undefined },
    forwards: { isAutoEnabled: async () => false },
    sftp: {
      list: vi.fn(async () => [{ name: 'notes.txt', longname: '', type: 'file', size: 5, modifyTime: 0, accessTime: 0, rights: { user: 'rw-', group: 'r--', other: 'r--' }, owner: 0, group: 0 }]),
      stat: vi.fn(async () => {
        if (options.size === null) throw new Error('no stat');
        return { type: 'file', size: options.size ?? 5, modifyTime: 0, accessTime: 0 };
      }),
      realPath: vi.fn(async (_c: string, p: string) => (p === '.' ? '/home/u' : p)),
      readBinary,
      writeFile,
      ...(options.caps === undefined ? {} : { capabilities: options.caps }),
    },
  } as unknown as PocketShellApi);
  return { readBinary, writeFile };
}

beforeEach(() => {
  setActivePinia(createPinia());
  window.localStorage.clear();
});

describe('Files pane honesty about the platform file transport (#3086 review B3)', () => {
  it('reads the declaration; absent means full read/write', () => {
    provide();
    expect(fileTransportCapabilities()).toEqual({ write: true, download: true, readOnlyReason: null, maxReadBytes: null });
    provide({ caps: ANDROID_CAPS });
    expect(fileTransportCapabilities()).toEqual({ write: false, download: false, readOnlyReason: ANDROID_CAPS.readOnlyReason, maxReadBytes: 524288 });
  });

  it('a 600 KiB text file over a 512 KiB platform cap is "over the limit" and never read', async () => {
    const { readBinary } = provide({ caps: ANDROID_CAPS, size: 600 * 1024 });
    const files = useFilesStore();
    await files.openFile('c1', '/home/u/big.txt');
    expect(readBinary).not.toHaveBeenCalled();
    expect(files.openMode).toBe('binary');
    expect(files.openNote).toMatch(/over the 512 KB limit|over the 512\.0 KB limit|over the .* limit/);
    expect(files.openContent).toBe('');
  });

  it('with no size, a read that stops at the platform cap is not opened as complete', async () => {
    const cap = 512 * 1024;
    const { readBinary } = provide({ caps: ANDROID_CAPS, size: null, read: new Uint8Array(cap).fill(0x61) });
    const files = useFilesStore();
    await files.openFile('c1', '/home/u/maybe-big.txt');
    expect(readBinary).toHaveBeenCalledWith('c1', '/home/u/maybe-big.txt', cap);
    expect(files.openMode).toBe('binary');
    expect(files.openContent).toBe('');
  });

  it('a file under the cap opens as text', async () => {
    provide({ caps: ANDROID_CAPS, size: 5 });
    const files = useFilesStore();
    await files.openFile('c1', '/home/u/notes.txt');
    expect(files.openMode).toBe('text');
    expect(files.openContent).toBe('hello');
  });

  it('a read-only platform never writes, even from the save chord', async () => {
    const { writeFile } = provide({ caps: ANDROID_CAPS, size: 5 });
    const files = useFilesStore();
    await files.openFile('c1', '/home/u/notes.txt');
    files.setContent('changed');
    expect(await files.save('c1')).toBe(false);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it.each([
    ['a read-only platform', ANDROID_CAPS, false],
    ['a platform that declares nothing', undefined, true],
  ])('the tree offers create/delete/download only where wired: %s', async (_label, caps, writable) => {
    provide({ caps });
    useConnectionStore().connectionId = 'c1';
    const files = useFilesStore();
    await files.open('c1', '/home/u');
    const tree = mount(FileTree, { attachTo: document.body });
    await flushPromises();
    expect(tree.find('button[title="New file or folder"]').exists()).toBe(writable);
    const row = tree.findAll('li.entry').find((li) => li.find('.nm[title="notes.txt"]').exists())!;
    expect(row?.exists()).toBe(true);
    row.element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    await flushPromises();
    const items = [...document.querySelectorAll('.menu-item')].map((n) => n.textContent?.trim() ?? '');
    // The menu really opened (G6: an absent menu would pass the "false" half vacuously).
    expect(items.some((text) => /copy/i.test(text)), JSON.stringify(items)).toBe(true);
    expect(items.some((text) => text.startsWith('Delete'))).toBe(writable);
    expect(items.some((text) => text.startsWith('Save to this computer'))).toBe(writable);
    // Right-click on the list's blank space opens the create menu only where writes exist.
    document.querySelector('.popup-menu')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();
    const list = tree.find('ul');
    list.element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 200 }));
    await flushPromises();
    const after = [...document.querySelectorAll('.menu-item')].map((n) => n.textContent?.trim() ?? '');
    expect(after.some((text) => /^New file/i.test(text) || /^(File|Folder)$/i.test(text) || /new folder/i.test(text)), JSON.stringify(after)).toBe(writable);
    tree.unmount();
    document.body.innerHTML = '';
  });
});
