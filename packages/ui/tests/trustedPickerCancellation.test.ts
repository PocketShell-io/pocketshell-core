// @vitest-environment jsdom
import {flushPromises,mount} from '@vue/test-utils';
import {createPinia,setActivePinia} from 'pinia';
import {createMemoryHistory,createRouter} from 'vue-router';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {defineComponent} from 'vue';
import {provideApi} from '../src/app/ipc';
import type {PocketShellApi} from '../src/app/api';
const supplied=vi.hoisted(()=>({vault:{platform:{accountId:async()=> 'google:orin',installTrustedHost:async()=>{},trustedHostRevisions:{}},store:{state:'unlocked'}}}));
vi.mock('../src/app/keyVault',()=>({useKeyVault:()=>supplied.vault}));
import HostPickerView from '../src/app/views/HostPickerView.vue';
const host=(name:string)=>({name,hostname:name,user:'orin',port:22,identityFile:null,proxyJump:null,forwardAgent:false,localForwards:[],remoteForwards:[],fromConfig:false,gatewayAuth:'managed',gateway:{serverUrl:'wss://gateway.pocketshell.io',deviceId:name}});
const children=defineComponent({props:['busy'],emits:['connect'],setup:(_,c)=>({select:(name:string)=>c.emit('connect',host(name))}),template:'<button @click="select(\'server-a\')">Open A</button><button @click="select(\'server-b\')">Open B</button>'});
let wrapper:ReturnType<typeof mount>|undefined;
beforeEach(()=>{setActivePinia(createPinia());localStorage.clear();});
afterEach(()=>{wrapper?.unmount();wrapper=undefined;});
async function setup() {
  const homes:Array<(path:string)=>void>=[];
  const starts=vi.fn(async()=>({ok:true,sessionName:'home',folder:'/home/orin',reused:false,via:'aplexer',aplexerId:'fixture',error:null,code:null}));
  let count=0;
  const close=vi.fn(async()=>true);
  provideApi({win:{setTitle:vi.fn(),openAccount:vi.fn()},ssh:{listConfigHosts:async()=>[],connect:async()=>({ok:true,connectionId:`conn-${++count}`}),onState:()=>()=>{},close},
    helper:{bootstrap:async()=>null,sessionsListing:async()=>({sessions:[],errors:[]})},forwards:{isAutoEnabled:async()=>false},preview:{onStats:()=>()=>{}},
    sync:{status:async()=>({loggedIn:true,email:'orin@example.test',keychainAvailable:true}),accountHosts:async()=>null},
    sftp:{realPath:()=>new Promise<string>(resolve=>homes.push(resolve))},projects:{startSession:starts},
    hosts:{sourceName:'saved hosts',groupLabel:'Saved',emptyHint:'No hosts'}} as unknown as PocketShellApi);
  const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',name:'hosts',component:{template:'<div/>'}},{path:'/host/:name/folder/:folder',name:'folder',component:{template:'<div/>'}},{path:'/host/:name',name:'host-sessions',component:{template:'<div/>'}}]});
  await router.push('/');
  wrapper=mount(HostPickerView,{global:{plugins:[router],stubs:{TrustedServersSection:children}}});
  await flushPromises();
  const click=async(text:string)=>{await wrapper!.findAll('button').find(b=>b.text()===text)!.trigger('click');await flushPromises();};
  const navigate=vi.spyOn(router,'push');
  return{homes,starts,close,router,click,navigate};
}
it('mounted Cancel during pending home lookup prevents shell creation and navigation',async()=>{
  const t=await setup();await t.click('Open A');expect(t.homes).toHaveLength(1);
  await t.click('Cancel');t.homes[0]!('/home/orin');await flushPromises();
  expect(t.starts).not.toHaveBeenCalled();expect(t.router.currentRoute.value.name).toBe('hosts');
});
it('cancelled bootstrap cannot clear or navigate over a later server bootstrap',async()=>{
  const t=await setup();await t.click('Open A');await t.click('Cancel');await t.click('Open B');
  expect(t.homes).toHaveLength(2);t.homes[0]!('/home/orin');await flushPromises();
  expect(t.starts).not.toHaveBeenCalled();expect(wrapper!.text()).toContain('server-b');expect(wrapper!.findAll('button').some(b=>b.text()==='Cancel')).toBe(true);
  t.homes[1]!('/home/orin');await flushPromises();expect(t.starts).toHaveBeenCalledTimes(1);
  expect(t.router.currentRoute.value.params.name).toBe('server-b');
});
it('unmount during pending home lookup never creates a shell or navigates',async()=>{
  const t=await setup();await t.click('Open A');wrapper!.unmount();wrapper=undefined;
  t.homes[0]!('/home/orin');await flushPromises();expect(t.starts).not.toHaveBeenCalled();expect(t.navigate).not.toHaveBeenCalled();
});
it('a cancelled owned close finishes before a new server dial can claim connection state',async()=>{
  const t=await setup();await t.click('Open A');
  let finishClose!:(closed:boolean)=>void;
  t.close.mockImplementation(()=>new Promise<boolean>(resolve=>{finishClose=resolve;}));
  await t.click('Cancel');await t.click('Open B');expect(t.homes).toHaveLength(1);
  t.homes[0]!('/home/orin');await flushPromises();expect(t.starts).not.toHaveBeenCalled();
  finishClose(true);await flushPromises();expect(t.homes).toHaveLength(2);
  t.homes[1]!('/home/orin');await flushPromises();expect(t.starts).toHaveBeenCalledTimes(1);
  expect(t.router.currentRoute.value.params.name).toBe('server-b');
});
