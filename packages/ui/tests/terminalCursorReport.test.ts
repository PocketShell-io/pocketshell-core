// @vitest-environment jsdom
// #3128: TerminalView reports where its cursor row ends (viewport px), so a
// phone workspace can lift the view just enough to keep the input line above
// the composer card. Null while the cursor is scrolled out of view.
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

const stub = vi.hoisted(() => ({
  term: null as any,
  render: [] as Array<(e: { start: number; end: number }) => void>,
  cursorMove: [] as Array<() => void>,
}));
vi.mock('../src/app/terminalPane', async () => {
  const { ref } = await import('vue');
  class TerminalPane {
    joinPending = ref(false);
    sessionEnded = ref(false);
    constructor() { return new Proxy(this, { get: (t: any, k) => k in t ? t[k] : (() => Promise.resolve()) }); }
  }
  return { TerminalPane };
});
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  options: any = {}; cols = 80; rows = 24; element = document.createElement('div');
  buffer = { active: { getLine: () => undefined, cursorY: 3, baseY: 0, viewportY: 0, getNullCell: () => ({ getChars: () => '', getWidth: () => 1, isUnderline: () => 0 }) } };
  constructor() {
    const screen = document.createElement('div');
    screen.className = 'xterm-screen';
    screen.getBoundingClientRect = () => ({ top: 100, bottom: 580, height: 480, left: 0, right: 400, width: 400, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect;
    this.element.appendChild(screen);
    stub.term = this;
  }
  loadAddon() {} open() {} onData() { return { dispose() {} }; } onKey() { return { dispose() {} }; }
  onRender(fn: (e: { start: number; end: number }) => void) { stub.render.push(fn); return { dispose() {} }; }
  onCursorMove(fn: () => void) { stub.cursorMove.push(fn); return { dispose() {} }; }
  onResize() { return { dispose() {} }; } onSelectionChange() { return { dispose() {} }; } onBinary() { return { dispose() {} }; }
  attachCustomKeyEventHandler() {} registerLinkProvider() { return { dispose() {} }; } registerDecoration() {}
  parser = { registerOscHandler() { return { dispose() {} }; } }; unicode = { register() {}, activeVersion: '6' };
  dispose() {} focus() {} write() {} reset() {}
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} proposeDimensions() { return { cols: 80, rows: 24 }; } } }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
import { provideApi } from '../src/app/ipc';
import TerminalView from '../src/app/components/TerminalView.vue';

let wrapper: ReturnType<typeof mount> | undefined;
afterEach(() => { wrapper?.unmount(); wrapper = undefined; stub.render = []; stub.cursorMove = []; });

async function mountView() {
  setActivePinia(createPinia());
  provideApi({ ssh: { onState: () => () => undefined }, shell: { onData: () => () => undefined, onExited: () => () => undefined }, preview: { onStats: () => () => undefined }, diag: { log: () => undefined } } as never);
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div/>' } }] });
  wrapper = mount(TerminalView, { props: { connectionId: 'c1', sessionName: 'abc', backend: 'aplexer' } as never, global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

// Each event with its real shape: onRender carries the touched viewport rows
// (`{start, end}` — the pane's render subscribers consume them, so a bare
// `fn()` here would throw in the handler xterm never calls argument-less),
// onCursorMove carries nothing.
const fire = async () => {
  for (const fn of stub.render) fn({ start: 0, end: 23 });
  for (const fn of stub.cursorMove) fn();
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  await flushPromises();
};

describe('TerminalView cursor-row report (#3128)', () => {
  it('reports the cursor row bottom in viewport px on render and cursor moves', async () => {
    const w = await mountView();
    expect(stub.render.length).toBeGreaterThanOrEqual(1);
    await fire();
    // row 3 of 24 rows on a 480px screen at top 100: (3 + 1) * 20 + 100.
    expect(w.emitted('cursor-bottom')?.at(-1)).toEqual([180]);
    stub.term.buffer.active.cursorY = 23;
    await fire();
    expect(w.emitted('cursor-bottom')?.at(-1)).toEqual([580]);
  });

  it('reports null while the cursor row is scrolled out of view, and does not repeat an unchanged value', async () => {
    const w = await mountView();
    await fire();
    const before = w.emitted('cursor-bottom')?.length ?? 0;
    await fire();
    expect(w.emitted('cursor-bottom')?.length ?? 0).toBe(before);
    stub.term.buffer.active.baseY = 100;
    stub.term.buffer.active.viewportY = 40;
    await fire();
    expect(w.emitted('cursor-bottom')?.at(-1)).toEqual([null]);
  });
});
