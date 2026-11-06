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
import {useSettingsStore} from '../src/app/stores/settings';
const supplied=vi.hoisted(()=>({vault:null as any}));
vi.mock('../src/app/keyVault',()=>({useKeyVault:()=>supplied.vault}));
import HostPickerView from '../src/app/views/HostPickerView.vue';
const entry=(name:string,extra:Partial<HostEntry>={})=>({name,hostname:name,user:'orin',port:22,identityFile:null,proxyJump:null,forwardAgent:false,localForwards:[],remoteForwards:[],fromConfig:false,...extra});
let wrapper:ReturnType<typeof mount>|undefined;
beforeEach(()=>{setActivePinia(createPinia());localStorage.clear();resetAutoConnectLatch();});
afterEach(()=>{wrapper?.unmount();wrapper=undefined;});

async function setup(options:{provenance?:'local'|'account';signedIn?:boolean;legacy?:boolean;localOnly?:boolean;hosts?:HostEntry[];accountHosts?:HostEntry[];defaultHost?:string}={}) {
  const local=entry('manual-device'), imported=entry('imported-device');
  const hosts=options.hosts??[local,imported];
  const connect=vi.fn(async()=>({ok:true,connectionId:'conn-local'}));
  const accountId=vi.fn(async()=>options.signedIn?'google:orin':null);
  supplied.vault=options.legacy?null:{platform:{accountId,installTrustedHost:vi.fn(),trustedHostRevisions:{}},
    store:{state:'locked',probe:async()=>({kind:'gated'})},view:reactive({state:'locked',localOnly:options.localOnly??false}),requestUnlock:vi.fn(async()=>false),cancelUnlock:vi.fn(),lock:vi.fn()};
  let router:ReturnType<typeof createRouter>;
  provideApi({win:{setTitle:vi.fn(),openAccount:vi.fn(),openNewWindow:async()=>{await router.push('/add-host');}},ssh:{listConfigHosts:async()=>hosts,connect,onState:()=>()=>{},close:async()=>true},
    helper:{bootstrap:async()=>null},forwards:{isAutoEnabled:async()=>false},preview:{onStats:()=>()=>{}},
    sync:{status:async()=>({loggedIn:options.signedIn??false,email:options.signedIn?'orin@example.test':null,keychainAvailable:true}),accountHosts:async()=>options.accountHosts??null},
    hosts:{provenance:options.provenance,sourceName:'saved hosts',groupLabel:'On this device',emptyHint:'No local hosts.',emptyAction:{label:'Add a host',route:'/add-host'}}} as unknown as PocketShellApi);
  if(options.defaultHost) useSettingsStore().defaultHost=options.defaultHost;
  router=createRouter({history:createMemoryHistory(),routes:[{path:'/',name:'hosts',component:{template:'<div/>'}},{path:'/host/:name',name:'host-sessions',component:{template:'<div/>'}},{path:'/host/:name/folder/:folder',name:'folder',component:{template:'<div/>'}},{path:'/add-host',name:'add-host',component:{template:'<div/>'}}]});
  await router.push('/');
  wrapper=mount(HostPickerView,{global:{plugins:[router]}});
  await flushPromises();await flushPromises();
  return{connect,router,accountId};
}

describe('explicit local host provenance alongside trusted account servers',()=>{
  it.each([false,true])('local saved/imported direct rows navigate with signedIn=%s and a locked vault',async(signedIn)=>{
    const t=await setup({provenance:'local',signedIn,localOnly:true});
    const rows=wrapper!.findAll('.host-row');expect(rows).toHaveLength(2);
    expect(wrapper!.text()).toContain('manual-device');expect(wrapper!.text()).toContain('imported-device');
    await rows[0]!.trigger('click');await flushPromises();
    expect(t.connect).toHaveBeenCalledTimes(1);expect(t.router.currentRoute.value.name).toBe('host-sessions');
    expect(t.router.currentRoute.value.params.name).toBe('manual-device');
    expect(t.accountId).not.toHaveBeenCalled();
  });
  it.each([undefined,'account'] as const)('unknown/account source %s never becomes local through fromConfig',async(provenance)=>{
    const t=await setup({provenance,signedIn:true,hosts:[entry('cloud-config',{fromConfig:true})],accountHosts:[entry('account-row')]});
    expect(wrapper!.findAll('.host-row')).toHaveLength(0);expect(wrapper!.text()).not.toContain('cloud-config');expect(wrapper!.text()).not.toContain('account-row');expect(t.connect).not.toHaveBeenCalled();
  });
  it('cached and malformed gateway/link/managed rows stay out of the local source and cannot auto-dial',async()=>{
    const marked=[entry('cached-managed',{gateway:{serverUrl:'wss://gateway.pocketshell.io',deviceId:'cached-managed'},gatewayAuth:'managed'}),
      entry('malformed',{gateway:undefined}),entry('policy-only',{gatewayAuth:'managed'}),entry('link-only',{link:undefined})];
    const t=await setup({provenance:'local',hosts:marked,defaultHost:'cached-managed'});
    expect(wrapper!.findAll('.host-row')).toHaveLength(0);expect(t.connect).not.toHaveBeenCalled();
    // The legacy/manual action entry itself refuses cached managed metadata;
    // hiding the row is not the only protection against an alternate dial.
    await (wrapper!.vm as unknown as {onConnect(host:HostEntry):Promise<void>}).onConnect(marked[0]!);
    expect(t.connect).not.toHaveBeenCalled();
    expect(wrapper!.text()).not.toContain('Add a host');
    expect(wrapper!.text()).not.toContain('On this device');
    expect(wrapper!.text()).not.toContain('No local hosts.');
  });
  it('first run shows Google without empty local setup guidance and retains the advanced header Add route',async()=>{
    const t=await setup({provenance:'local',hosts:[]});
    expect(wrapper!.text()).toContain('Sign in with Google');
    expect(wrapper!.text()).not.toContain('On this device');
    expect(wrapper!.text()).not.toContain('No local hosts.');
    expect(wrapper!.text()).not.toContain('Add a host');
    expect(wrapper!.find('.host-list').exists()).toBe(true);
    await wrapper!.get('header button[aria-label="Open a new window"]').trigger('click');
    await flushPromises();expect(t.router.currentRoute.value.name).toBe('add-host');
  });
  it('choosing SSH without an account exposes normal local host setup without login',async()=>{
    await setup({provenance:'local',hosts:[]});
    await wrapper!.get('[data-testid="server-use-local"]').trigger('click');await flushPromises();
    expect(wrapper!.text()).toContain('SSH without an account');
    expect(wrapper!.text()).toContain('Add a host');
  });
  it('legacy desktop host listing and navigation does not require a provenance migration',async()=>{
    const t=await setup({legacy:true,hosts:[entry('desktop',{fromConfig:true})]});
    await wrapper!.get('.host-row').trigger('click');await flushPromises();expect(t.connect).toHaveBeenCalledTimes(1);expect(t.router.currentRoute.value.name).toBe('host-sessions');
  });
  it('an explicitly chosen local default still auto-connects without Google or an unlocked account vault',async()=>{
    const t=await setup({provenance:'local',defaultHost:'manual-device'});
    expect(t.connect).toHaveBeenCalledTimes(1);
    expect(t.router.currentRoute.value.name).toBe('host-sessions');
    expect(t.accountId).not.toHaveBeenCalled();
  });
});
