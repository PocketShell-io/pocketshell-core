// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HOST_KEYS from '../../../tests/fixtures/gateway-host-keys.json';
import type { ConnectResult, GatewayDevice, HostEntry } from '@pocketshell/core';
import { provideApi } from '../src/app/ipc';
import type { GatewayAddDeviceRequest, PocketShellApi } from '../src/app/api';
import HostPickerView from '../src/app/views/HostPickerView.vue';
import { useConnectionStore } from '../src/app/stores/connection';

/**
 * pocketshell#3086 slice 4 — the host picker's gateway device source and
 * the add-device flow, on the shared picker every platform mounts (D43).
 *
 *  - devices come from the platform's `gateway.devices` only: presence is
 *    the gateway's last word (online / offline / unknown), revoked devices
 *    are marked and cannot be added, and listing NEVER dials anything;
 *  - an added device (a saved host with the gateway marker) is not listed
 *    twice, and its host row shows the same presence;
 *  - the add flow saves the PASTED pin, never the advisory key, shows this
 *    device's public key with the manual authorization step and the
 *    upcoming Windows command, and never claims the key is authorized;
 *  - each gateway refusal kind gets its own prompt, never a generic error.
 */

const KEYS = HOST_KEYS as Record<string, { line: string; fingerprint: string }>;

const SERVER = 'wss://gateway.pocketshell.io';
const PHONE_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPhoneKeyPublicHalfOnlyForTheTestXXXXXXXXXXX phone';

function entry(name: string, extra: Partial<HostEntry> = {}): HostEntry {
  return {
    name,
    hostname: name,
    port: 22,
    user: 'alexey',
    identityFile: null,
    proxyJump: null,
    forwardAgent: false,
    localForwards: [],
    remoteForwards: [],
    fromConfig: false,
    ...extra,
  };
}

const SAVED_GATEWAY_HOST = entry('hetzner', { hostname: 'hetzner-dev', gateway: { serverUrl: SERVER, deviceId: 'hetzner-dev' } });

function devices(): GatewayDevice[] {
  const observedAt = '2026-10-10T10:00:00.000Z';
  return [
    { id: 'hetzner-dev', revoked: false, presence: { state: 'online', observedAt, connectedSince: null }, advisoryHostKey: KEYS['ed25519']!.line },
    { id: 'laptop-1', revoked: false, presence: { state: 'online', observedAt, connectedSince: null }, advisoryHostKey: KEYS['ed25519']!.line },
    { id: 'win35', revoked: false, presence: { state: 'offline', observedAt }, advisoryHostKey: KEYS['ed25519']!.line },
    { id: 'mystery-1', revoked: false, presence: { state: 'unknown' }, advisoryHostKey: null },
    { id: 'old-box', revoked: true, presence: { state: 'offline', observedAt }, advisoryHostKey: null },
  ];
}

interface Platform {
  connect: ReturnType<typeof vi.fn>;
  openAccount: ReturnType<typeof vi.fn>;
  addDevice: ReturnType<typeof vi.fn>;
  listDevices: ReturnType<typeof vi.fn>;
}

function platform(options: { devicesError?: Error; connect?: ConnectResult } = {}): Platform {
  const hosts = [entry('plain-box'), SAVED_GATEWAY_HOST];
  const connect = vi.fn(async (): Promise<ConnectResult> => options.connect ?? { ok: false, error: 'nope' });
  const openAccount = vi.fn(async () => undefined);
  const listDevices = vi.fn(async (_server: string) => {
    if (options.devicesError) throw options.devicesError;
    return devices();
  });
  const addDevice = vi.fn(async (request: GatewayAddDeviceRequest) => ({
    hostName: request.name,
    pairing: {
      serverUrl: request.gateway.serverUrl,
      deviceId: request.gateway.deviceId,
      fingerprint: KEYS['ecdsab256']!.fingerprint,
      pinKind: 'host-key' as const,
      keyId: request.keyId,
    },
  }));
  provideApi({
    win: { setTitle: vi.fn(), openAccount },
    ssh: { listConfigHosts: vi.fn(async () => hosts), connect, onState: () => () => undefined, close: vi.fn(async () => true), exec: vi.fn() },
    helper: { bootstrap: async () => null },
    forwards: { isAutoEnabled: async () => false },
    preview: { onStats: () => () => undefined },
    sync: {
      status: vi.fn(async () => ({ loggedIn: true, email: 'me@example.test', keychainAvailable: true })),
      accountHosts: vi.fn(async () => null),
    },
    hosts: { groupLabel: 'On this phone', sourceName: 'saved hosts', emptyHint: 'No hosts saved.' },
    gateway: {
      defaultServerUrl: SERVER,
      devices: listDevices,
      pairings: vi.fn(async () => []),
      clientKeys: vi.fn(async () => [{ id: 'key-1', label: 'Phone key', fingerprint: 'SHA256:phone', publicKey: PHONE_KEY }]),
      addDevice,
    },
  } as unknown as PocketShellApi);
  return { connect, openAccount, addDevice, listDevices };
}

const mounted: VueWrapper[] = [];

async function mountPicker(): Promise<VueWrapper> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'hosts', component: HostPickerView },
      { path: '/host/:name', name: 'host-sessions', component: { template: '<div />' } },
    ],
  });
  await router.push('/');
  const wrapper = mount(HostPickerView, { global: { plugins: [router] }, attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  await flushPromises();
  return wrapper;
}

function rows(wrapper: VueWrapper): Array<{ id: string; status: string; add: boolean; text: string }> {
  return wrapper.findAll('[data-testid=gateway-device]').map((row) => ({
    id: row.attributes('data-device-id')!,
    status: row.attributes('data-status')!,
    add: row.find('[data-testid=gateway-device-add]').exists(),
    text: row.text(),
  }));
}

beforeEach(() => {
  setActivePinia(createPinia());
  window.localStorage.clear();
});

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  document.body.innerHTML = '';
});

describe('host picker — gateway device source', () => {
  it('lists unadded devices with the gateway presence, marks revoked, and never dials to learn it', async () => {
    const api = platform();
    const wrapper = await mountPicker();
    expect(api.listDevices).toHaveBeenCalledWith(SERVER);
    expect(rows(wrapper).map(({ id, status, add }) => ({ id, status, add }))).toEqual([
      { id: 'laptop-1', status: 'online', add: true },
      { id: 'win35', status: 'offline', add: true },
      { id: 'mystery-1', status: 'unknown', add: true },
      { id: 'old-box', status: 'revoked', add: false },
    ]);
    expect(rows(wrapper).find((row) => row.id === 'win35')!.text).toMatch(/Offline/);
    expect(rows(wrapper).find((row) => row.id === 'mystery-1')!.text).toMatch(/Status unknown/);
    expect(rows(wrapper).find((row) => row.id === 'old-box')!.text).toMatch(/Revoked/);
    // The added device is a host row, with the same presence chip, not a second device row.
    const chip = wrapper.find('[data-testid=host-gateway-presence]');
    expect(chip.exists()).toBe(true);
    expect(chip.text()).toMatch(/^Online/);
    expect(chip.classes()).toContain('online');
    expect(api.connect).not.toHaveBeenCalled();
  });

  it('a device list refused for sign-in prompts to sign in instead of a generic error', async () => {
    const api = platform({ devicesError: Object.assign(new Error('Sign in with Google first.'), { code: 'NOT_SIGNED_IN' }) });
    const wrapper = await mountPicker();
    const failure = wrapper.find('[data-testid=gateway-devices-failure]');
    expect(failure.attributes('data-kind')).toBe('sign_in_required');
    expect(wrapper.findAll('[data-testid=gateway-device]')).toHaveLength(0);
    await failure.find('button').trigger('click');
    expect(api.openAccount).toHaveBeenCalled();
  });

  it('lists the gateway the user chose (a self-hosted origin), never the default behind its back', async () => {
    window.localStorage.setItem('pocketshell.gateway.server.v1', 'wss://GW.Self.Example:8443/');
    const api = platform();
    await mountPicker();
    expect(api.listDevices).toHaveBeenCalledWith('wss://gw.self.example:8443');
    expect(api.listDevices).not.toHaveBeenCalledWith(SERVER);
  });

  it('a device-list problem is not the picker\'s dial error line', async () => {
    platform({ devicesError: Object.assign(new Error('The gateway could not be reached.'), { code: 'GATEWAY_DEVICES_UNREACHABLE' }) });
    const wrapper = await mountPicker();
    expect(wrapper.find('[data-testid=gateway-devices-failure]').attributes('data-kind')).toBe('unavailable');
    expect(wrapper.find('.picker p.error').exists()).toBe(false);
  });

  it('an account switch while loading asks to reload, not to sign in', async () => {
    platform({ devicesError: Object.assign(new Error('changed'), { code: 'GATEWAY_ACCOUNT_CHANGED' }) });
    const wrapper = await mountPicker();
    const failure = wrapper.find('[data-testid=gateway-devices-failure]');
    expect(failure.attributes('data-kind')).toBe('account_changed');
    expect(failure.find('button').text()).toBe('Reload');
  });
});

describe('add a gateway device', () => {
  async function openAdd(wrapper: VueWrapper, id: string): Promise<VueWrapper> {
    const row = wrapper.findAll('[data-testid=gateway-device]').find((candidate) => candidate.attributes('data-device-id') === id)!;
    await row.find('[data-testid=gateway-device-add]').trigger('click');
    await flushPromises();
    return wrapper;
  }

  it('saves the PASTED pin (not the advisory key), shows the public key and the manual step, and claims no authorization', async () => {
    const api = platform();
    const wrapper = await openAdd(await mountPicker(), 'win35');
    const panel = wrapper.find('[data-testid=gateway-add-device]');
    expect(panel.exists()).toBe(true);
    expect((panel.find('[data-testid=gateway-add-device-id]').element as HTMLInputElement).value).toBe('win35');
    // The gateway's advisory key is shown as a comparison hint only.
    expect(panel.find('[data-testid=gateway-add-advisory]').text()).toContain(KEYS['ed25519']!.line);
    // This device's key, the exact manual step, and the upcoming Windows command.
    expect(panel.find('[data-testid=gateway-add-public-key]').text()).toBe(PHONE_KEY);
    expect(panel.find('[data-testid=gateway-add-authorize-command]').text()).toBe(`echo '${PHONE_KEY}' >> ~/.ssh/authorized_keys`);
    expect(panel.find('[data-testid=gateway-add-windows-command]').text()).toContain('pocketshell gateway agent authorize-key --public-key');
    expect(panel.text()).toContain('requires PocketShell CLI with gateway agent (upcoming)');

    await panel.find('[data-testid=gateway-add-user]').setValue('alexey');
    await panel.find('[data-testid=gateway-add-pin]').setValue(`pinned ssh host key: ${KEYS['ecdsab256']!.line}\n`);
    await flushPromises();
    expect(panel.find('[data-testid=gateway-add-advisory-mismatch]').exists()).toBe(true);
    await panel.find('form').trigger('submit');
    await flushPromises();

    expect(api.addDevice).toHaveBeenCalledTimes(1);
    const request = api.addDevice.mock.calls[0]![0] as GatewayAddDeviceRequest;
    expect(request).toEqual({
      name: 'win35',
      username: 'alexey',
      gateway: { serverUrl: SERVER, deviceId: 'win35' },
      pin: KEYS['ecdsab256']!.line,
      keyId: 'key-1',
    });
    expect(request.pin).not.toBe(KEYS['ed25519']!.line);
    const saved = wrapper.find('[data-testid=gateway-add-saved]');
    expect(saved.text()).toContain(KEYS['ecdsab256']!.fingerprint);
    const after = wrapper.find('[data-testid=gateway-add-device]').text();
    expect(after).toContain('known only when a login succeeds');
    expect(after).not.toMatch(/\bis authorized\b|\bkey authorized\b/i);
  });

  it('refuses to save until the pin parses, and accepts a SHA256 fingerprint', async () => {
    const api = platform();
    const wrapper = await openAdd(await mountPicker(), 'laptop-1');
    const panel = wrapper.find('[data-testid=gateway-add-device]');
    await panel.find('[data-testid=gateway-add-user]').setValue('alexey');
    await panel.find('[data-testid=gateway-add-pin]').setValue(`${KEYS['ed25519']!.line} root@laptop`);
    expect(panel.find('[data-testid=gateway-add-pin-error]').exists()).toBe(true);
    expect(panel.find('[data-testid=gateway-add-save]').attributes('disabled')).toBeDefined();
    await panel.find('[data-testid=gateway-add-pin]').setValue(KEYS['ed25519']!.fingerprint);
    await panel.find('form').trigger('submit');
    await flushPromises();
    expect((api.addDevice.mock.calls[0]![0] as GatewayAddDeviceRequest).pin).toBe(KEYS['ed25519']!.fingerprint);
  });
});

describe('gateway dial refusals get their own prompt', () => {
  async function dialFailing(kind: NonNullable<ConnectResult['gatewayFailureKind']>, message: string) {
    const api = platform({ connect: { ok: false, error: message, gatewayFailureKind: kind } });
    const wrapper = await mountPicker();
    const row = wrapper.findAll('.host-row').find((candidate) => candidate.text().includes('hetzner'))!;
    await row.trigger('click');
    await flushPromises();
    expect(useConnectionStore().errorKind).toBe(kind);
    return { api, wrapper, actions: wrapper.find('[data-testid=picker-error-actions]') };
  }

  it('offline reads as offline — no sign-in prompt', async () => {
    const { wrapper, actions } = await dialFailing('host_offline', 'The host is not connected to the gateway right now — check that its agent is running.');
    expect(wrapper.find('.picker p.error').text()).toBe('The host is not connected to the gateway right now — check that its agent is running.');
    expect(actions.attributes('data-kind')).toBe('host_offline');
    expect(actions.text()).toContain('Offline');
    expect(actions.text()).not.toMatch(/sign in/i);
  });

  it('sign-in required opens the account', async () => {
    const { api, actions } = await dialFailing('sign_in_required', 'Sign in to your PocketShell account to connect through the gateway.');
    await actions.find('button').trigger('click');
    expect(api.openAccount).toHaveBeenCalled();
  });

  it('pairing required opens the pairing flow for that saved host', async () => {
    const { wrapper, actions } = await dialFailing('pairing_required', 'This device is not paired with that host for this SSH key — pair it again, then reconnect.');
    expect(actions.find('button').text()).toBe('Pair this device');
    await actions.find('button').trigger('click');
    await flushPromises();
    const panel = wrapper.find('[data-testid=gateway-add-device]');
    expect((panel.find('[data-testid=gateway-add-device-id]').element as HTMLInputElement).value).toBe('hetzner-dev');
    expect((panel.find('[data-testid=gateway-add-name]').element as HTMLInputElement).value).toBe('hetzner');
    expect((panel.find('[data-testid=gateway-add-user]').element as HTMLInputElement).value).toBe('alexey');
  });

  it('an account change offers to connect again as the current account', async () => {
    const { api, actions } = await dialFailing('account_changed', 'The signed-in account changed while connecting — reconnect as the account signed in now.');
    expect(actions.find('button').text()).toBe('Connect again');
    await actions.find('button').trigger('click');
    await flushPromises();
    expect(api.connect).toHaveBeenCalledTimes(2);
  });

  it('an ordinary failure has no gateway prompt', async () => {
    const api = platform({ connect: { ok: false, error: 'Connection refused' } });
    const wrapper = await mountPicker();
    await wrapper.findAll('.host-row').find((candidate) => candidate.text().includes('plain-box'))!.trigger('click');
    await flushPromises();
    expect(api.connect).toHaveBeenCalled();
    expect(wrapper.find('.picker p.error').text()).toBe('Connection refused');
    expect(wrapper.find('[data-testid=picker-error-actions]').exists()).toBe(false);
  });
});
