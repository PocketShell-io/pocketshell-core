// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The at-rest path tint's WIRING, in the mounted view.
 *
 * terminalPathHighlights.test.ts proves the highlighter paints when its
 * `attach()` has been called — every test there calls it. What those tests
 * cannot see is the view: TerminalView constructed the highlighter and pushed
 * it into its disposables without ever calling attach(), so the subscription
 * that registers every decoration was never made. The tint never painted —
 * not once, in any pane — while the unit suite stayed green, and every
 * at-rest screenshot kept reading "a path highlighted halfway" (the wrapped
 * `file://` URLs of the Codex transcripts, most recently). This file mounts
 * the real TerminalView over a recording xterm fake and drives the render
 * stream, the way the pane itself would: the decoration is the assertion, and
 * an unattached highlighter fails it with an empty list.
 */
const stub = vi.hoisted(() => ({
  renderSubscribers: [] as ((e: { start: number; end: number }) => void)[],
  decorations: [] as { x: number; width: number; backgroundColor: string; layer: string }[],
}));

vi.mock('../src/app/terminalPane', async () => {
  const { ref } = await import('vue');
  class TerminalPane {
    joinPending = ref(false);
    sessionEnded = ref(false);
    openFailed = ref<string | null>(null);
    constructor() {
      return new Proxy(this, { get: (t: any, k) => (k in t ? t[k] : () => Promise.resolve()) });
    }
    open(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { TerminalPane };
});

const ROW = 'wrote /tmp/out/result.png done';
const COLS = 40;

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: any = {};
    cols = COLS;
    rows = 4;
    element = document.createElement('div');
    buffer = {
      active: {
        viewportY: 0,
        baseY: 0,
        cursorY: 0,
        getNullCell: () => ({ getChars: () => '', getWidth: () => 1, isUnderline: () => 0 }),
        getLine: (y: number) => {
          if (y !== 0) return undefined;
          const cells = [...ROW.padEnd(COLS, ' ')].map((ch) => ({
            getChars: () => (ch === ' ' ? '' : ch),
            getWidth: () => 1,
            isUnderline: () => 0,
          }));
          return {
            length: COLS,
            isWrapped: false,
            getCell: (x: number) => cells[x],
          };
        },
      },
    };
    loadAddon() {}
    open() {}
    onData() {
      return { dispose() {} };
    }
    onKey() {
      return { dispose() {} };
    }
    onResize() {
      return { dispose() {} };
    }
    onSelectionChange() {
      return { dispose() {} };
    }
    onBinary() {
      return { dispose() {} };
    }
    onRender(cb: (e: { start: number; end: number }) => void) {
      stub.renderSubscribers.push(cb);
      return { dispose: () => {
        const i = stub.renderSubscribers.indexOf(cb);
        if (i >= 0) stub.renderSubscribers.splice(i, 1);
      } };
    }
    onCursorMove() {
      return { dispose() {} };
    }
    attachCustomKeyEventHandler() {}
    registerLinkProvider() {
      return { dispose() {} };
    }
    registerMarker() {
      return { line: 0, dispose() {} };
    }
    registerDecoration(options: any) {
      stub.decorations.push({
        x: options.x,
        width: options.width,
        backgroundColor: options.backgroundColor,
        layer: options.layer,
      });
      return { dispose() {} };
    }
    parser = { registerOscHandler() {
      return { dispose() {} };
    } };
    unicode = { register() {}, activeVersion: '6' };
    dispose() {}
    focus() {}
    write() {}
    reset() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} proposeDimensions() { return { cols: COLS, rows: 4 }; } } }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
import { provideApi } from '../src/app/ipc';
import TerminalView from '../src/app/components/TerminalView.vue';

let wrapper: ReturnType<typeof mount> | undefined;
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  stub.renderSubscribers.length = 0;
  stub.decorations.length = 0;
});

async function mountPane(): Promise<void> {
  setActivePinia(createPinia());
  provideApi({
    ssh: { onState: () => () => undefined },
    shell: { onData: () => () => undefined, onExited: () => () => undefined },
    preview: { onStats: () => () => undefined },
    diag: { log: () => undefined },
  } as never);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div/>' } }],
  });
  await router.push('/');
  wrapper = mount(TerminalView, {
    props: { connectionId: 'c1', sessionName: 'main', backend: 'aplexer' } as never,
    global: { plugins: [router] },
  });
  await flushPromises();
}

describe('the at-rest path tint is wired into the pane (not merely constructed)', () => {
  it('paints the tint when the renderer touches a row carrying a path', async () => {
    await mountPane();

    // The view subscribed the render stream — TerminalView's own cursor
    // report does that too, so the subscription alone proves nothing. What
    // proves the highlighter is attached is what a render produces.
    expect(stub.renderSubscribers.length).toBeGreaterThan(0);
    for (const cb of [...stub.renderSubscribers]) cb({ start: 0, end: 0 });

    // `/tmp/out/result.png` after `wrote ` — 1-based x 7, 19 cells wide,
    // blocked in the theme's tint on the bottom layer.
    expect(stub.decorations).toEqual([
      {
        x: 7,
        width: 19,
        backgroundColor: expect.any(String),
        layer: 'bottom',
      },
    ]);
  });

  it('paints nothing for a row without a path', async () => {
    // Guard against the assertion above passing vacuously — a highlighter
    // that decorated every row would pass it too. The fake's row 0 is the
    // only row with content, so re-drive it after the buffer "changed" to
    // prose: the rescan must dispose-and-not-re-register.
    await mountPane();
    for (const cb of [...stub.renderSubscribers]) cb({ start: 0, end: 0 });
    expect(stub.decorations).toHaveLength(1);
    stub.decorations.length = 0;
    // Row 3 is blank (getLine answers undefined beyond row 0) — no segments.
    for (const cb of [...stub.renderSubscribers]) cb({ start: 3, end: 3 });
    expect(stub.decorations).toEqual([]);
  });
});
