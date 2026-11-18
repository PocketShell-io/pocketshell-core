// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

const stub = vi.hoisted(() => ({ failed: null as any, opens: 0 }));
vi.mock('../src/app/terminalPane', async () => {
  const { ref } = await import('vue');
  class TerminalPane {
    joinPending = ref(false);
    sessionEnded = ref(false);
    openFailed = ref<string | null>(null);
    constructor() {
      stub.failed = this.openFailed;
      return new Proxy(this, { get: (t: any, k) => k in t ? t[k] : (() => Promise.resolve()) });
    }
    open(): Promise<void> {
      stub.opens += 1;
      this.openFailed.value = null;
      return Promise.resolve();
    }
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
afterEach(() => { wrapper?.unmount(); wrapper = undefined; stub.opens = 0; });

async function mountPane() {
  setActivePinia(createPinia());
  provideApi({ ssh: { onState: () => () => undefined }, shell: { onData: () => () => undefined, onExited: () => () => undefined }, preview: { onStats: () => () => undefined }, diag: { log: () => undefined } } as never);
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div/>' } }] });
  await router.push('/');
  wrapper = mount(TerminalView, { props: { connectionId: 'c1', sessionName: 'main', backend: 'aplexer' } as never, global: { plugins: [router] } });
  await flushPromises();
  return useConnectionStore();
}

describe('a failed join shows Reconnect in the pane (pocketshell#3160)', () => {
  it('shows the reason and a Reconnect button, which reconnects the host and joins the session again', async () => {
    const connection = await mountPane();
    connection.state = 'lost';
    const reconnect = vi.spyOn(connection, 'reconnect').mockResolvedValue(true);
    expect(wrapper!.find('[data-testid="pane-reconnect"]').exists()).toBe(false);

    stub.failed.value = 'Connect to a host before attaching a session.';
    await flushPromises();
    expect(wrapper!.get('[data-testid="pane-open-failed"]').text()).toContain('Connect to a host before attaching a session.');
    const opensBefore = stub.opens;
    await wrapper!.get('[data-testid="pane-reconnect"]').trigger('click');
    await flushPromises();
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(stub.opens).toBe(opensBefore + 1);
    expect(wrapper!.find('[data-testid="pane-open-failed"]').exists()).toBe(false);
  });

  it('only re-joins when the link is already up, and keeps the button when the join fails again', async () => {
    const connection = await mountPane();
    connection.state = 'connected';
    const reconnect = vi.spyOn(connection, 'reconnect').mockResolvedValue(true);
    stub.failed.value = 'Session “main” is no longer in the host list.';
    await flushPromises();
    const opensBefore = stub.opens;
    await wrapper!.get('[data-testid="pane-reconnect"]').trigger('click');
    await flushPromises();
    expect(reconnect).not.toHaveBeenCalled();
    expect(stub.opens).toBe(opensBefore + 1);
    stub.failed.value = 'still failing';
    await flushPromises();
    expect(wrapper!.get('[data-testid="pane-reconnect"]').attributes('disabled')).toBeUndefined();
    expect(wrapper!.get('[data-testid="pane-open-failed"]').text()).toContain('still failing');
  });
});
