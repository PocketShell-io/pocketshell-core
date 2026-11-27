// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The hover underline's WIRING, in the mounted view.
 *
 * terminalLinkHover.test.ts (the electron suite) proves the painter paints
 * once it is handed segments, and terminalLinks.test.ts proves the fragments
 * carry the hover that hands them over — given a paint to talk to. What
 * neither can see is the view: the painter is constructed in TerminalView and
 * must reach BOTH providers, or every link mounts hover-less and the whole
 * feature silently never fires — the same class of failure the at-rest tint
 * had (constructed, held, never attached). This file mounts the real
 * TerminalView over a recording xterm fake, asks the recorded providers for
 * the links of a wrapped address, and drives a fragment's hover: the bar is
 * the assertion, and a painter that never reached the providers fails it with
 * a hover-less link.
 */
const stub = vi.hoisted(() => ({
  providers: [] as {
    provideLinks(line: number, cb: (links: unknown[] | undefined) => void): void;
  }[],
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

const ROWS = ['up on 127.0.0.1:8300', '/health now'];
const COLS = 30;
const cell = (ch: string) => ({
  getChars: () => (ch === ' ' ? '' : ch),
  getWidth: () => 1,
  isUnderline: () => 0,
});

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
        getNullCell: () => cell(' '),
        getLine: (y: number) => {
          if (y >= ROWS.length) return undefined;
          // Cells past the row's text answer undefined — the flattening skips
          // them outright, the way a REAL hard-wrapped row is full to the
          // margin and has no filler to read as spaces between the address
          // and its continuation.
          const row = [...ROWS[y]!].map(cell);
          return {
            length: COLS,
            isWrapped: y === 1,
            getCell: (x: number) => row[x],
          };
        },
      },
    };
    loadAddon() {}
    open() {
      // An opened terminal mounts its screen inside its element, and that
      // element sits in the document — the painter finds `.xterm-screen`
      // there and its layer only counts while connected, so the fake mounts
      // one with a real rect the way the real pane does.
      const screen = document.createElement('div');
      screen.className = 'xterm-screen';
      screen.getBoundingClientRect = () =>
        ({ width: 300, height: 96, left: 0, top: 0, right: 300, bottom: 96, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
      this.element.appendChild(screen);
      document.body.appendChild(this.element);
    }
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
    onRender() {
      return { dispose() {} };
    }
    onCursorMove() {
      return { dispose() {} };
    }
    attachCustomKeyEventHandler() {}
    registerLinkProvider(provider: never) {
      stub.providers.push(provider);
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
  stub.providers.length = 0;
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

/** The links the FIRST provider to answer (xterm's priority rule) gives line 1. */
function linksForLine1(): { hover?: () => void; leave?: () => void; text: string }[] {
  let answered: { hover?: () => void; leave?: () => void; text: string }[] = [];
  for (const provider of stub.providers) {
    provider.provideLinks(1, (links) => {
      if (links !== undefined && answered.length === 0) answered = links as typeof answered;
    });
  }
  return answered;
}

describe('the hover painter is wired into the pane (not merely constructed)', () => {
  it('a wrapped address mounts fragments whose hover paints its other rows', async () => {
    await mountPane();

    // Both providers registered; the URL one answers for this line — two
    // fragments of the one joined address (`127.0.0.1:8300` on row 0, its
    // `/health` continuation on row 1).
    expect(stub.providers.length).toBeGreaterThanOrEqual(2);
    const links = linksForLine1();
    expect(links.map((l) => l.text)).toEqual(['127.0.0.1:8300', '/health']);

    // The wiring is the assertion: hover exists only because the painter
    // reached the provider, and driving it paints the OTHER fragment's
    // stretch in the real painter's layer.
    expect(links[0]!.hover).toBeTypeOf('function');
    links[0]!.hover!();
    const layer = termScreenLayer();
    expect(layer?.childElementCount).toBe(1);
    const bar = layer!.firstElementChild as HTMLElement;
    // The bar is the SIBLING fragment — `/health` at column 0 of row 1 —
    // never the hovered fragment itself (that one keeps xterm's native
    // underline). 300px over 30 columns is 10px a cell; 96px over 4 rows is
    // 24px a cell, baseline round(19.2), thickness 2 → top 24 + 19 - 2.
    expect(bar.style.left).toBe('0px');
    expect(bar.style.width).toBe('70px');
    expect(bar.style.top).toBe('41px');

    // The leave clears the bar; the fragment itself keeps xterm's native
    // underline, so the painter is only ever asked about the siblings.
    links[0]!.leave!();
    expect(termScreenLayer()?.childElementCount).toBe(0);
  });

  it('unmounting the pane removes the painter and its layer', async () => {
    await mountPane();
    const links = linksForLine1();
    links[0]!.hover!();
    expect(termScreenLayer()?.childElementCount).toBe(1);

    wrapper?.unmount();
    wrapper = undefined;
    expect(termScreenLayer()).toBeNull();
  });
});

function termScreenLayer(): HTMLElement | null {
  return document.querySelector('.xterm-screen .terminal-link-hover-underlines');
}
