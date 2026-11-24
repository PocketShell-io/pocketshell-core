// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import AppRoot from '@ui/app/AppRoot.vue';
import { provideApi } from '@ui/app/ipc';
import { useSettingsStore } from '@ui/app/stores/settings';
import { resolveTheme } from '@ui/themes';
import type { PocketShellApi } from '@ui/app/api';

const Home = defineComponent({ render: () => h('p', { class: 'home' }, 'home') });

function makeRouter() {
  return createRouter({ history: createMemoryHistory(), routes: [{ path: '/', name: 'hosts', component: Home }] });
}

// Unmounted after every test, pass or fail: a leaked root keeps its window
// keydown listener and would run the chord twice in the next test.
const mounted: Array<{ unmount(): void }> = [];

async function mountRoot(props: Record<string, unknown> = {}, slots: Record<string, () => unknown> = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = makeRouter();
  await router.push('/');
  await router.isReady();
  const wrapper = mount(AppRoot, { props, slots: slots as never, global: { plugins: [pinia, router] }, attachTo: document.body });
  mounted.push(wrapper);
  await nextTick();
  return wrapper;
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('style');
  // No `update` group: the client-without-updates shape (web, Android).
  provideApi({ diag: { log: () => undefined } } as unknown as PocketShellApi);
});

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  document.body.innerHTML = '';
});

describe('AppRoot', () => {
  it('renders the router outlet by default', async () => {
    const wrapper = await mountRoot();
    expect(wrapper.find('.home').exists()).toBe(true);
  });

  it('renders a client-supplied default slot instead of the outlet', async () => {
    const wrapper = await mountRoot({}, { default: () => h('section', { class: 'account-window' }) });
    expect(wrapper.find('.account-window').exists()).toBe(true);
    expect(wrapper.find('.home').exists()).toBe(false);
  });

  it('writes the chosen theme onto <html> and follows a change live', async () => {
    await mountRoot();
    const settings = useSettingsStore();
    const first = resolveTheme(settings.theme);
    const root = document.documentElement;
    expect(root.dataset['theme']).toBe(first.id);
    const [token, value] = Object.entries(first.tokens)[0]!;
    expect(root.style.getPropertyValue(token)).toBe(value);

    const other = (['light', 'dark'] as const).map((id) => resolveTheme(id)).find((t) => t.id !== first.id)!;
    settings.theme = other.id;
    await nextTick();
    expect(root.dataset['theme']).toBe(other.id);
    expect(root.style.colorScheme).toBe(other.appearance);
  });

  it('writes the typography variables with the client mono fallback', async () => {
    await mountRoot({ monoFallback: 'ui-monospace, monospace' });
    const mono = document.documentElement.style.getPropertyValue('--font-mono');
    expect(mono).toContain('ui-monospace, monospace');
    expect(mono).not.toContain('Consolas');
    expect(document.documentElement.style.getPropertyValue('--term-font-size')).toMatch(/^\d+px$/);
  });

  it('uses the shared default mono stack when the client passes none', async () => {
    await mountRoot();
    expect(document.documentElement.style.getPropertyValue('--font-mono')).toContain('Consolas');
  });

  it('deletes the word before the caret on Ctrl+W in a text field when it claims the chord', async () => {
    await mountRoot();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.value = 'git commit';
    input.setSelectionRange(10, 10);
    const e = new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', ctrlKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(e);
    expect(input.value).toBe('git ');
    expect(e.defaultPrevented).toBe(true);
  });

  it('ignores the datalist ghost keydown instead of throwing', async () => {
    await mountRoot();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.value = 'git commit';
    input.setSelectionRange(10, 10);
    // The event exactly as Chromium dispatches it when a datalist popup
    // commits or closes: type 'keydown', and no `key` property at all. It
    // reaches this window-capture listener from any target in the page, and
    // it must be inert — no deletion, no default. A listener exception would
    // not fail dispatchEvent: like Chromium, jsdom reports it as a window
    // `error` event — which is precisely the path that put the production
    // TypeError on the diag banner (see shortcuts.ts `chordFromEvent`,
    // desktop.log 2026-11-24) — so that is the path asserted here.
    const errors: ErrorEvent[] = [];
    const onError = (event: ErrorEvent): void => {
      errors.push(event);
    };
    window.addEventListener('error', onError);
    const e = new Event('keydown', { bubbles: true, cancelable: true });
    input.dispatchEvent(e);
    window.removeEventListener('error', onError);
    expect(errors).toEqual([]);
    expect(input.value).toBe('git commit');
    expect(e.defaultPrevented).toBe(false);
  });

  it('leaves Ctrl+W alone when the client does not claim it', async () => {
    await mountRoot({ claimDeleteWord: false });
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.value = 'git commit';
    input.setSelectionRange(10, 10);
    const e = new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', ctrlKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(e);
    expect(input.value).toBe('git commit');
    expect(e.defaultPrevented).toBe(false);
  });

  it('shows no update strip on a client without the update group', async () => {
    const wrapper = await mountRoot();
    expect(wrapper.find('.update-strip').exists()).toBe(false);
  });
});
