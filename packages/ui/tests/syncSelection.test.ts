// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeSyncPayload, type HostEntry, type SyncPullResult } from '@pocketshell/core';
import { provideApi } from '../src/app/ipc';
import type { PocketShellApi } from '../src/app/api';
import { useConnectionStore } from '../src/app/stores/connection';
import { useSettingsStore } from '../src/app/stores/settings';
import { useSyncStore } from '../src/app/stores/sync';
import AccountView from '../src/app/views/AccountView.vue';

/**
 * The one tick rule every client shares (pocketshell#3072, D43): every
 * account host stays selected unless the user explicitly unticked it. An
 * untouched "Sync now" therefore never removes a host from the account —
 * not when this machine's own host list (desktop ~/.ssh/config, the web's
 * synced list, the phone's saved hosts) also has the alias, not on a first
 * sync that runs before the account was ever checked, and not after a
 * restart. Only an explicit untick, made now or persisted from earlier,
 * removes one.
 *
 * Each test drives the real shared sync store (and, where the label is the
 * point, the real AccountView) over a scripted `api.sync` that holds an
 * in-memory account, so the assertion is what the account contains after the
 * push — the thing every other device then reads.
 */

function host(name: string, hostname = `${name}.example.net`): HostEntry {
  return {
    name,
    hostname,
    port: 22,
    user: 'alexey',
    identityFile: null,
    proxyJump: null,
    forwardAgent: false,
    localForwards: [],
    remoteForwards: [],
    fromConfig: true,
  };
}

/** An account in memory: pull decrypts it, push replaces it on a version. */
function fakeAccount(initial: HostEntry[] | null) {
  const state = { hosts: initial, version: initial === null ? 0 : 5 };
  /** What the platform's session cache would answer before any pull here. */
  let sessionCache: HostEntry[] | null = null;
  const sync: PocketShellApi['sync'] = {
    status: vi.fn(async () => ({ loggedIn: true, email: 'a@b.c', keychainAvailable: true })),
    login: vi.fn(async () => 'a@b.c'),
    logout: vi.fn(async () => undefined),
    pull: vi.fn(async (): Promise<SyncPullResult> => (state.hosts === null
      ? { kind: 'absent' }
      : { kind: 'ok', version: state.version, plaintext: serializeSyncPayload(state.hosts) })),
    push: vi.fn(async (_slot: string, plaintext: string) => {
      state.hosts = (JSON.parse(plaintext) as { hosts: HostEntry[] }).hosts;
      state.version += 1;
      return { kind: 'ok' as const, version: state.version };
    }),
    accountHosts: vi.fn(async () => sessionCache),
    applyHosts: vi.fn(async () => ({ added: [] })),
  };
  return {
    sync,
    names: () => state.hosts?.map((entry) => entry.name) ?? null,
    setSessionCache(hosts: HostEntry[] | null) { sessionCache = hosts; },
    /** Another device writes the account. */
    replace(hosts: HostEntry[]) { state.hosts = hosts; state.version += 1; },
  };
}

function provide(account: ReturnType<typeof fakeAccount>, local: HostEntry[]): void {
  provideApi({
    sync: account.sync,
    ssh: {
      listConfigHosts: vi.fn(async () => local),
      onState: () => () => undefined,
      exec: vi.fn(),
      close: vi.fn(async () => true),
      connect: vi.fn(),
    },
    win: { setTitle: vi.fn() },
  } as unknown as PocketShellApi);
}

/** A launched app: a fresh pinia over the same persisted localStorage. */
async function launch(account: ReturnType<typeof fakeAccount>, local: HostEntry[]) {
  setActivePinia(createPinia());
  provide(account, local);
  const sync = useSyncStore();
  await sync.refreshStatus();
  await useConnectionStore().loadHosts();
  sync.passphrase = 'pw';
  return sync;
}

beforeEach(() => {
  localStorage.clear();
});

describe('one tick rule: an untouched Sync now keeps every account host (#3072)', () => {
  it('desktop: a host in both ~/.ssh/config and the account stays in the account', async () => {
    // The reported scenario: the config has hetzner and another host, the
    // account holds hetzner and fixture, and the user only ever ticked
    // `other`. They check the account, then press Sync now.
    const account = fakeAccount([host('hetzner'), host('fixture', 'fixture.other.machine')]);
    const sync = await launch(account, [host('hetzner'), host('other')]);
    useSettingsStore().syncSelectedHosts = ['other'];

    await sync.loadAccount();
    expect(useSettingsStore().syncSelectedHosts).toEqual(expect.arrayContaining(['hetzner', 'fixture']));
    await sync.syncNow();

    expect(sync.message?.kind).toBe('ok');
    expect(account.names()).toEqual(expect.arrayContaining(['hetzner', 'fixture', 'other']));
  });

  it('first sync before the account was ever checked keeps the overlapping host', async () => {
    const account = fakeAccount([host('hetzner'), host('fixture')]);
    const sync = await launch(account, [host('hetzner'), host('other')]);
    useSettingsStore().syncSelectedHosts = ['other'];

    // No Check account: Sync now is the first contact with the account.
    await sync.syncNow();

    expect(sync.message?.kind).toBe('ok');
    expect(account.names()).toEqual(expect.arrayContaining(['hetzner', 'fixture', 'other']));
    expect(useSettingsStore().syncSelectedHosts).toEqual(expect.arrayContaining(['hetzner', 'fixture']));
  });

  it('account-only hosts are restored and stay in the account', async () => {
    const account = fakeAccount([host('a'), host('b')]);
    const sync = await launch(account, []);

    await sync.loadAccount();
    await sync.syncNow();

    expect(account.names()).toEqual(['a', 'b']);
  });

  it('web/phone: every local host IS an account host, and none is dropped', async () => {
    // The web's local list is the synced account itself, and a phone that
    // saved its hosts from the account has the same overlap. The session
    // cache seeds the account copy before any pull in this window.
    const everything = [host('hetzner'), host('fixture'), host('nas')];
    const account = fakeAccount(everything);
    account.setSessionCache(everything);
    const sync = await launch(account, everything);
    // Only one ticked on its own; the other two were never decided.
    useSettingsStore().syncSelectedHosts = ['nas'];
    await sync.refreshStatus();

    await sync.syncNow();

    expect(account.names()).toEqual(expect.arrayContaining(['hetzner', 'fixture', 'nas']));
  });

  it('an explicit untick still removes the host from the account', async () => {
    const account = fakeAccount([host('hetzner'), host('fixture')]);
    const sync = await launch(account, [host('hetzner')]);

    await sync.loadAccount();
    sync.setSelected('hetzner', false);
    await sync.syncNow();

    expect(account.names()).toEqual(['fixture']);
  });

  it('an untick persisted before a restart still removes the host', async () => {
    const account = fakeAccount([host('hetzner'), host('fixture')]);
    const first = await launch(account, [host('hetzner')]);
    await first.loadAccount();
    first.setSelected('hetzner', false);

    // Restart: a new store over the same persisted settings, no passphrase.
    const second = await launch(account, [host('hetzner')]);
    await second.syncNow();

    expect(account.names()).toEqual(['fixture']);
  });

  it('a restart without an untick keeps the overlapping host', async () => {
    const account = fakeAccount([host('hetzner'), host('fixture')]);
    const first = await launch(account, [host('hetzner'), host('other')]);
    useSettingsStore().syncSelectedHosts = ['other'];
    await first.loadAccount();

    const second = await launch(account, [host('hetzner'), host('other')]);
    await second.syncNow();

    expect(account.names()).toEqual(expect.arrayContaining(['hetzner', 'fixture', 'other']));
  });

  it('ticking again cancels the untick', async () => {
    const account = fakeAccount([host('hetzner'), host('fixture')]);
    const sync = await launch(account, [host('hetzner')]);
    await sync.loadAccount();
    sync.setSelected('hetzner', false);
    sync.setSelected('hetzner', true);

    await sync.syncNow();

    expect(account.names()).toEqual(expect.arrayContaining(['hetzner', 'fixture']));
  });

  it('an untick is spent once the host has left the account: a later re-add elsewhere is kept', async () => {
    const account = fakeAccount([host('hetzner'), host('fixture')]);
    const sync = await launch(account, [host('hetzner')]);
    await sync.loadAccount();
    sync.setSelected('hetzner', false);
    await sync.syncNow();
    expect(account.names()).toEqual(['fixture']);
    // The next pull sees the decision carried out.
    await sync.loadAccount();

    // Another device adds hetzner back; this machine's old untick must not
    // silently delete it again on the next untouched Sync now.
    account.replace([host('fixture'), host('hetzner', 'hetzner.new')]);
    await sync.syncNow();

    expect(account.names()).toEqual(expect.arrayContaining(['fixture', 'hetzner']));
  });

  it('signing out forgets unticks, so the next account starts with every host kept', async () => {
    const account = fakeAccount([host('hetzner'), host('fixture')]);
    const sync = await launch(account, [host('hetzner')]);
    await sync.loadAccount();
    sync.setSelected('hetzner', false);

    await sync.logout();
    await sync.login();
    sync.passphrase = 'pw';
    await sync.syncNow();

    expect(account.names()).toEqual(expect.arrayContaining(['hetzner', 'fixture']));
  });
});

describe('AccountView never shows "remove on sync" without a user action (#3072)', () => {
  async function mountAccount(account: ReturnType<typeof fakeAccount>, local: HostEntry[]) {
    setActivePinia(createPinia());
    provide(account, local);
    const wrapper = mount(AccountView);
    await flushPromises();
    return wrapper;
  }

  function rowLabel(wrapper: Awaited<ReturnType<typeof mountAccount>>, name: string): string {
    const row = wrapper.findAll('.account-host-row').find((li) => li.find('.host-alias').text() === name);
    if (!row) throw new Error(`no row for ${name}`);
    return row.get('.status-chip').text();
  }

  it('after Check account, a config host that is in the account reads "In account", ticked', async () => {
    const account = fakeAccount([host('hetzner'), host('fixture')]);
    const wrapper = await mountAccount(account, [host('hetzner')]);
    useSyncStore().passphrase = 'pw';

    await wrapper.findAll('button').find((b) => b.text() === 'Check account')!.trigger('click');
    await flushPromises();

    expect(wrapper.text()).not.toContain('remove on sync');
    expect(rowLabel(wrapper, 'hetzner')).toBe('In account');
    const box = wrapper.findAll('.account-host-row')
      .find((li) => li.find('.host-alias').text() === 'hetzner')!
      .get('input[type=checkbox]').element as HTMLInputElement;
    expect(box.checked).toBe(true);
  });

  it('with the account seeded from the session cache, no row reads "remove on sync"', async () => {
    const everything = [host('hetzner'), host('fixture')];
    const account = fakeAccount(everything);
    account.setSessionCache(everything);
    const wrapper = await mountAccount(account, everything);

    expect(wrapper.text()).not.toContain('remove on sync');
    expect(rowLabel(wrapper, 'hetzner')).toBe('In account');
  });

  it('an explicit untick is what makes a row read "remove on sync"', async () => {
    const account = fakeAccount([host('hetzner'), host('fixture')]);
    const wrapper = await mountAccount(account, [host('hetzner')]);
    useSyncStore().passphrase = 'pw';
    await wrapper.findAll('button').find((b) => b.text() === 'Check account')!.trigger('click');
    await flushPromises();

    const row = wrapper.findAll('.account-host-row').find((li) => li.find('.host-alias').text() === 'hetzner')!;
    await row.get('input[type=checkbox]').setValue(false);

    expect(rowLabel(wrapper, 'hetzner')).toBe('In account · remove on sync');
  });
});
