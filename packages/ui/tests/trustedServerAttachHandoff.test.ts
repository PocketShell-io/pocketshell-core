// @vitest-environment jsdom
import {flushPromises,mount} from '@vue/test-utils';
import {createPinia,setActivePinia} from 'pinia';
import {createMemoryHistory,createRouter,RouterView} from 'vue-router';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {defineComponent} from 'vue';
import {provideApi} from '../src/app/ipc';
import type {PocketShellApi} from '../src/app/api';
import {useSessionsStore} from '../src/app/stores/sessions';
import {useProjectsStore} from '../src/app/stores/projects';
import {lastFolderKey,workspaceMemoryKey} from '../src/app/workspaceState';
const supplied=vi.hoisted(()=>({vault:{platform:{accountId:async()=> 'google:orin',installTrustedHost:async()=>{},trustedHostRevisions:{}},store:{state:'unlocked'}}}));
vi.mock('../src/app/keyVault',()=>({useKeyVault:()=>supplied.vault}));
vi.mock('../src/app/components/TerminalView.vue',async()=>{
  const {defineComponent}=await import('vue');
  return{default:defineComponent({props:['sessionName','workspace','aplexerId','backend'],setup:(_,{expose})=>{expose({focus:()=>undefined});return{};},
    template:'<div data-testid="selected-terminal" :data-session="sessionName" :data-workspace="workspace" :data-aplexer-id="aplexerId" :data-backend="backend" />'})};
});
import HostPickerView from '../src/app/views/HostPickerView.vue';
import FolderWorkspaceView from '../src/app/views/FolderWorkspaceView.vue';
const host={name:'server-a',hostname:'server-a',user:'orin',port:22,identityFile:null,proxyJump:null,forwardAgent:false,localForwards:[],remoteForwards:[],fromConfig:false,gatewayAuth:'managed',gateway:{serverUrl:'wss://gateway.pocketshell.io',deviceId:'server-a'}};
const serverButton=defineComponent({props:['busy'],emits:['connect'],setup:(_,c)=>({select:()=>c.emit('connect',host)}),template:'<button @click="select">Open server</button>'});
let wrapper:ReturnType<typeof mount>|undefined;
beforeEach(()=>{setActivePinia(createPinia());localStorage.clear();});
afterEach(()=>{wrapper?.unmount();wrapper=undefined;});

async function setup(home:string,lastFolder:string|null=null,existing=false,rememberSpare=false,rememberedSelection:string|null=null) {
  const canonical=home.replace(/\\/g,'/');
  const row={name:'home-orin',path:canonical,workspace:canonical,backend:'aplexer' as const,tag:'home-orin',aplexerId:'phone-created-session',created:0,activity:0,attached:false,aplexerPhase:'running',agentKind:null};
  const rows=rememberSpare?[row,{...row,name:'spare',tag:'spare',aplexerId:'remembered-session'}]:[row];
  if(rememberedSelection==='foreign') rows.push({...row,name:'foreign',tag:'foreign',aplexerId:'foreign-session',workspace:'/srv/other',path:'/srv/other'});
  const listing={sessions:existing?rows:[],errors:[]};
  const start=vi.fn(async()=>({ok:true,sessionName:row.name,folder:home,reused:false,via:'aplexer',aplexerId:row.aplexerId,error:null,code:null}));
  provideApi({win:{setTitle:vi.fn(),openAccount:vi.fn()},ssh:{listConfigHosts:async()=>[],connect:async()=>({ok:true,connectionId:'conn-1'}),onState:()=>()=>{},close:async()=>true},
    helper:{bootstrap:async()=>null,sessionsListing:async()=>listing},forwards:{isAutoEnabled:async()=>false},preview:{onStats:()=>()=>{}},
    sync:{status:async()=>({loggedIn:true,email:'orin@example.test',keychainAvailable:true}),accountHosts:async()=>null},
    sftp:{realPath:async()=>home},projects:{startSession:start,home:async()=>({ok:true,home:canonical})},
    hosts:{sourceName:'saved hosts',groupLabel:'Saved',emptyHint:'No hosts'}} as unknown as PocketShellApi);
  useProjectsStore().home=canonical;
  if(existing) useSessionsStore().sessions=rows;
  if(lastFolder) localStorage.setItem(lastFolderKey(host.name),lastFolder);
  if(rememberSpare) localStorage.setItem(workspaceMemoryKey(host.name,'~'),JSON.stringify({filesTabs:[],activeTab:'spare',mru:['spare']}));
  if(rememberedSelection) localStorage.setItem(workspaceMemoryKey(host.name,'~'),JSON.stringify({filesTabs:[],activeTab:rememberedSelection,mru:[rememberedSelection]}));
  const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',name:'hosts',component:HostPickerView},{path:'/host/:name/folder/:folder',name:'folder',component:FolderWorkspaceView},{path:'/host/:name',name:'host-sessions',component:{template:'<div/>'}}]});
  await router.push('/');
  wrapper=mount(RouterView,{global:{plugins:[router],stubs:{TrustedServersSection:serverButton,PromptComposer:true,WorkspaceTabBar:true,LaunchSessionDialog:true,FilesView:true,BarErrorStrip:true,ExtensionSlot:true}}});
  await flushPromises();
  await wrapper.findAll('button').find(b=>b.text()==='Open server')!.trigger('click');
  await flushPromises();await flushPromises();
  return{router,start,row};
}

it.each(['/home/orin','C:/Users/User','C:\\Users\\User'])('normal server tap selects the newly created authoritative session for %s',async(home)=>{
  const t=await setup(home);
  expect(t.start).toHaveBeenCalledTimes(1);
  const pane=wrapper!.get('[data-testid="selected-terminal"]');
  expect(pane.attributes('data-session')).toBe(t.row.name);
  expect(pane.attributes('data-aplexer-id')).toBe(t.row.aplexerId);
  expect(pane.attributes('data-backend')).toBe('aplexer');
  expect(t.router.currentRoute.value.params.folder).toBe('~');
  expect(wrapper!.text()).not.toContain('nothing is running in this folder');
});
it('valid last workspace retains its selected authoritative session instead of selecting the first shell',async()=>{
  const t=await setup('/home/orin','~',true,true);
  expect(t.start).not.toHaveBeenCalled();
  expect(t.router.currentRoute.value.query.tab).toBeUndefined();
  const visible=wrapper!.findAll('[data-testid="selected-terminal"]').filter(pane=>pane.isVisible());
  expect(visible).toHaveLength(1);
  expect(visible[0]!.attributes('data-aplexer-id')).toBe('remembered-session');
});
it.each(['missing','foreign'])('a %s remembered session never attaches outside the authoritative restored folder',async(selection)=>{
  const t=await setup('/home/orin','~',true,false,selection);
  expect(t.start).not.toHaveBeenCalled();
  expect(t.router.currentRoute.value.params.folder).toBe('~');
  const visible=wrapper!.findAll('[data-testid="selected-terminal"]').filter(pane=>pane.isVisible());
  expect(visible).toHaveLength(1);
  expect(visible[0]!.attributes('data-aplexer-id')).toBe(t.row.aplexerId);
});
it('a stale remembered folder falls back to the existing HOME shell without creating another',async()=>{
  const t=await setup('/home/orin','~/deleted-project',true);
  expect(t.start).not.toHaveBeenCalled();
  expect(t.router.currentRoute.value.params.folder).toBe('~');
  expect(t.router.currentRoute.value.query.tab).toBe(t.row.name);
  expect(wrapper!.get('[data-testid="selected-terminal"]').attributes('data-aplexer-id')).toBe(t.row.aplexerId);
});

it.each(['~','/home/orin'])('restores existing HOME workspace from persisted %s without creating a second shell',async(last)=>{
  const t=await setup('/home/orin',last,true);
  expect(t.start).not.toHaveBeenCalled();
  expect(t.router.currentRoute.value.params.folder).toBe('~');
  expect(wrapper!.get('[data-testid="selected-terminal"]').attributes('data-aplexer-id')).toBe(t.row.aplexerId);
});
