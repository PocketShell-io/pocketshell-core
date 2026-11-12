// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { defineComponent } from 'vue';
import { createMemoryHistory, createRouter, type RouteRecordRaw } from 'vue-router';
import { provideApi } from '../src/app/ipc';
import type { PocketShellApi } from '../src/app/api';
import { CLI_SESSIONS_URL, cliSessionsTarget } from '../src/app/cliSessionsLink';
import AccountView from '../src/app/views/AccountView.vue';

/**
 * Account & sync's "CLI sessions" entry: the web client has the
 * /device/sessions route and navigates in-app; a client without it (the
 * desktop's account window) gets the absolute URL in a new window, which its
 * window-open policy hands to the system browser.
 */

/**
 * Catch-all transport double, as in settingsView.test.ts: every method
 * resolves undefined except the two reads AccountView renders from on mount:
 * an empty config host list and a signed-out account status.
 */
const ANSWERS: Record<string, unknown> = {
  'ssh.listConfigHosts': async () => [],
  'sync.status': async () => ({ loggedIn: false, email: null, keychainAvailable: true }),
};

function catchAllTransport(): PocketShellApi {
  const group = (name: string) => new Proxy({}, {
    get: (_target, key: string) => {
      if (`${name}.${key}` in ANSWERS) return ANSWERS[`${name}.${key}`];
      return key.startsWith('on') ? () => () => undefined : async () => undefined;
    },
  });
  return new Proxy({}, {
    get: (_target, name: string) => (name === 'hosts' || name === 'workspaces' ? undefined : group(name)),
  }) as unknown as PocketShellApi;
}

const Empty = defineComponent({ render: () => null });

function routerWith(extra: RouteRecordRaw[]) {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', name: 'hosts', component: Empty }, ...extra],
  });
}

const WEB_ROUTE: RouteRecordRaw = { path: '/device/sessions', name: 'device-sessions', component: Empty };

beforeEach(() => {
  setActivePinia(createPinia());
  provideApi(catchAllTransport());
});

describe('cliSessionsTarget', () => {
  it('uses the in-app route when the router has it', () => {
    expect(cliSessionsTarget(routerWith([WEB_ROUTE]))).toEqual({
      kind: 'route',
      to: { name: 'device-sessions' },
    });
  });

  it('falls back to the absolute web URL without the route or a router', () => {
    const external = { kind: 'external', href: 'https://app.pocketshell.io/device/sessions' };
    expect(cliSessionsTarget(routerWith([]))).toEqual(external);
    expect(cliSessionsTarget(undefined)).toEqual(external);
  });
});

describe('AccountView CLI sessions entry', () => {
  it('links same-origin to /device/sessions on the web', async () => {
    const router = routerWith([WEB_ROUTE]);
    await router.push('/');
    const wrapper = mount(AccountView, { global: { plugins: [router] } });
    await flushPromises();

    const card = wrapper.get('[data-testid=account-cli-sessions]');
    expect(card.text()).toContain('CLI sessions');
    expect(card.text()).toContain('pocketshell login');
    const link = card.get('a.cli-sessions-link');
    expect(link.attributes('href')).toBe('/device/sessions');
    expect(link.attributes('target')).toBeUndefined();

    await link.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('device-sessions');
  });

  it('opens the absolute URL in a new window where the route is absent (desktop)', async () => {
    const router = routerWith([]);
    await router.push('/');
    const wrapper = mount(AccountView, { global: { plugins: [router] } });
    await flushPromises();

    const link = wrapper.get('[data-testid=account-cli-sessions] a.cli-sessions-link');
    expect(link.attributes('href')).toBe(CLI_SESSIONS_URL);
    expect(link.attributes('target')).toBe('_blank');
    expect(link.attributes('rel')).toBe('noopener noreferrer');
  });

  it('still renders the external link when mounted without a router', async () => {
    const wrapper = mount(AccountView);
    await flushPromises();

    const link = wrapper.get('[data-testid=account-cli-sessions] a.cli-sessions-link');
    expect(link.attributes('href')).toBe(CLI_SESSIONS_URL);
  });
});
