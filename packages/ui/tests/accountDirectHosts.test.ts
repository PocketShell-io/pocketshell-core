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

async function setup(options:{accountHosts:HostEntry[];trust?:boolean;visibleCount?:number;vaultState?:'locked'|'unlocked';localOnly?:boolean;accountAfterDial?:string;dialGate?:Promise<void>;closeGate?:Promise<void>;postDialAccount?:Promise<string>}){
  setActivePinia(createPinia());
  let dialed=false;
  let trustDecider: ((request: any) => Promise<string>) | undefined;
  const connect=vi.fn(async()=>{dialed=true;if(options.dialGate)await options.dialGate;return {ok:true,connectionId:'conn-account'};});
  const close=vi.fn(async()=>{if(options.closeGate)await options.closeGate;return true;});
  const installTrustedHost=vi.fn(async()=>{});
  const accountId=vi.fn(async()=>dialed&&options.postDialAccount?options.postDialAccount: dialed&&options.accountAfterDial?options.accountAfterDial:'google:orin');
  supplied.vault={platform:{accountId,installTrustedHost,trustedHostRevisions:{load:async()=>({}),save:async()=>{}}},
    store:reactive({state:options.vaultState??'unlocked',vaultId:'vault-1',epoch:1,probe:async()=>({kind:'gated'}),
      listTrustedHosts:vi.fn(async()=>[server]),getTrustedHost:vi.fn(async()=>({kind:'ok',host:server}))}),
    view:reactive({state:options.vaultState??'unlocked',localOnly:options.localOnly??false}),requestUnlock:vi.fn(async()=>true),cancelUnlock:vi.fn(),lock:vi.fn()};
  const source={provenance:'local' as const,accountDirect:true,sourceName:'saved hosts',groupLabel:'On this device',emptyHint:'No local hosts.'};
  provideApi({win:{setTitle:vi.fn(),openAccount:vi.fn()},ssh:{listConfigHosts:async()=>[],connect,onState:()=>()=>{},close,...(options.trust?{onTrustDecision:(decider: typeof trustDecider)=>{trustDecider=decider;return()=>{};}}:{})},
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
      expect(rows()).toHaveLength(options.visibleCount??1);
    }, { timeout: 3000 });
  }
  const {useConnectionStore}=await import('../src/app/stores/connection');
  return{connect,close,router,installTrustedHost,accountId,askTrust:(request:any)=>trustDecider!(request),sync:useSyncStore(),connection:useConnectionStore()};
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

async function returnToPicker(t: Awaited<ReturnType<typeof setup>>, count = 1) {
  wrapper!.unmount();
  await t.router.push('/');
  wrapper = mount(HostPickerView, {global: {plugins: [t.router]}});
  await flushPromises(); await flushPromises();
  await vi.waitFor(() => expect(rows()).toHaveLength(count));
}

async function connectThenReturn() {
  const t = await setup({accountHosts: [entry('hetzner-ssh')]});
  await rows()[0]!.trigger('click'); await flushPromises(); await flushPromises();
  expect(t.connect).toHaveBeenCalledTimes(1);
  expect(t.router.currentRoute.value.name).toBe('host-sessions');
  await returnToPicker(t);
  return t;
}

describe('returning to an account-direct connection', () => {
  it('resumes the admitted connection after actual picker remount without opening or closing SSH', async () => {
    const t = await connectThenReturn();
    await rows()[0]!.trigger('click'); await flushPromises(); await flushPromises();
    expect(t.router.currentRoute.value.name).toBe('host-sessions');
    expect(t.connect).toHaveBeenCalledTimes(1);
    expect(t.close).not.toHaveBeenCalled();
  });

  it.each([
    ['verified account', (t: Awaited<ReturnType<typeof setup>>) => { t.accountId.mockResolvedValue('google:other'); }],
  ] as const)('refuses changed %s without redial or touching another connection', async (_kind, change) => {
    const t = await connectThenReturn();
    change(t); await flushPromises();
    await rows()[0]!.trigger('click'); await flushPromises(); await flushPromises();
    expect(t.router.currentRoute.value.name).toBe('hosts');
    expect(t.connect).toHaveBeenCalledTimes(1);
    expect(t.close).not.toHaveBeenCalled();
  });

  it.each([
    ['hostname', (row: HostEntry) => { row.hostname = 'changed.example'; }],
    ['port', (row: HostEntry) => { row.port = 2200; }],
    ['user', (row: HostEntry) => { row.user = 'other'; }],
    ['alias', (row: HostEntry) => { row.name = 'changed-alias'; }],
  ] as const)('delegates an explicitly selected current row after its %s changes to the platform without disposing pooled hosts', async (_kind, change) => {
    const t = await connectThenReturn();
    change(t.sync.accountHosts![0]!); await flushPromises();
    await rows()[0]!.trigger('click'); await flushPromises(); await flushPromises();
    expect(t.router.currentRoute.value.name).toBe('host-sessions');
    expect(t.connect).toHaveBeenCalledTimes(2);
    expect(t.close).not.toHaveBeenCalled();
    const current = t.sync.accountHosts![0]!;
    expect(t.connect.mock.calls[1]![0]).toMatchObject({host: current.hostname, port: current.port,
      user: current.user, hostAlias: current.name, accountDirect: true});
  });

  it.each(['vaultId', 'epoch'] as const)('freshly dials rather than reusing prior %s admission after remount into a current changed vault scope', async field => {
    const t = await connectThenReturn();
    supplied.vault.store[field] = field === 'vaultId' ? 'vault-2' : 2;
    await returnToPicker(t);
    await rows()[0]!.trigger('click'); await flushPromises(); await flushPromises();
    expect(t.router.currentRoute.value.name).toBe('host-sessions');
    expect(t.connect).toHaveBeenCalledTimes(2);
    expect(t.close).not.toHaveBeenCalled();
  });

  it('preserves a newer foreign connection arriving during resume account verification', async () => {
    const t = await connectThenReturn();
    const account = deferred<string>();
    t.accountId.mockReturnValueOnce(account.promise);
    await rows()[0]!.trigger('click'); await flushPromises();
    t.connection.activeHost = entry('foreign-host'); t.connection.connectionId = 'conn-newer';
    account.resolve('google:orin'); await flushPromises(); await flushPromises();
    expect(t.router.currentRoute.value.name).toBe('hosts');
    expect(t.connect).toHaveBeenCalledTimes(1);
    expect(t.close).not.toHaveBeenCalled();
    expect(t.connection.connectionId).toBe('conn-newer');
  });

  it('switches to a different current account direct host without closing the platform pooled prior host', async () => {
    const t = await setup({accountHosts: [entry('hetzner-ssh'), entry('second-host')], visibleCount: 2});
    await rows()[0]!.trigger('click'); await flushPromises(); await flushPromises();
    await returnToPicker(t, 2);
    t.connect.mockResolvedValueOnce({ok: true, connectionId: 'conn-second'});
    await rows()[1]!.trigger('click'); await flushPromises(); await flushPromises();
    expect(t.router.currentRoute.value.name).toBe('host-sessions');
    expect(t.router.currentRoute.value.params.name).toBe('second-host');
    expect(t.connect).toHaveBeenCalledTimes(2);
    expect(t.close).not.toHaveBeenCalled();
    expect(t.connection.connectionId).toBe('conn-second');
  });
});

it('waits for stale owned cleanup before allowing a retap to open the next native connection', async () => {
  const dial = deferred<void>(); const close = deferred<void>();
  const t = await setup({accountHosts: [entry('hetzner-ssh')], dialGate: dial.promise, closeGate: close.promise});
  await rows()[0]!.trigger('click'); await flushPromises();
  t.sync.accountHosts![0]!.hostname = 'changed.example';
  dial.resolve(); await flushPromises(); await flushPromises();
  expect(t.close).toHaveBeenCalledWith('conn-account');
  t.sync.accountHosts![0]!.hostname = 'hetzner-ssh.example'; await flushPromises();
  await rows()[0]!.trigger('click'); await flushPromises();
  expect(t.connect).toHaveBeenCalledTimes(1);
  close.resolve(); await flushPromises(); await flushPromises();
  expect(t.connect).toHaveBeenCalledTimes(2);
  expect(t.connection.connectionId).toBe('conn-account');
  expect(t.router.currentRoute.value.name).toBe('host-sessions');
});

it.each(['equivalent foreign object', 'different connection ID', 'Gateway host', 'local host'] as const)(
  'freshly admits the selected direct row without reusing or closing an initially active pooled %s', async kind => {
    const t = await connectThenReturn();
    if (kind === 'equivalent foreign object') t.connection.activeHost = entry('hetzner-ssh');
    if (kind === 'different connection ID') t.connection.connectionId = 'conn-other';
    if (kind === 'Gateway host') t.connection.activeHost = entry('gateway-host', {
      gateway: {serverUrl: 'wss://gateway.pocketshell.io', deviceId: 'gateway'}, gatewayAuth: 'managed'});
    if (kind === 'local host') t.connection.activeHost = entry('phone-local', {local: true});
    await rows()[0]!.trigger('click'); await flushPromises(); await flushPromises();
    expect(t.router.currentRoute.value.name).toBe('host-sessions');
    expect(t.connect).toHaveBeenCalledTimes(2);
    expect(t.connect.mock.calls[1]![0]).toMatchObject({host: 'hetzner-ssh.example', hostAlias: 'hetzner-ssh', accountDirect: true});
    expect(t.close).not.toHaveBeenCalled();
  });

it('can retry an account direct dial after a native failure left a host but no live connection ID', async () => {
  const t = await setup({accountHosts: [entry('hetzner-ssh')]});
  t.connect.mockResolvedValueOnce({ok: false, connectionId: ''});
  await rows()[0]!.trigger('click'); await flushPromises(); await flushPromises();
  expect(t.connection.connectionId).toBeNull();
  expect(t.connect).toHaveBeenCalledTimes(1);
  await rows()[0]!.trigger('click'); await flushPromises(); await flushPromises();
  expect(t.connect).toHaveBeenCalledTimes(2);
  expect(t.router.currentRoute.value.name).toBe('host-sessions');
  expect(t.close).not.toHaveBeenCalled();
});

it('keeps Cancel immediate and completes the next selected direct row after the abandoned native dial closes', async () => {
  const first = deferred<{ok: boolean; connectionId: string}>();
  const t = await setup({accountHosts: [entry('hetzner-ssh'), entry('second-host')], visibleCount: 2});
  t.connect.mockImplementationOnce(() => first.promise);
  await rows()[0]!.trigger('click'); await flushPromises();
  expect(t.connect).toHaveBeenCalledTimes(1);
  const cancel = wrapper!.findAll('button').find(button => button.text() === 'Cancel')!;
  await cancel.trigger('click'); await flushPromises();
  expect(wrapper!.findAll('button').some(button => button.text() === 'Cancel')).toBe(false);
  await rows()[1]!.trigger('click'); await flushPromises();
  expect(t.router.currentRoute.value.name).toBe('hosts');
  expect(wrapper!.text()).toContain('second-host');
  expect(wrapper!.findAll('button').some(button => button.text() === 'Cancel')).toBe(true);
  first.resolve({ok: true, connectionId: 'conn-abandoned'});
  await flushPromises(); await flushPromises(); await flushPromises();
  expect(t.close).toHaveBeenCalledTimes(1);
  expect(t.close).toHaveBeenCalledWith('conn-abandoned');
  expect(t.connect).toHaveBeenCalledTimes(2);
  expect(t.router.currentRoute.value.params.name).toBe('second-host');
});

it.each(['Cancel', 'another row'] as const)('invalidates a queued direct selection when the user chooses %s while close is held', async action => {
  const first = deferred<{ok: boolean; connectionId: string}>(); const close = deferred<void>();
  const t = await setup({accountHosts: [entry('hetzner-ssh'), entry('second-host'), entry('third-host')], visibleCount: 3, closeGate: close.promise});
  t.connect.mockImplementationOnce(() => first.promise);
  await rows()[0]!.trigger('click'); await flushPromises();
  await wrapper!.findAll('button').find(button => button.text() === 'Cancel')!.trigger('click');
  await rows()[1]!.trigger('click'); await flushPromises();
  first.resolve({ok: true, connectionId: 'conn-abandoned'}); await flushPromises();
  expect(t.close).toHaveBeenCalledWith('conn-abandoned');
  expect(wrapper!.findAll('button').some(button => button.text() === 'Cancel')).toBe(true);
  await wrapper!.findAll('button').find(button => button.text() === 'Cancel')!.trigger('click');
  if (action === 'another row') await rows()[2]!.trigger('click');
  await flushPromises(); close.resolve(); await flushPromises(); await flushPromises(); await flushPromises();
  expect(t.close).toHaveBeenCalledTimes(1);
  expect(t.connect).toHaveBeenCalledTimes(action === 'Cancel' ? 1 : 2);
  expect(t.router.currentRoute.value.name).toBe(action === 'Cancel' ? 'hosts' : 'host-sessions');
  if (action === 'another row') expect(t.router.currentRoute.value.params.name).toBe('third-host');
});


const trustQuestion = (name: string) => ({hostLabel: name, hostname: `${name}.example`, port: 22,
  user: 'orin', keyType: 'ssh-ed25519', fingerprintSha256: 'SHA256:fixture'});

it.each(['already pending', 'arriving after Cancel'] as const)('rejects only the cancelled direct attempt TOFU question %s so the next selection can run', async timing => {
  const arrival = deferred<void>(); const choices: string[] = [];
  const t = await setup({accountHosts: [entry('hetzner-ssh'), entry('second-host')], visibleCount: 2, trust: true});
  t.connect.mockImplementationOnce(async () => {
    if (timing === 'arriving after Cancel') await arrival.promise;
    choices.push(await t.askTrust(trustQuestion('hetzner-ssh')));
    return {ok: false, connectionId: ''};
  });
  await rows()[0]!.trigger('click'); await flushPromises();
  if (timing === 'already pending') expect(t.connection.pendingTrust).not.toBeNull();
  await wrapper!.findAll('button').find(button => button.text() === 'Cancel')!.trigger('click');
  await rows()[1]!.trigger('click'); arrival.resolve();
  await flushPromises(); await flushPromises(); await flushPromises();
  expect(choices).toEqual(['reject']);
  expect(t.connection.pendingTrust).toBeNull();
  expect(t.connect).toHaveBeenCalledTimes(2);
  expect(t.router.currentRoute.value.params.name).toBe('second-host');
});

it.each(['foreign question', 'newer host object'] as const)('does not answer a %s when another direct attempt is cancelled', async kind => {
  const first = deferred<{ok: boolean; connectionId: string}>();
  const t = await setup({accountHosts: [entry('hetzner-ssh')], trust: true});
  t.connect.mockImplementationOnce(() => first.promise);
  await rows()[0]!.trigger('click'); await flushPromises();
  if (kind === 'newer host object') t.connection.activeHost = entry('foreign-host');
  const question = t.askTrust(trustQuestion(kind === 'foreign question' ? 'foreign-host' : 'hetzner-ssh'));
  await flushPromises();
  await wrapper!.findAll('button').find(button => button.text() === 'Cancel')!.trigger('click');
  await flushPromises();
  expect(t.connection.pendingTrust).not.toBeNull();
  t.connection.answerTrust('reject'); await question;
  first.resolve({ok: false, connectionId: ''}); await flushPromises();
});

it('rejects its later TOFU question after unmount and disposes its watcher after the attempt settles', async () => {
  const arrival = deferred<void>(); const choices: string[] = [];
  const t = await setup({accountHosts: [entry('hetzner-ssh')], trust: true});
  t.connect.mockImplementationOnce(async () => {
    await arrival.promise;
    choices.push(await t.askTrust(trustQuestion('hetzner-ssh')));
    return {ok: false, connectionId: ''};
  });
  await rows()[0]!.trigger('click'); await flushPromises();
  const navigation = vi.spyOn(t.router, 'push');
  wrapper!.unmount(); wrapper = undefined; arrival.resolve();
  await flushPromises(); await flushPromises(); await flushPromises();
  expect(choices).toEqual(['reject']);
  expect(t.connection.pendingTrust).toBeNull();
  const later = t.askTrust(trustQuestion('hetzner-ssh')); await flushPromises();
  expect(t.connection.pendingTrust).not.toBeNull();
  t.connection.answerTrust('reject'); await later;
  expect(navigation).not.toHaveBeenCalled();
});

it('preserves a newer same-alias host object when a cancelled account-direct dial returns late', async () => {
  const first = deferred<{ok: boolean; connectionId: string}>();
  const t = await setup({accountHosts: [entry('hetzner-ssh')]});
  t.connect.mockImplementationOnce(() => first.promise);
  await rows()[0]!.trigger('click'); await flushPromises();
  await wrapper!.findAll('button').find(button => button.text() === 'Cancel')!.trigger('click');
  const foreign = entry('hetzner-ssh');
  t.connection.activeHost = foreign;
  t.connection.connectionId = 'conn-newer';
  t.connection.state = 'connected';
  first.resolve({ok: true, connectionId: 'conn-old'});
  await flushPromises(); await flushPromises();
  expect(t.close).not.toHaveBeenCalled();
  expect(t.connection.activeHost).toBe(foreign);
  expect(t.router.currentRoute.value.name).toBe('hosts');
});
