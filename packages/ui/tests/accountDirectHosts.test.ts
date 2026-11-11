// @vitest-environment jsdom
import {flushPromises,mount} from '@vue/test-utils';
import {createPinia,setActivePinia} from 'pinia';
import {createMemoryHistory,createRouter} from 'vue-router';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {reactive} from 'vue';
import {provideApi} from '../src/app/ipc';
import type {PocketShellApi} from '../src/app/api';
import type {HostEntry} from '@pocketshell/core';
import {resetAutoConnectLatch} from '../src/app/autoConnect';
const supplied=vi.hoisted(()=>({vault:null as any}));
vi.mock('../src/app/keyVault',()=>({useKeyVault:()=>supplied.vault}));
import HostPickerView from '../src/app/views/HostPickerView.vue';
const entry=(name:string,extra:Partial<HostEntry>={})=>({name,hostname:`${name}.example`,user:'orin',port:22,identityFile:null,proxyJump:null,forwardAgent:false,localForwards:[],remoteForwards:[],fromConfig:false,...extra}) as HostEntry;
const server={accountId:'google:orin',vaultId:'vault-1',epoch:1,revision:1,version:1,serverUrl:'wss://gateway.pocketshell.io',deviceId:'desktop-1',
  hostAlias:'Desktop Gateway',username:'orin',keyId:'k',sshHostKey:'pin',devicePublicKey:'id',status:'active',updatedAt:'2026-11-05T00:00:00.000Z'};
let wrapper:ReturnType<typeof mount>|undefined;
beforeEach(()=>{setActivePinia(createPinia());localStorage.clear();resetAutoConnectLatch();});
afterEach(()=>{wrapper?.unmount();wrapper=undefined;});

async function setup(options:{accountHosts:HostEntry[];vaultState?:'locked'|'unlocked';localOnly?:boolean;accountAfterDial?:string}){
  let dialed=false;
  const connect=vi.fn(async()=>{dialed=true;return {ok:true,connectionId:'conn-account'};});
  const close=vi.fn(async()=>true);
  const installTrustedHost=vi.fn(async()=>{});
  const accountId=vi.fn(async()=>dialed&&options.accountAfterDial?options.accountAfterDial:'google:orin');
  supplied.vault={platform:{accountId,installTrustedHost,trustedHostRevisions:{load:async()=>({}),save:async()=>{}}},
    store:reactive({state:options.vaultState??'unlocked',vaultId:'vault-1',epoch:1,probe:async()=>({kind:'gated'}),
      listTrustedHosts:vi.fn(async()=>[server]),getTrustedHost:vi.fn(async()=>({kind:'ok',host:server}))}),
    view:reactive({state:options.vaultState??'unlocked',localOnly:options.localOnly??false}),requestUnlock:vi.fn(async()=>true),cancelUnlock:vi.fn(),lock:vi.fn()};
  const source={provenance:'local' as const,accountDirect:true,sourceName:'saved hosts',groupLabel:'On this device',emptyHint:'No local hosts.'};
  provideApi({win:{setTitle:vi.fn(),openAccount:vi.fn()},ssh:{listConfigHosts:async()=>[],connect,onState:()=>()=>{},close},
    helper:{bootstrap:async()=>null},forwards:{isAutoEnabled:async()=>false},preview:{onStats:()=>()=>{}},
    sync:{status:async()=>({loggedIn:true,email:'orin@example.test',keychainAvailable:true}),accountHosts:async()=>options.accountHosts},hosts:source} as unknown as PocketShellApi);
  const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',name:'hosts',component:{template:'<div/>'}},
    {path:'/host/:name',name:'host-sessions',component:{template:'<div/>'}},{path:'/host/:name/folder/:folder',name:'folder',component:{template:'<div/>'}}]});
  await router.push('/');
  wrapper=mount(HostPickerView,{global:{plugins:[router]}});
  await flushPromises();await flushPromises();
  const {useSyncStore}=await import('../src/app/stores/sync');
  await useSyncStore().refreshStatus();await flushPromises();
  return{connect,close,router,installTrustedHost,accountId};
}
const rows=()=>wrapper!.findAll('.host-row');

describe('account-only direct SSH row beside a signed-in trusted Gateway server',()=>{
  it('lists both, imports the direct row explicitly, and never installs it as a Gateway descriptor',async()=>{
    const direct=entry('hetzner-ssh');
    const settingsGateway=entry('settings-gateway',{gateway:{serverUrl:'wss://gateway.pocketshell.io',deviceId:'forged'},gatewayAuth:'managed'});
    const t=await setup({accountHosts:[direct,settingsGateway,entry('Desktop Gateway')]});
    // Verified Gateway server stays available; the settings rows are not it.
    expect(wrapper!.find('[data-testid="trusted-server-connect"]').text()).toBe('Desktop Gateway');
    expect(wrapper!.text()).toContain('In your account · direct SSH');
    expect(rows().map(r=>r.text())).toEqual([expect.stringContaining('hetzner-ssh')]);
    expect(wrapper!.text()).not.toContain('settings-gateway');
    await rows()[0]!.trigger('click');await flushPromises();await flushPromises();
    expect(t.connect).toHaveBeenCalledTimes(1);
    expect(t.connect.mock.calls[0]![0]).toMatchObject({host:'hetzner-ssh.example',hostAlias:'hetzner-ssh',user:'orin',port:22,accountDirect:true});
    expect(t.connect.mock.calls[0]![0]).not.toHaveProperty('gateway');
    expect(t.installTrustedHost).not.toHaveBeenCalled();
    expect(t.router.currentRoute.value.name).toBe('host-sessions');
    expect(t.router.currentRoute.value.params.name).toBe('hetzner-ssh');
  });
  it('is hidden while the vault is locked or SSH without an account is chosen',async()=>{
    await setup({accountHosts:[entry('hetzner-ssh')],vaultState:'locked'});
    expect(rows()).toHaveLength(0);wrapper!.unmount();
    await setup({accountHosts:[entry('hetzner-ssh')],localOnly:true});
    expect(rows()).toHaveLength(0);
  });
  it('closes the connection and opens nothing when the account changes during the dial',async()=>{
    const t=await setup({accountHosts:[entry('hetzner-ssh')],accountAfterDial:'google:other'});
    await rows()[0]!.trigger('click');await flushPromises();await flushPromises();
    expect(t.router.currentRoute.value.name).toBe('hosts');
    expect(wrapper!.text()).toContain('Your account or host changed');
  });
});
