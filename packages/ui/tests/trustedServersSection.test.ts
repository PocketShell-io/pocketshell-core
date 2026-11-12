// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { reactive } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(()=>({vault:null as any,sync:null as any,account:'google:orin'}));
vi.mock('../src/app/keyVault',()=>({useKeyVault:()=>state.vault}));
vi.mock('../src/app/stores/sync',()=>({useSyncStore:()=>state.sync}));
vi.mock('@pocketshell/core',()=>({trustedHostSlot:async()=> 'th-fixture'}));
import TrustedServersSection from '../src/app/components/TrustedServersSection.vue';
const host={accountId:'google:orin',vaultId:'fixture-vault',epoch:1,revision:1,version:1,
  serverUrl:'wss://gateway.pocketshell.io',deviceId:'fixture-linux',hostAlias:'Orin server',username:'orin',
  keyId:'fixture-key',sshHostKey:'fixture-pin',devicePublicKey:'fixture-identity',status:'active',updatedAt:'2026-11-05T00:00:00.000Z'};
beforeEach(()=>{
  state.account='google:orin';
  state.sync=reactive({status:{loggedIn:true,email:'orin@example.test'},busy:false,login:vi.fn(async()=>{})});
  state.vault={view:reactive({state:'unlocked'}),store:reactive({vaultId:host.vaultId,epoch:1,
    listTrustedHosts:vi.fn(async()=>[host]),getTrustedHost:vi.fn(async()=>({kind:'ok',host}))}),
    requestUnlock:vi.fn(async()=>false),cancelUnlock:vi.fn(),lock:vi.fn(),platform:{accountId:vi.fn(async()=>state.account),
      installTrustedHost:vi.fn(async()=>{}),trustedHostRevisions:{load:vi.fn(async()=>({})),save:vi.fn(async()=>{})}}};
});
describe('native account to authenticated server journey',()=>{
  it('verifies the saved account before opening a vault prompt',async()=>{
    state.vault.view.state='locked';
    let finish!:(value:string|null)=>void;
    state.vault.platform.accountId=vi.fn(()=>new Promise(r=>{finish=r;}));
    const w=mount(TrustedServersSection);await flushPromises();
    expect(state.vault.platform.accountId).toHaveBeenCalled();
    expect(state.vault.requestUnlock).not.toHaveBeenCalled();
    finish(null);await flushPromises();
    expect(state.vault.requestUnlock).not.toHaveBeenCalled();
    expect(w.find('[data-testid="server-google-login"]').exists()).toBe(true);w.unmount();
  });
  it('creates a missing vault in app instead of asking for an existing passphrase',async()=>{
    state.vault.view.state='locked';
    state.vault.platform.prepareAccount=vi.fn(async()=>({accountId:state.account,state:'absent'}));
    state.vault.platform.canCreate=true;
    state.vault.requestSetup=vi.fn(async()=>false);
    const w=mount(TrustedServersSection);await flushPromises();
    expect(state.vault.requestSetup).toHaveBeenCalledTimes(1);
    expect(state.vault.requestUnlock).not.toHaveBeenCalled();w.unmount();
  });
  it('offers local SSH without login or vault creation',async()=>{
    state.sync.status.loggedIn=false;state.vault.view.state='locked';
    const w=mount(TrustedServersSection);await flushPromises();
    await w.get('[data-testid="server-use-local"]').trigger('click');await flushPromises();
    expect(w.text()).toContain('SSH without an account');
    expect(state.sync.login).not.toHaveBeenCalled();
    expect(state.vault.requestUnlock).not.toHaveBeenCalled();
    expect(w.emitted('local')).toHaveLength(1);w.unmount();
  });
  it('keeps the local choice across picker navigation and ignores late account preparation',async()=>{
    state.vault.view.state='locked';
    let finish!:(value:any)=>void;
    state.vault.platform.prepareAccount=vi.fn(()=>new Promise(r=>{finish=r;}));
    const w=mount(TrustedServersSection);await flushPromises();
    await w.get('[data-testid="server-use-local"]').trigger('click');
    finish({accountId:state.account,state:'locked'});await flushPromises();
    expect(state.vault.requestUnlock).not.toHaveBeenCalled();w.unmount();
    const next=mount(TrustedServersSection);await flushPromises();
    expect(next.text()).toContain('SSH without an account');
    expect(state.vault.platform.prepareAccount).toHaveBeenCalledTimes(1);next.unmount();
  });
  it('a vault service failure does not open setup or unlock',async()=>{
    state.vault.view.state='locked';
    state.vault.platform.prepareAccount=vi.fn(async()=>{throw new Error('Vault service unavailable');});
    state.vault.requestSetup=vi.fn();
    const w=mount(TrustedServersSection);await flushPromises();
    expect(w.get('[role="alert"]').text()).toContain('Vault service unavailable');
    expect(state.vault.requestSetup).not.toHaveBeenCalled();
    expect(state.vault.requestUnlock).not.toHaveBeenCalled();w.unmount();
  });
  it('renders only server rows and double click installs/connects once',async()=>{
    let finish!:()=>void;
    state.vault.platform.installTrustedHost.mockImplementation(()=>new Promise<void>(r=>{finish=r;}));
    const w=mount(TrustedServersSection);await flushPromises();
    expect(w.text()).toContain('Orin server');expect(w.text()).not.toContain('Add device');
    const button=w.get('[data-testid="trusted-server-connect"]');
    await button.trigger('click');await button.trigger('click');await flushPromises();
    expect(state.vault.platform.installTrustedHost).toHaveBeenCalledTimes(1);
    finish();await flushPromises();
    expect(w.emitted('connect')).toHaveLength(1);
    expect(w.emitted('connect')![0]![0]).toMatchObject({gatewayAuth:'managed',user:'orin'});
    w.unmount();
  });
  it.each(['account','vault'])('does not dial after %s changes during native install',async(kind)=>{
    let finish!:()=>void;
    state.vault.platform.installTrustedHost.mockImplementation(()=>new Promise<void>(r=>{finish=r;}));
    const w=mount(TrustedServersSection);await flushPromises();
    await w.get('[data-testid="trusted-server-connect"]').trigger('click');await flushPromises();
    if(kind==='account') state.account='google:other';else state.vault.store.epoch=2;
    finish();await flushPromises();expect(w.emitted('connect')).toBeUndefined();w.unmount();
  });
  it('logout locking does not reopen the vault prompt',async()=>{
    const w=mount(TrustedServersSection);await flushPromises();
    state.sync.busy=true;state.vault.view.state='locked';await flushPromises();
    state.sync.status.loggedIn=false;state.sync.busy=false;await flushPromises();
    expect(state.vault.requestUnlock).not.toHaveBeenCalled();expect(w.text()).toContain('Sign in with Google');w.unmount();
  });
  it('cancelled Google login never requests a vault or shows stale servers',async()=>{
    state.sync.status.loggedIn=false;state.vault.view.state='locked';
    const w=mount(TrustedServersSection);await flushPromises();
    await w.get('[data-testid="server-google-login"]').trigger('click');await flushPromises();
    expect(state.sync.login).toHaveBeenCalledTimes(1);expect(state.vault.requestUnlock).not.toHaveBeenCalled();
    expect(w.find('[data-testid="trusted-server-connect"]').exists()).toBe(false);w.unmount();
  });
});
