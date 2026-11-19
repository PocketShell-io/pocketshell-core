// @vitest-environment jsdom
// pocketshell#3189: saved servers are usable at once; the Google identity
// check and the vault refresh run behind them, fail quietly with a retry, a
// lost sign-in keeps the rows and asks to sign in again, and a background
// refresh never reorders the rows.
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick, reactive } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(()=>({vault:null as any,sync:null as any,account:'google:orin'}));
vi.mock('../src/app/keyVault',()=>({useKeyVault:()=>state.vault}));
vi.mock('../src/app/stores/sync',()=>({useSyncStore:()=>state.sync}));
vi.mock('@pocketshell/core',()=>({trustedHostSlot:async()=> 'th-fixture'}));
import TrustedServersSection from '../src/app/components/TrustedServersSection.vue';
import { accountSyncState, describeSyncProblem, namesExceptionClass, syncRetryDelay } from '../src/app/accountSyncState';
import { orderServers, readCachedServers, readCachedServersAnyAccount, writeCachedServers } from '../src/app/trustedServersCache';

const EMAIL='orin@example.test';
const mk=(deviceId:string,hostAlias:string)=>({accountId:'google:orin',vaultId:'fixture-vault',epoch:1,revision:1,version:1,
  serverUrl:'wss://gateway.pocketshell.io',deviceId,hostAlias,username:'orin',keyId:'k',sshHostKey:'pin',devicePublicKey:'id',
  status:'active' as const,updatedAt:'2026-11-05T00:00:00.000Z'});
// The maintainer's two rows, in the order the phone showed first (12:53).
const venv=mk('dev-venv','host-desktop-fp4op26-venv');
const hetzner=mk('dev-hetzner','Hetzner');
const timeout=()=>Object.assign(new Error('The sync service could not be reached (SocketTimeoutException).'),{code:'SYNC_NETWORK_FAILED'});
const revoked=()=>Object.assign(new Error('Your Google sign-in could not be renewed. Sign in again.'),{code:'NOT_SIGNED_IN'});
const rows=(w:ReturnType<typeof mount>)=>w.findAll('[data-testid="trusted-server-connect"] .server-name').map(n=>n.text());

beforeEach(()=>{
  localStorage.clear();
  state.account='google:orin';
  state.sync=reactive({status:{loggedIn:true,email:EMAIL},busy:false,login:vi.fn(async()=>{})});
  state.vault={view:reactive({state:'locked'}),store:reactive({vaultId:'fixture-vault',epoch:1,
    listTrustedHosts:vi.fn(async()=>[hetzner,venv]),getTrustedHost:vi.fn(async(_a:string,s:any)=>({kind:'ok',host:s}))}),
    requestUnlock:vi.fn(async()=>true),cancelUnlock:vi.fn(),lock:vi.fn(),platform:{accountId:vi.fn(async()=>state.account),
      installTrustedHost:vi.fn(async()=>{}),trustedHostRevisions:{load:vi.fn(async()=>({})),save:vi.fn(async()=>{})}}};
  writeCachedServers(EMAIL,'google:orin',[venv,hetzner]);
});
afterEach(()=>{vi.useRealTimers();});

describe('stalled sync: saved servers are usable at once (#3189)',()=>{
  it('renders the cached rows with no Checking text and marks a tapped row as opening in the same tick',async()=>{
    state.vault.platform.prepareAccount=vi.fn(()=>new Promise(()=>{}));
    const w=mount(TrustedServersSection);await flushPromises();
    expect(rows(w)).toEqual(['host-desktop-fp4op26-venv','Hetzner']);
    expect(w.text()).not.toMatch(/Checking|Refreshing/);
    expect(accountSyncState.phase).toBe('syncing');
    await w.findAll('[data-testid="trusted-server-connect"]')[1]!.trigger('click');await nextTick();
    const opening=w.get('[data-state="connecting"]');
    expect(opening.text()).toContain('Hetzner');
    expect(opening.attributes('aria-busy')).toBe('true');
    expect(w.text()).not.toMatch(/Checking/);
    // The other row cannot start a second open; Cancel abandons this one.
    expect(w.findAll('[data-testid="trusted-server-connect"]')[0]!.attributes('disabled')).toBeDefined();
    await w.get('[data-testid="trusted-server-cancel"]').trigger('click');
    expect(w.find('[data-state="connecting"]').exists()).toBe(false);
    w.unmount();
  });
  it('a tapped row opens through the vault record once the local account preparation and vault unlock finish',async()=>{
    let finish!:(v:any)=>void;
    state.vault.platform.prepareAccount=vi.fn(()=>new Promise(r=>{finish=r;}));
    const w=mount(TrustedServersSection);await flushPromises();
    await w.findAll('[data-testid="trusted-server-connect"]')[0]!.trigger('click');await flushPromises();
    expect(w.emitted('connect')).toBeUndefined();
    state.vault.view.state='unlocked';finish({accountId:'google:orin',state:'unlocked'});await flushPromises();
    expect(w.emitted('connect')).toHaveLength(1);
    expect(w.emitted('connect')![0]![0]).toMatchObject({name:'host-desktop-fp4op26-venv'});
    w.unmount();
  });
  it('a cancelled open never dials when the check finishes later',async()=>{
    let finish!:(v:any)=>void;
    state.vault.platform.prepareAccount=vi.fn(()=>new Promise(r=>{finish=r;}));
    const w=mount(TrustedServersSection);await flushPromises();
    await w.findAll('[data-testid="trusted-server-connect"]')[0]!.trigger('click');await nextTick();
    await w.get('[data-testid="trusted-server-cancel"]').trigger('click');
    state.vault.view.state='unlocked';finish({accountId:'google:orin',state:'unlocked'});await flushPromises();
    expect(w.emitted('connect')).toBeUndefined();expect(state.vault.platform.installTrustedHost).not.toHaveBeenCalled();
    w.unmount();
  });
  it('paints the cached rows while the sign-in status is still unknown',async()=>{
    state.sync.status=null;
    const w=mount(TrustedServersSection);await flushPromises();
    expect(rows(w)).toEqual(['host-desktop-fp4op26-venv','Hetzner']);
    expect(w.find('[data-testid="server-reauth"]').exists()).toBe(false);
    w.unmount();
  });
});

describe('failing sync: quiet, recoverable, stable (#3189)',()=>{
  it('names no exception class, keeps the rows in order, reports not synced and retries with backoff',async()=>{
    vi.useFakeTimers();
    state.vault.platform.prepareAccount=vi.fn(async()=>{throw timeout();});
    const w=mount(TrustedServersSection);await flushPromises();
    expect(w.html()).not.toMatch(/Exception/);
    expect(namesExceptionClass(w.text())).toBe(false);
    expect(w.find('[role="alert"]').exists()).toBe(false);
    expect(w.get('[data-testid="servers-sync-issue"]').text()).toContain("PocketShell sync can't be reached");
    expect(accountSyncState.phase).toBe('offline');
    expect(accountSyncState.detail).toContain('SocketTimeoutException');
    expect(rows(w)).toEqual(['host-desktop-fp4op26-venv','Hetzner']);
    expect(state.vault.platform.prepareAccount).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(syncRetryDelay(0));
    expect(state.vault.platform.prepareAccount).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(syncRetryDelay(1)-1);
    expect(state.vault.platform.prepareAccount).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.vault.platform.prepareAccount).toHaveBeenCalledTimes(3);
    w.unmount();
  });
  it('retries at once when the network comes back, and from Retry',async()=>{
    state.vault.platform.prepareAccount=vi.fn(async()=>{throw timeout();});
    const w=mount(TrustedServersSection);await flushPromises();
    window.dispatchEvent(new Event('online'));await flushPromises();
    expect(state.vault.platform.prepareAccount).toHaveBeenCalledTimes(2);
    await w.get('[data-testid="servers-sync-retry"]').trigger('click');await flushPromises();
    expect(state.vault.platform.prepareAccount).toHaveBeenCalledTimes(3);
    accountSyncState.retry!();await flushPromises();
    expect(state.vault.platform.prepareAccount).toHaveBeenCalledTimes(4);
    w.unmount();
  });
  it('Copy details carries the raw failure that the screen never shows',async()=>{
    const writeText=vi.fn(async()=>{});
    Object.defineProperty(navigator,'clipboard',{value:{writeText},configurable:true});
    state.vault.platform.prepareAccount=vi.fn(async()=>{throw timeout();});
    const w=mount(TrustedServersSection);await flushPromises();
    await w.get('[data-testid="servers-sync-copy"]').trigger('click');await flushPromises();
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('SocketTimeoutException'));
    expect(w.html()).not.toMatch(/Exception/);
    w.unmount();
  });
  it('a tap while not synced says so in plain words, with no exception class',async()=>{
    state.vault.platform.prepareAccount=vi.fn(async()=>{throw timeout();});
    const w=mount(TrustedServersSection);await flushPromises();
    await w.findAll('[data-testid="trusted-server-connect"]')[1]!.trigger('click');await flushPromises();
    expect(w.get('[role="alert"]').text()).toContain("Couldn't open Hetzner");
    expect(w.html()).not.toMatch(/Exception/);
    expect(rows(w)).toEqual(['host-desktop-fp4op26-venv','Hetzner']);
    w.unmount();
  });
  it('a vault list timeout during the refresh keeps the rows and reports not synced',async()=>{
    state.vault.view.state='unlocked';
    state.vault.platform.prepareAccount=vi.fn(async()=>({accountId:'google:orin',state:'unlocked'}));
    state.vault.store.listTrustedHosts=vi.fn(async()=>{throw new Error('Loading servers timed out.');});
    const w=mount(TrustedServersSection);await flushPromises();
    expect(rows(w)).toEqual(['host-desktop-fp4op26-venv','Hetzner']);
    expect(accountSyncState.phase).toBe('offline');
    w.unmount();
  });
});

describe('nothing opens by itself (#3189)',()=>{
  it('a background retry (timer, network back, app visible) never opens the vault sheet or sign-in; a Retry tap may',async()=>{
    vi.useFakeTimers();
    let calls=0;
    state.vault.platform.prepareAccount=vi.fn(async()=>{calls++;if(calls===1)throw timeout();return {accountId:'google:orin',state:'locked'};});
    const w=mount(TrustedServersSection);await flushPromises();
    expect(accountSyncState.phase).toBe('offline');
    await vi.advanceTimersByTimeAsync(syncRetryDelay(0));
    expect(state.vault.platform.prepareAccount).toHaveBeenCalledTimes(2);
    expect(state.vault.requestUnlock).not.toHaveBeenCalled();
    expect(state.sync.login).not.toHaveBeenCalled();
    expect(w.get('[data-testid="server-vault-unlock"]').exists()).toBe(true);
    window.dispatchEvent(new Event('online'));document.dispatchEvent(new Event('visibilitychange'));await flushPromises();
    expect(state.vault.requestUnlock).not.toHaveBeenCalled();
    await w.get('[data-testid="server-vault-unlock"]').trigger('click');await flushPromises();
    expect(state.vault.requestUnlock).toHaveBeenCalledTimes(1);
    w.unmount();
  });
  it('a lost sign-in shows Signed out and never signs in until the banner is tapped, then exactly once',async()=>{
    vi.useFakeTimers();
    state.vault.platform.prepareAccount=vi.fn(async()=>{throw revoked();});
    const w=mount(TrustedServersSection);await flushPromises();
    state.sync.status={loggedIn:false,email:null};await flushPromises();
    await vi.advanceTimersByTimeAsync(20*60_000);
    window.dispatchEvent(new Event('online'));document.dispatchEvent(new Event('visibilitychange'));await flushPromises();
    expect(state.sync.login).not.toHaveBeenCalled();
    expect(accountSyncState.phase).toBe('reauth');
    await w.get('[data-testid="server-reauth-sign-in"]').trigger('click');await flushPromises();
    expect(state.sync.login).toHaveBeenCalledTimes(1);
    w.unmount();
  });
  it('opens the Google chooser when the user returns from local-only SSH (#3194)', async () => {
    const prepareAccount = vi.fn(async () => ({ accountId: state.account, state: 'locked' }));
    state.vault.platform.prepareAccount = prepareAccount;
    let finishSignIn!: () => void;
    state.sync.login.mockImplementation(() => new Promise<void>(resolve => { finishSignIn = resolve; }));

    const w = mount(TrustedServersSection);
    await flushPromises();
    expect(prepareAccount).toHaveBeenCalledTimes(1);
    await w.get('[data-testid="server-use-local"]').trigger('click');
    expect(state.sync.status.loggedIn).toBe(true);
    expect(state.sync.login).not.toHaveBeenCalled();

    await w.get('[data-testid="server-google-login"]').trigger('click');
    expect(state.sync.login).toHaveBeenCalledTimes(1);
    expect(prepareAccount).toHaveBeenCalledTimes(1);

    finishSignIn();
    await flushPromises();
    expect(prepareAccount).toHaveBeenCalledTimes(2);
    w.unmount();
  });

  it('backs off 30 s, 1 min, 5 min, then 15 min',()=>{
    expect([0,1,2,3,4,9].map(syncRetryDelay)).toEqual([30_000,60_000,300_000,900_000,900_000,900_000]);
  });
});

describe('a saved server whose SSH keys are locked (#3194)', () => {
  it('keeps the first host tap while the account and vault are being checked', async () => {
    let finishPreparation!: (prepared: { accountId: string; state: 'locked' }) => void;
    state.vault.platform.prepareAccount = vi.fn(() => new Promise(resolve => { finishPreparation = resolve; }));
    let finishUnlock!: (unlocked: boolean) => void;
    state.vault.requestUnlock.mockImplementation(() => new Promise(resolve => { finishUnlock = resolve; }));
    const w = mount(TrustedServersSection);
    await flushPromises();
    await w.findAll('[data-testid=trusted-server-connect]')[1]!.trigger('click');
    await flushPromises();
    expect(w.get('[aria-busy=true]').text()).toContain('Hetzner');
    expect(state.vault.requestUnlock).not.toHaveBeenCalled();
    expect(state.vault.platform.installTrustedHost).not.toHaveBeenCalled();

    finishPreparation({ accountId: state.account, state: 'locked' });
    await flushPromises();
    expect(state.vault.requestUnlock).toHaveBeenCalledTimes(1);
    expect(state.vault.requestUnlock).toHaveBeenCalledWith('connect', 'Hetzner');
    expect(w.emitted('connect')).toBeUndefined();

    state.vault.view.state = 'unlocked';
    finishUnlock(true);
    await flushPromises();
    expect(w.emitted('connect')).toHaveLength(1);
    expect(w.emitted('connect')![0]![0]).toMatchObject({ name: 'Hetzner' });
    w.unmount();
  });

  it('holds the selected row while unlocking, then opens that server without another tap', async () => {
    state.vault.platform.prepareAccount = vi.fn(async () => ({ accountId: state.account, state: 'locked' }));
    let finishUnlock!: (unlocked: boolean) => void;
    state.vault.requestUnlock
      .mockResolvedValueOnce(false) // The launch prompt was dismissed.
      .mockImplementationOnce(() => new Promise<boolean>(resolve => { finishUnlock = resolve; }));
    const w = mount(TrustedServersSection);
    await flushPromises();
    await w.findAll('[data-testid=trusted-server-connect]')[1]!.trigger('click');
    await flushPromises();

    expect(state.vault.requestUnlock).toHaveBeenLastCalledWith('connect', 'Hetzner');
    expect(state.vault.platform.prepareAccount).toHaveBeenCalledTimes(1);
    expect(state.sync.login).not.toHaveBeenCalled();
    expect(w.get('[aria-busy=true]').text()).toContain('Hetzner');
    expect(w.emitted('connect')).toBeUndefined();

    state.vault.view.state = 'unlocked';
    finishUnlock(true);
    await flushPromises();
    expect(w.emitted('connect')).toHaveLength(1);
    expect(w.emitted('connect')![0]![0]).toMatchObject({ name: 'Hetzner' });
    w.unmount();
  });

  it('shows Keys locked beside the selected server if unlock is dismissed', async () => {
    state.vault.platform.prepareAccount = vi.fn(async () => ({ accountId: state.account, state: 'locked' }));
    state.vault.requestUnlock.mockResolvedValue(false);
    const w = mount(TrustedServersSection);
    await flushPromises();
    const row = w.findAll('li')[1]!;
    await row.get('[data-testid=trusted-server-connect]').trigger('click');
    await flushPromises();

    expect(row.get('[role=alert]').text()).toContain('Keys locked');
    expect(row.get('[data-testid=trusted-server-action]').text()).toBe('Unlock');
    expect(w.text()).not.toContain("You're signed out");
    expect(state.sync.login).not.toHaveBeenCalled();
    expect(w.emitted('connect')).toBeUndefined();
    w.unmount();
  });

  it('says Signed out and offers Sign in after a revoked credential', async () => {
    state.sync.status = { loggedIn: false, email: null };
    const w = mount(TrustedServersSection);
    await flushPromises();
    const row = w.findAll('li')[1]!;
    await row.get('[data-testid=trusted-server-connect]').trigger('click');
    await flushPromises();

    expect(row.get('[role=alert]').text()).toContain("You're signed out");
    expect(row.get('[data-testid=trusted-server-action]').text()).toBe('Sign in');
    expect(w.text()).not.toContain('Keys locked');
    expect(state.vault.requestUnlock).not.toHaveBeenCalled();
    w.unmount();
  });
});

describe('stable order (#3189)',()=>{
  it('a refresh that returns the rows in another order does not move them; new rows join the end',async()=>{
    state.vault.view.state='unlocked';
    state.vault.platform.prepareAccount=vi.fn(async()=>({accountId:'google:orin',state:'unlocked'}));
    const added=mk('dev-added','Added box');
    state.vault.store.listTrustedHosts=vi.fn(async()=>[added,hetzner,venv]);
    const w=mount(TrustedServersSection);await flushPromises();
    expect(w.find('[data-testid="trusted-servers-stale"]').exists()).toBe(false);
    expect(rows(w)).toEqual(['host-desktop-fp4op26-venv','Hetzner','Added box']);
    expect(readCachedServers(EMAIL)!.servers.map(s=>s.hostAlias)).toEqual(['host-desktop-fp4op26-venv','Hetzner','Added box']);
    expect(accountSyncState.phase).toBe('synced');
    w.unmount();
  });
  it('orders a first list by name and keeps a known order otherwise',()=>{
    expect(orderServers([], [venv,hetzner]).map(s=>s.hostAlias)).toEqual(['Hetzner','host-desktop-fp4op26-venv']);
    expect(orderServers(['dev-venv','dev-hetzner'], [hetzner,venv]).map(s=>s.hostAlias)).toEqual(['host-desktop-fp4op26-venv','Hetzner']);
  });
});

describe('revoked account: re-sign-in, nothing deleted (#3189)',()=>{
  it('a NOT_SIGNED_IN refresh keeps the rows and the cache and shows the signed-out banner',async()=>{
    state.vault.platform.prepareAccount=vi.fn(async()=>{throw revoked();});
    const w=mount(TrustedServersSection);await flushPromises();
    expect(rows(w)).toEqual(['host-desktop-fp4op26-venv','Hetzner']);
    expect(w.get('[data-testid="server-reauth"] span').text()).toBe("You're signed out —");
    expect(w.get('[data-testid="server-reauth-sign-in"]').text()).toBe('Sign in');
    expect(readCachedServersAnyAccount()!.servers).toHaveLength(2);
    expect(accountSyncState.phase).toBe('reauth');
    w.unmount();
  });
  it('the platform dropping the sign-in (status signed out) keeps the rows; tapping one signs in again',async()=>{
    state.vault.platform.prepareAccount=vi.fn(()=>new Promise(()=>{}));
    const w=mount(TrustedServersSection);await flushPromises();
    state.sync.status={loggedIn:false,email:null};await flushPromises();
    expect(rows(w)).toEqual(['host-desktop-fp4op26-venv','Hetzner']);
    expect(w.find('[data-testid="server-reauth"]').exists()).toBe(true);
    expect(w.find('[data-testid="trusted-server-connect"]').attributes('disabled')).toBeUndefined();
    await w.findAll('[data-testid="trusted-server-connect"]')[1]!.trigger('click');await flushPromises();
    expect(state.sync.login).toHaveBeenCalledTimes(1);
    expect(readCachedServersAnyAccount()).not.toBeNull();
    w.unmount();
  });
  it('a relaunch after the sign-in was lost still lists the saved rows with the prompt',async()=>{
    state.sync.status={loggedIn:false,email:null};
    const w=mount(TrustedServersSection);await flushPromises();
    expect(rows(w)).toEqual(['host-desktop-fp4op26-venv','Hetzner']);
    expect(w.find('[data-testid="server-reauth"]').exists()).toBe(true);
    w.unmount();
  });
  it('an explicit sign-out (cache cleared first) does not keep the rows',async()=>{
    state.sync.status={loggedIn:false,email:null};localStorage.clear();
    const w=mount(TrustedServersSection);await flushPromises();
    expect(rows(w)).toEqual([]);
    expect(w.find('[data-testid="server-google-login"]').exists()).toBe(true);
    w.unmount();
  });
});

describe('GET /me is never on the open path (#3189)',()=>{
  beforeEach(()=>{
    state.vault.view.state='unlocked';
    state.vault.platform.prepareAccount=vi.fn(async()=>({accountId:'google:orin',state:'unlocked'}));
  });
  it('a row opens and connects while the backend identity check is still stalled',async()=>{
    state.vault.platform.verifyAccount=vi.fn(()=>new Promise(()=>{}));
    const w=mount(TrustedServersSection);await flushPromises();
    expect(state.vault.platform.verifyAccount).toHaveBeenCalledTimes(1);
    await w.findAll('[data-testid="trusted-server-connect"]')[1]!.trigger('click');await flushPromises();
    expect(w.emitted('connect')).toHaveLength(1);
    expect(w.emitted('connect')![0]![0]).toMatchObject({name:'Hetzner'});
    w.unmount();
  });
  it('a refused credential found by the background check ends in the signed-out state, rows kept',async()=>{
    state.vault.platform.verifyAccount=vi.fn(async()=>{throw revoked();});
    const w=mount(TrustedServersSection);await flushPromises();
    expect(w.find('[data-testid="server-reauth"]').exists()).toBe(true);
    expect(rows(w)).toEqual(['host-desktop-fp4op26-venv','Hetzner']);
    expect(readCachedServersAnyAccount()).not.toBeNull();
    w.unmount();
  });
  it('a different verified subject drops the rows and never opens as it',async()=>{
    state.vault.platform.verifyAccount=vi.fn(async()=>'google:someone-else');
    const w=mount(TrustedServersSection);await flushPromises();
    expect(rows(w)).toEqual([]);
    expect(readCachedServersAnyAccount()).toBeNull();
    w.unmount();
  });
  it('Refresh servers re-checks the identity behind the list, and a refused credential then signs out',async()=>{
    let calls=0;
    state.vault.platform.verifyAccount=vi.fn(async()=>{calls++;if(calls>1)throw revoked();return 'google:orin';});
    const w=mount(TrustedServersSection);await flushPromises();
    expect(w.find('[data-testid="server-reauth"]').exists()).toBe(false);
    const refresh=w.findAll('button').find(b=>b.text()==='Refresh servers')!;
    await refresh.trigger('click');await flushPromises();
    expect(state.vault.platform.verifyAccount).toHaveBeenCalledTimes(2);
    expect(w.find('[data-testid="server-reauth"]').exists()).toBe(true);
    w.unmount();
  });
  it('an offline identity check is the quiet retrying note, and the rows still open',async()=>{
    state.vault.platform.verifyAccount=vi.fn(async()=>{throw timeout();});
    const w=mount(TrustedServersSection);await flushPromises();
    expect(accountSyncState.phase).toBe('offline');
    await w.findAll('[data-testid="trusted-server-connect"]')[0]!.trigger('click');await flushPromises();
    expect(w.emitted('connect')).toHaveLength(1);
    w.unmount();
  });
});

describe('verification failures stay loud (#3189)',()=>{
  it('a server that fails trust verification is an alert, its unverified rows go, and nothing retries quietly',async()=>{
    state.vault.view.state='unlocked';
    state.vault.platform.prepareAccount=vi.fn(async()=>({accountId:'google:orin',state:'unlocked'}));
    state.vault.store.listTrustedHosts=vi.fn(async()=>{throw new Error('Server trust could not be verified (invalid).');});
    const w=mount(TrustedServersSection);await flushPromises();
    expect(w.get('[role="alert"]').text()).toBe('Server trust could not be verified (invalid).');
    expect(w.find('[data-testid="trusted-server-connect"]').exists()).toBe(false);
    expect(w.find('[data-testid="servers-sync-issue"]').exists()).toBe(false);
    expect(accountSyncState.phase).not.toBe('offline');
    w.unmount();
  });
});

describe('describeSyncProblem (#3189)',()=>{
  it.each([
    [timeout(),'offline'],
    [revoked(),'signedOut'],
    [new Error('Loading servers timed out.'),'offline'],
    [new TypeError('Failed to fetch'),'offline'],
    [new Error('Server trust could not be verified (stale).'),'failed'],
  ])('%s is %s',(error,kind)=>{
    const problem=describeSyncProblem(error);
    expect(problem.kind).toBe(kind);
    expect(namesExceptionClass(problem.message)).toBe(false);
  });
  it('strips an exception class from an otherwise plain message and keeps it in the details',()=>{
    const problem=describeSyncProblem(new Error('Something odd happened (java.lang.IllegalStateException).'));
    expect(problem.message).toBe('Something odd happened.');
    expect(problem.detail).toContain('IllegalStateException');
  });
});
