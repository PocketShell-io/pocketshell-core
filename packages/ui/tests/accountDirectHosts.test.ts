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
beforeEach(()=>{localStorage.clear();resetAutoConnectLatch();});
afterEach(()=>{wrapper?.unmount();wrapper=undefined;});

async function setup(options:{accountHosts:HostEntry[];vaultState?:'locked'|'unlocked';localOnly?:boolean;accountAfterDial?:string;dialGate?:Promise<void>;postDialAccount?:Promise<string>}){
  setActivePinia(createPinia());
  let dialed=false;
  const connect=vi.fn(async()=>{dialed=true;if(options.dialGate)await options.dialGate;return {ok:true,connectionId:'conn-account'};});
  const close=vi.fn(async()=>true);
  const installTrustedHost=vi.fn(async()=>{});
  const accountId=vi.fn(async()=>dialed&&options.postDialAccount?options.postDialAccount: dialed&&options.accountAfterDial?options.accountAfterDial:'google:orin');
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
  if (options.vaultState !== 'locked' && !options.localOnly) {
    await vi.waitFor(() => {
      expect(wrapper!.find('[data-testid="trusted-server-connect"]').exists()).toBe(true);
      expect(rows()).toHaveLength(1);
    }, { timeout: 3000 });
  }
  const {useConnectionStore}=await import('../src/app/stores/connection');
  return{connect,close,router,installTrustedHost,accountId,sync:useSyncStore(),connection:useConnectionStore()};
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
    expect(t.close).toHaveBeenCalledWith('conn-account');
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return {promise, resolve, reject};
}

describe('pending account-only direct SSH admission', () => {
  it.each([
    ['hostname', (row: HostEntry) => { row.hostname = 'changed.example'; }],
    ['port', (row: HostEntry) => { row.port = 2200; }],
    ['username', (row: HostEntry) => { row.user = 'other-user'; }],
    ['alias', (row: HostEntry) => { row.name = 'renamed'; }],
    ['Gateway marker', (row: HostEntry) => { row.gateway = {serverUrl: 'wss://gateway.pocketshell.io',deviceId: 'foreign'}; }],
    ['local marker', (row: HostEntry) => { row.local = true; }],
  ] as const)('closes its stale connection after the current row changes %s in place', async (_kind, change) => {
    const gate = deferred<void>();
    const t = await setup({accountHosts: [entry('hetzner-ssh')], dialGate: gate.promise});
    await rows()[0]!.trigger('click'); await flushPromises();
    expect(t.connect).toHaveBeenCalledTimes(1);
    change(t.sync.accountHosts![0]!);
    await flushPromises(); gate.resolve(); await flushPromises(); await flushPromises();
    expect(t.router.currentRoute.value.name).toBe('hosts');
    expect(t.close).toHaveBeenCalledTimes(1);
    expect(t.close).toHaveBeenCalledWith('conn-account');
    expect(t.connection.connectionId).toBeNull();
  });

  it.each(['removed', 'replaced'] as const)('closes its stale connection when the account row is %s', async change => {
    const gate = deferred<void>();
    const t = await setup({accountHosts: [entry('hetzner-ssh')], dialGate: gate.promise});
    await rows()[0]!.trigger('click'); await flushPromises();
    expect(t.connect).toHaveBeenCalledTimes(1);
    t.sync.accountHosts = change === 'removed' ? [] : [entry('hetzner-ssh', {hostname: 'replacement.example'})];
    await flushPromises(); gate.resolve(); await flushPromises(); await flushPromises();
    expect(t.router.currentRoute.value.name).toBe('hosts');
    expect(t.close).toHaveBeenCalledTimes(1);
    expect(t.close).toHaveBeenCalledWith('conn-account');
  });

  it.each(['different endpoint', 'same endpoint'] as const)('never closes a newer connection with %s while the final account check is pending', async endpoint => {
    const gate = deferred<void>();
    const account = deferred<string>();
    const t = await setup({accountHosts: [entry('hetzner-ssh')], dialGate: gate.promise, postDialAccount: account.promise});
    await rows()[0]!.trigger('click'); await flushPromises();
    expect(t.connect).toHaveBeenCalledTimes(1);
    t.sync.accountHosts = [];
    gate.resolve(); await flushPromises();
    expect(t.connection.connectionId).toBe('conn-account');
    t.connection.activeHost = endpoint === 'same endpoint' ? entry('hetzner-ssh') : entry('newer-host');
    t.connection.connectionId = 'conn-newer';
    account.resolve('google:orin'); await flushPromises(); await flushPromises();
    expect(t.router.currentRoute.value.name).toBe('hosts');
    expect(t.close).not.toHaveBeenCalled();
    expect(t.connection.connectionId).toBe('conn-newer');
  });
});

describe('failed final account verification after direct SSH', () => {
  it('reports failed verification and closes its successfully opened owned connection', async () => {
    const dial = deferred<void>();
    const account = deferred<string>();
    const t = await setup({accountHosts: [entry('hetzner-ssh')], dialGate: dial.promise, postDialAccount: account.promise});
    const reported: unknown[] = [];
    wrapper!.vm.$.appContext.config.errorHandler = error => { reported.push(error); };
    await rows()[0]!.trigger('click'); await flushPromises();
    dial.resolve(); await flushPromises();
    expect(t.connection.connectionId).toBe('conn-account');
    account.reject(new Error('Current account verification unavailable'));
    await flushPromises(); await flushPromises();
    expect(t.router.currentRoute.value.name).toBe('hosts');
    expect(t.close).toHaveBeenCalledTimes(1);
    expect(t.close).toHaveBeenCalledWith('conn-account');
    expect(t.connection.connectionId).toBeNull();
    expect(wrapper!.text()).toContain('Your account could not be verified. Connect again.');
    expect(reported).toEqual([]);
  });

  it.each(['different endpoint', 'same endpoint'] as const)('never closes a newer connection with %s when final verification fails', async endpoint => {
    const dial = deferred<void>();
    const account = deferred<string>();
    const t = await setup({accountHosts: [entry('hetzner-ssh')], dialGate: dial.promise, postDialAccount: account.promise});
    const reported: unknown[] = [];
    wrapper!.vm.$.appContext.config.errorHandler = error => { reported.push(error); };
    await rows()[0]!.trigger('click'); await flushPromises();
    dial.resolve(); await flushPromises();
    expect(t.connection.connectionId).toBe('conn-account');
    t.connection.activeHost = endpoint === 'same endpoint' ? entry('hetzner-ssh') : entry('newer-host');
    t.connection.connectionId = 'conn-newer';
    account.reject(new Error('Current account verification unavailable'));
    await flushPromises(); await flushPromises();
    expect(t.router.currentRoute.value.name).toBe('hosts');
    expect(t.close).not.toHaveBeenCalled();
    expect(t.connection.connectionId).toBe('conn-newer');
    expect(reported).toEqual([]);
  });
});
