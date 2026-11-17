// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

const stub = vi.hoisted(() => ({ ended: null as any }));
vi.mock('../src/app/terminalPane', async () => {
  const { ref } = await import('vue');
  class TerminalPane {
    joinPending = ref(false);
    sessionEnded = ref(false);
    constructor() { stub.ended = this.sessionEnded; return new Proxy(this, { get: (t: any, k) => k in t ? t[k] : (() => Promise.resolve()) }); }
  }
  return { TerminalPane };
});
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  options: any = {}; cols = 80; rows = 24; element = document.createElement('div'); buffer = { active: { getLine: () => undefined } };
  loadAddon() {} open() {} onData() { return { dispose() {} }; } onKey() { return { dispose() {} }; }
  onResize() { return { dispose() {} }; } onSelectionChange() { return { dispose() {} }; } onBinary() { return { dispose() {} }; }
  attachCustomKeyEventHandler() {} registerLinkProvider() { return { dispose() {} }; } registerDecoration() {}
  parser = { registerOscHandler() { return { dispose() {} }; } }; unicode = { register() {}, activeVersion: '6' };
  dispose() {} focus() {} write() {} reset() {}
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} proposeDimensions() { return { cols: 80, rows: 24 }; } } }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
import { provideApi } from '../src/app/ipc';
import TerminalView from '../src/app/components/TerminalView.vue';
import { useConnectionStore } from '../src/app/stores/connection';

let wrapper: ReturnType<typeof mount> | undefined;
afterEach(() => { wrapper?.unmount(); wrapper = undefined; });

describe('the session-ended veil (#3141)', () => {
  it('renders when the pane reports the session ended, and "Back to sessions" opens the host tree', async () => {
    setActivePinia(createPinia());
    provideApi({ ssh: { onState: () => () => undefined }, shell: { onData: () => () => undefined, onExited: () => () => undefined }, preview: { onStats: () => () => undefined }, diag: { log: () => undefined } } as never);
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: '/', name: 'hosts', component: { template: '<div/>' } },
      { path: '/host/:name', name: 'host-sessions', component: { template: '<div/>' } },
      { path: '/term', name: 'term', component: { template: '<div/>' } }] });
    await router.push('/term');
    useConnectionStore().activeHost = { name: 'box', hostname: 'box.example' } as never;
    wrapper = mount(TerminalView, { props: { connectionId: 'c1', sessionName: 'abc', backend: 'aplexer' } as never, global: { plugins: [router] } });
    await flushPromises();
    expect(wrapper.find('[data-testid="session-ended"]').exists()).toBe(false);
    stub.ended.value = true;
    await flushPromises();
    expect(wrapper.get('[data-testid="session-ended"]').text()).toContain('This session has ended');
    await wrapper.get('[data-testid="session-ended-back"]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('host-sessions');
    expect(router.currentRoute.value.params.name).toBe('box');
  });
});
