// @vitest-environment jsdom
// pocketshell#3189: the picker's account chip shows the background sync —
// a pulse while it runs, "Not synced · retry" (tap retries) when it failed,
// "Signed out" when the sign-in was lost — and only in trusted-account
// mode, so the desktop chip is unchanged (D44).
import {flushPromises,mount} from '@vue/test-utils';
import {createPinia,setActivePinia} from 'pinia';
import {createMemoryHistory,createRouter} from 'vue-router';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {reactive} from 'vue';
import {provideApi} from '../src/app/ipc';
import type {PocketShellApi} from '../src/app/api';
import {resetAutoConnectLatch} from '../src/app/autoConnect';
import {writeCachedServers} from '../src/app/trustedServersCache';
const supplied=vi.hoisted(()=>({vault:null as any}));
vi.mock('../src/app/keyVault',()=>({useKeyVault:()=>supplied.vault}));
import HostPickerView from '../src/app/views/HostPickerView.vue';
const EMAIL='orin@example.test';
let wrapper:ReturnType<typeof mount>|undefined;
beforeEach(()=>{setActivePinia(createPinia());localStorage.clear();resetAutoConnectLatch();});
afterEach(()=>{wrapper?.unmount();wrapper=undefined;});

async function setup(options:{trusted:boolean;prepare?:()=>Promise<unknown>}) {
  const openAccount=vi.fn();
  supplied.vault=options.trusted?{platform:{accountId:vi.fn(async()=>'google:orin'),installTrustedHost:vi.fn(),
    trustedHostRevisions:{load:vi.fn(async()=>({})),save:vi.fn(async()=>{})},prepareAccount:vi.fn(options.prepare??(()=>new Promise(()=>{})))},
  store:{state:'locked',vaultId:'v',epoch:1},view:reactive({state:'locked',localOnly:false}),requestUnlock:vi.fn(async()=>false),cancelUnlock:vi.fn(),lock:vi.fn()}:null;
  provideApi({win:{setTitle:vi.fn(),openAccount},ssh:{listConfigHosts:async()=>[],connect:vi.fn(),onState:()=>()=>{},close:vi.fn()},
    helper:{bootstrap:async()=>null},forwards:{isAutoEnabled:async()=>false},preview:{onStats:()=>()=>{}},
    sync:{status:async()=>({loggedIn:true,email:EMAIL,keychainAvailable:true}),accountHosts:async()=>null}} as unknown as PocketShellApi);
  const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',name:'hosts',component:{template:'<div/>'}},{path:'/host/:name',name:'host-sessions',component:{template:'<div/>'}}]});
  await router.push('/');
  wrapper=mount(HostPickerView,{global:{plugins:[router]}});
  await flushPromises();await flushPromises();
  return {openAccount,prepare:supplied.vault?.platform.prepareAccount};
}
const chip=()=>wrapper!.get('[data-testid="account-chip"]');

describe('account chip sync state (#3189)',()=>{
  it('pulses quietly while the background check runs, with the email still shown',async()=>{
    writeCachedServers(EMAIL,'google:orin',[{accountId:'google:orin',vaultId:'v',epoch:1,revision:1,serverUrl:'wss://g',deviceId:'d',hostAlias:'Hetzner',status:'active'} as never]);
    await setup({trusted:true});
    expect(chip().attributes('data-sync-phase')).toBe('syncing');
    expect(chip().find('.account-status-dot.syncing').exists()).toBe(true);
    expect(chip().text()).toContain(EMAIL);
    expect(wrapper!.text()).not.toContain('Checking your Google account');
  });
  it('shows Not synced · retry after a failed sync, and a tap retries instead of navigating',async()=>{
    const fail=()=>Promise.reject(Object.assign(new Error('The sync service could not be reached (SocketTimeoutException).'),{code:'SYNC_NETWORK_FAILED'}));
    const t=await setup({trusted:true,prepare:fail});
    expect(chip().attributes('data-sync-phase')).toBe('offline');
    expect(wrapper!.get('[data-testid="account-chip-state"]').text()).toBe('Not synced · retry');
    expect(chip().find('.account-status-dot.not-synced').exists()).toBe(true);
    // The words sit on their own line under the header; the chip keeps the dot and an icon only.
    expect(chip().find('[data-testid="account-chip-icon"]').exists()).toBe(true);
    expect(chip().text()).not.toContain(EMAIL);
    expect(chip().find('[data-testid="account-chip-state"]').exists()).toBe(false);
    expect(wrapper!.html()).not.toMatch(/Exception/);
    await chip().trigger('click');await flushPromises();
    expect(t.prepare).toHaveBeenCalledTimes(2);
    await wrapper!.get('[data-testid="account-chip-state"]').trigger('click');await flushPromises();
    expect(t.prepare).toHaveBeenCalledTimes(3);
    expect(t.openAccount).not.toHaveBeenCalled();
  });
  it('shows Signed out when the sign-in was lost',async()=>{
    writeCachedServers(EMAIL,'google:orin',[{accountId:'google:orin',vaultId:'v',epoch:1,revision:1,serverUrl:'wss://g',deviceId:'d',hostAlias:'Hetzner',status:'active'} as never]);
    await setup({trusted:true,prepare:()=>Promise.reject(Object.assign(new Error('gone'),{code:'NOT_SIGNED_IN'}))});
    expect(chip().attributes('data-sync-phase')).toBe('reauth');
    expect(wrapper!.get('[data-testid="account-chip-state"]').text()).toBe('Signed out');
    expect(chip().find('[data-testid="account-chip-icon"]').exists()).toBe(true);
  });
  it('without trusted-account mode (desktop) the chip is unchanged: email, no phase, tap opens the account',async()=>{
    const t=await setup({trusted:false});
    expect(chip().attributes('data-sync-phase')).toBe('idle');
    expect(wrapper!.get('[data-testid="account-chip-state"]').text()).toBe(EMAIL);
    expect(chip().find('.account-status-dot.syncing').exists()).toBe(false);
    expect(chip().find('.account-status-dot.not-synced').exists()).toBe(false);
    expect(wrapper!.find('.account-state-line').exists()).toBe(false);
    expect(chip().find('[data-testid="account-chip-icon"]').exists()).toBe(false);
    await chip().trigger('click');
    expect(t.openAccount).toHaveBeenCalledTimes(1);
  });
});
