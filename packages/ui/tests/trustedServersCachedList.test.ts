// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { reactive } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(()=>({vault:null as any,sync:null as any,account:'google:orin'}));
vi.mock('../src/app/keyVault',()=>({useKeyVault:()=>state.vault}));
vi.mock('../src/app/stores/sync',()=>({useSyncStore:()=>state.sync}));
vi.mock('@pocketshell/core',()=>({trustedHostSlot:async()=> 'th-fixture'}));
import TrustedServersSection from '../src/app/components/TrustedServersSection.vue';
import { readCachedServers, writeCachedServers } from '../src/app/trustedServersCache';
const mk=(deviceId:string,hostAlias:string,accountId='google:orin')=>({accountId,vaultId:'fixture-vault',epoch:1,revision:1,version:1,
  serverUrl:'wss://gateway.pocketshell.io',deviceId,hostAlias,username:'orin',keyId:'k',sshHostKey:'pin',devicePublicKey:'id',
  status:'active' as const,updatedAt:'2026-11-05T00:00:00.000Z'});
const cached=mk('fixture-old','Cached box');
const fresh=mk('fixture-new','Fresh box');
const EMAIL='orin@example.test';
beforeEach(()=>{
  localStorage.clear();
  state.account='google:orin';
  state.sync=reactive({status:{loggedIn:true,email:EMAIL},busy:false,login:vi.fn(async()=>{})});
  state.vault={view:reactive({state:'locked'}),store:reactive({vaultId:'fixture-vault',epoch:1,
    listTrustedHosts:vi.fn(async()=>[fresh]),getTrustedHost:vi.fn(async()=>({kind:'ok',host:fresh}))}),
    requestUnlock:vi.fn(async()=>true),cancelUnlock:vi.fn(),lock:vi.fn(),platform:{accountId:vi.fn(async()=>state.account),
      installTrustedHost:vi.fn(async()=>{}),trustedHostRevisions:{load:vi.fn(async()=>({})),save:vi.fn(async()=>{})}}};
});
function pendingPrepare(){
  let finish!:(v:any)=>void;
  state.vault.platform.prepareAccount=vi.fn(()=>new Promise(r=>{finish=r;}));
  return (v:any)=>finish(v);
}
describe('cached trusted server list (#3137)',()=>{
  it('renders the last-known servers immediately, marked stale, while the account check is still pending',async()=>{
    writeCachedServers(EMAIL,'google:orin',[cached]);
    pendingPrepare();
    const w=mount(TrustedServersSection);await flushPromises();
    expect(w.text()).toContain('Cached box');
    expect(w.find('[data-testid="trusted-servers-stale"]').exists()).toBe(true);
    const indicator=w.get('[data-testid="servers-refreshing"]');
    expect(indicator.text()).toContain('Checking your Google account');
    expect(w.get('[data-testid="trusted-server-connect"]').attributes('disabled')).toBeUndefined();
    w.unmount();
  });
  it('replaces the cached rows with the verified list and refreshes the cache',async()=>{
    writeCachedServers(EMAIL,'google:orin',[cached]);
    const finish=pendingPrepare();
    const w=mount(TrustedServersSection);await flushPromises();
    state.vault.view.state='unlocked';
    finish({accountId:'google:orin',state:'unlocked'});await flushPromises();
    expect(w.text()).toContain('Fresh box');expect(w.text()).not.toContain('Cached box');
    expect(w.find('[data-testid="trusted-servers-stale"]').exists()).toBe(false);
    expect(readCachedServers(EMAIL)!.servers.map(s=>s.hostAlias)).toEqual(['Fresh box']);
    w.unmount();
  });
  it('an account mismatch from the refresh clears the cached list and the cache',async()=>{
    writeCachedServers(EMAIL,'google:orin',[cached]);
    const finish=pendingPrepare();
    const w=mount(TrustedServersSection);await flushPromises();
    expect(w.text()).toContain('Cached box');
    finish({accountId:'google:someone-else',state:'locked'});await flushPromises();
    expect(w.text()).not.toContain('Cached box');
    expect(w.find('[data-testid="trusted-server-connect"]').exists()).toBe(false);
    expect(readCachedServers(EMAIL)).toBeNull();
    w.unmount();
  });
  it('a refresh that finds no signed-in account drops the cached list',async()=>{
    writeCachedServers(EMAIL,'google:orin',[cached]);
    const finish=pendingPrepare();
    const w=mount(TrustedServersSection);await flushPromises();
    finish(null);await flushPromises();
    expect(w.text()).not.toContain('Cached box');expect(readCachedServers(EMAIL)).toBeNull();w.unmount();
  });
  it('never shows a cache that belongs to another remembered email',async()=>{
    writeCachedServers('other@example.test','google:other',[mk('d','Other box','google:other')]);
    pendingPrepare();
    const w=mount(TrustedServersSection);await flushPromises();
    expect(w.text()).not.toContain('Other box');w.unmount();
  });
  it('tapping a cached row waits for the refresh, then connects through the authenticated record',async()=>{
    writeCachedServers(EMAIL,'google:orin',[cached]);
    const finish=pendingPrepare();
    const w=mount(TrustedServersSection);await flushPromises();
    await w.get('[data-testid="trusted-server-connect"]').trigger('click');await flushPromises();
    expect(state.vault.platform.installTrustedHost).not.toHaveBeenCalled();
    state.vault.view.state='unlocked';
    finish({accountId:'google:orin',state:'unlocked'});await flushPromises();
    expect(state.vault.platform.installTrustedHost).toHaveBeenCalledTimes(1);
    expect(w.emitted('connect')).toHaveLength(1);w.unmount();
  });
  it('tapping a cached row is refused when the refresh ends with the vault still locked',async()=>{
    writeCachedServers(EMAIL,'google:orin',[cached]);
    state.vault.requestUnlock=vi.fn(async()=>false);
    const finish=pendingPrepare();
    const w=mount(TrustedServersSection);await flushPromises();
    await w.get('[data-testid="trusted-server-connect"]').trigger('click');
    finish({accountId:'google:orin',state:'locked'});await flushPromises();
    expect(state.vault.platform.installTrustedHost).not.toHaveBeenCalled();
    expect(w.emitted('connect')).toBeUndefined();w.unmount();
  });
});
describe('connect() identity fences (#3137)',()=>{
  beforeEach(()=>{state.vault.view.state='unlocked';});
  it('verifies the account once before and once after the operation',async()=>{
    const w=mount(TrustedServersSection);await flushPromises();
    const before=state.vault.platform.accountId.mock.calls.length;
    await w.get('[data-testid="trusted-server-connect"]').trigger('click');await flushPromises();
    expect(state.vault.platform.accountId.mock.calls.length-before).toBe(2);
    expect(w.emitted('connect')).toHaveLength(1);w.unmount();
  });
  it.each([
    ['revision floor load',(vault:any)=>{vault.platform.trustedHostRevisions.load=vi.fn(async()=>{state.account='google:other';return {};});}],
    ['vault read',(vault:any)=>{vault.store.getTrustedHost=vi.fn(async()=>{state.account='google:other';return {kind:'ok',host:fresh};});}],
  ])('account change during the %s installs nothing and saves no revision floor',async(_name,arm)=>{
    const w=mount(TrustedServersSection);await flushPromises();
    state.vault.platform.trustedHostRevisions.save.mockClear();arm(state.vault);
    await w.get('[data-testid="trusted-server-connect"]').trigger('click');await flushPromises();
    expect(state.vault.platform.installTrustedHost).not.toHaveBeenCalled();
    expect(state.vault.platform.trustedHostRevisions.save).not.toHaveBeenCalled();
    expect(w.emitted('connect')).toBeUndefined();
    expect(w.get('[role="alert"]').text()).toContain('Your account or vault changed');w.unmount();
  });
});
