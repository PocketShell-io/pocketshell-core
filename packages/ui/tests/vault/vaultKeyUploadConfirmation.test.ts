// @vitest-environment jsdom
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { KeyVaultStore } from '@pocketshell/core';
import { MemoryTransport } from '../../../../tests/keyVault/memoryTransport';
import { provideKeyVault } from '../../src/app/keyVault';
import VaultKeyUpload from '../../src/app/components/vault/VaultKeyUpload.vue';
import VaultKeyList from '../../src/app/components/vault/VaultKeyList.vue';

const PASS = 'correct horse battery staple';
const KDF = { m: 32768, t: 3, p: 1 };
const pem = () => String(generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
async function fixture(onLock?: () => Promise<void>) {
  const transport = new MemoryTransport();
  Object.assign(transport,{scoped:()=>transport});
  const store = new KeyVaultStore({ transport, kdf: KDF });
  await store.createVault(PASS);
  const controller = provideKeyVault({ store, canUpload: true, accountId:async()=> 'google:synthetic-review', onLock })!;
  transport.writes.length = 0;
  return { transport, store, controller };
}
vi.setConfig({ testTimeout: 30_000 });
afterEach(() => provideKeyVault(null));

describe('Fresh vault passphrase for uploads', () => {
  it('an already unlocked vault cannot add a key without entering its passphrase again', async () => {
    const { controller, transport, store } = await fixture();
    expect((await controller.addKey(pem(), 'new key')).kind).not.toBe('ok');
    expect(transport.writes).toEqual([]);
    expect(store.listKeys()).toEqual([]);
  });
  it('a wrong vault passphrase cannot add a key to an already unlocked vault', async () => {
    const { controller, transport, store } = await fixture();
    expect((await controller.addKey(pem(), 'new key', undefined, 'wrong vault passphrase')).kind).not.toBe('ok');
    expect(transport.writes).toEqual([]);
    expect(store.listKeys()).toEqual([]);
  });
  it('the upload form always asks for a masked vault passphrase, separately from the SSH key passphrase', async () => {
    await fixture();
    const wrapper = mount(VaultKeyUpload, { props: { idPrefix: 'upload' } });
    await flushPromises();
    expect(wrapper.get('[data-testid="vault-key-vault-passphrase"]').attributes('type')).toBe('password');
    expect(wrapper.find('[data-testid="vault-key-passphrase"]').exists()).toBe(false);
    wrapper.unmount();
  });
  it('a correct fresh passphrase adds one key, and the next addition needs another explicit entry', async () => {
    const {controller,transport,store}=await fixture();
    expect((await controller.addKey(pem(),'first',undefined,PASS)).kind).toBe('ok');
    expect(store.listKeys()).toHaveLength(1);
    const writes=transport.writes.length;
    expect((await controller.addKey(pem(),'second')).kind).not.toBe('ok');
    expect(transport.writes).toHaveLength(writes);
    expect(store.listKeys()).toHaveLength(1);
    expect(JSON.stringify([...transport.slots.values()])).not.toContain(PASS);
  });
  it('a vault opened by a remembered DEK still requires its passphrase for additions',async()=>{
    const {controller,store,transport}=await fixture();
    const remembered=store.exportRememberRecord()!;
    controller.lock();
    expect((await store.unlockWithRememberedDek(remembered)).kind).toBe('ok');
    expect((await controller.addKey(pem(),'remembered')).kind).not.toBe('ok');
    expect(transport.writes).toEqual([]);
    expect((await controller.addKey(pem(),'remembered',undefined,PASS)).kind).toBe('ok');
    remembered.dek.fill(0); remembered.auth?.fill(0);
  });
  it('the actual upload form validates wrong then correct vault passphrase and clears the field each time',async()=>{
    const {store,transport}=await fixture();
    const wrapper=mount(VaultKeyUpload,{props:{idPrefix:'upload'}});
    await wrapper.get('[data-testid=vault-key-pem]').setValue(pem());
    await wrapper.get('[data-testid=vault-key-vault-passphrase]').setValue('wrong');
    await wrapper.get('form').trigger('submit');
    await vi.waitFor(()=>expect(wrapper.text()).toContain("That passphrase didn't unlock your vault."),{timeout:10000});
    expect(transport.writes).toEqual([]);
    expect((wrapper.get('[data-testid=vault-key-vault-passphrase]').element as HTMLInputElement).value).toBe('');
    await wrapper.get('[data-testid=vault-key-vault-passphrase]').setValue(PASS);
    await wrapper.get('form').trigger('submit');
    await vi.waitFor(()=>expect(wrapper.emitted('added')).toHaveLength(1),{timeout:10000});
    expect(store.listKeys()).toHaveLength(1);
    expect((wrapper.get('[data-testid=vault-key-vault-passphrase]').element as HTMLInputElement).value).toBe('');
    wrapper.unmount();
  });
  it('cancel during verification cannot add a key or emit success',async()=>{
    const {controller,transport}=await fixture();
    const original=transport.pull.bind(transport);
    let release! :()=>void;
    let entered! :()=>void;
    const reading=new Promise<void>(resolve=>{entered=resolve;});
    transport.pull=async slot=>{entered();await new Promise<void>(resolve=>{release=resolve;});return original(slot);};
    const wrapper=mount(VaultKeyUpload,{props:{idPrefix:'upload'}});
    await wrapper.get('[data-testid=vault-key-pem]').setValue(pem());
    await wrapper.get('[data-testid=vault-key-vault-passphrase]').setValue(PASS);
    await wrapper.get('form').trigger('submit'); await reading;
    await wrapper.get('button[type=button]').trigger('click'); release();
    await vi.waitFor(()=>expect(wrapper.get('[data-testid=vault-key-add]').text()).toBe('Add to vault'),{timeout:10000});
    expect(wrapper.emitted('cancel')).toHaveLength(1);
    expect(wrapper.emitted('added')).toBeUndefined();
    expect(transport.writes).toEqual([]);
    expect(controller.store.listKeys()).toEqual([]);wrapper.unmount();
  });
  it('lock while verification is queued wins and prevents all writes',async()=>{
    const {controller,store,transport}=await fixture();
    const pending=controller.addKey(pem(),'cancelled',undefined,PASS);
    controller.lock();
    expect((await pending).kind).not.toBe('ok');
    expect(store.state).toBe('locked');expect(transport.writes).toEqual([]);
  });
  it('awaited device cleanup cancels an in-flight fresh addition and deduplicates native cleanup',async()=>{
    let finishCleanup!:()=>void;
    const onLock=vi.fn(()=>new Promise<void>(resolve=>{finishCleanup=resolve;}));
    const {controller,store,transport}=await fixture(onLock);
    const pull=transport.pull.bind(transport);let release!:()=>void;let entered!:()=>void;
    const reading=new Promise<void>(resolve=>{entered=resolve;});
    transport.pull=async slot=>{entered();await new Promise<void>(resolve=>{release=resolve;});return pull(slot);};
    const addition=controller.addPassword('synthetic secret','pending',PASS);await reading;
    const locked=controller.lockOnDevice();expect(controller.lockOnDevice()).toBe(locked);
    await flushPromises();expect(store.state).toBe('locked');expect(onLock).toHaveBeenCalledTimes(1);
    release();expect((await addition).kind).not.toBe('ok');expect(transport.writes).toEqual([]);
    finishCleanup();await locked;expect(store.state).toBe('locked');expect(transport.writes).toEqual([]);
  });
  it('the accepted revision floor survives awaited device cleanup and refuses a replay on the next unlock',async()=>{
    const onLock=vi.fn(async()=>{});const {controller,store,transport}=await fixture(onLock);
    const old={...transport.slots.get('vault')!};
    expect((await store.addPassword('accepted secret','accepted entry')).kind).toBe('ok');
    const accepted={...transport.slots.get('vault')!};
    await controller.lockOnDevice();expect(onLock).toHaveBeenCalledTimes(1);
    transport.slots.set('vault',old);transport.writes.length=0;
    expect((await controller.unlock(PASS,false)).kind).not.toBe('ok');
    expect((await controller.addPassword('new secret','must refuse',PASS)).kind).not.toBe('ok');
    expect(transport.writes).toEqual([]);expect(store.state).toBe('locked');
    transport.slots.set('vault',accepted);expect((await controller.unlock(PASS,false)).kind).toBe('ok');
    expect(store.listKeys().map(entry=>entry.name)).toEqual(['accepted entry']);
  });
  it('concurrent additions cannot share one confirmation',async()=>{
    const {controller,store}=await fixture();
    const first=controller.addKey(pem(),'one',undefined,PASS);
    const second=controller.addKey(pem(),'two',undefined,PASS);
    expect((await second).kind).not.toBe('ok');
    expect((await first).kind).toBe('ok');expect(store.listKeys()).toHaveLength(1);
  });
  it('switching accounts after verification starts refuses the upload without writes',async()=>{
    const {store,transport}=await fixture();
    let account='account:a';
    const controller=provideKeyVault({store,canUpload:true,accountId:async()=>account})!;
    const original=transport.pull.bind(transport);
    let release! :()=>void;let entered! :()=>void;
    const reading=new Promise<void>(resolve=>{entered=resolve;});
    transport.pull=async slot=>{entered();await new Promise<void>(resolve=>{release=resolve;});return original(slot);};
    const pending=controller.addKey(pem(),'foreign',undefined,PASS);
    await reading;account='account:b';release();
    expect((await pending).kind).not.toBe('ok');expect(transport.writes).toEqual([]);expect(store.listKeys()).toEqual([]);
  });
  it('password additions also require the correct fresh phrase and use a masked field',async()=>{
    const {controller,store,transport}=await fixture();
    expect((await controller.addPassword('server-secret','password')).kind).not.toBe('ok');
    expect((await controller.addPassword('server-secret','password','wrong')).kind).not.toBe('ok');
    expect(transport.writes).toEqual([]);
    const wrapper=mount(VaultKeyList);
    await wrapper.get('[data-testid=vault-add-password]').trigger('click');
    expect(wrapper.get('[data-testid=vault-password-vault-passphrase]').attributes('type')).toBe('password');
    await wrapper.get('[data-testid=vault-password-value]').setValue('server-secret');
    await wrapper.get('[data-testid=vault-password-name]').setValue('password');
    await wrapper.get('[data-testid=vault-password-vault-passphrase]').setValue(PASS);
    await wrapper.get('form').trigger('submit');
    await vi.waitFor(()=>expect(store.listKeys()).toHaveLength(1),{timeout:10000});
    expect(JSON.stringify([...transport.slots.values()])).not.toContain('server-secret');wrapper.unmount();
  });
  it('replacing a key requires a new confirmation and preserves the old key on a wrong phrase',async()=>{
    const {controller,store,transport}=await fixture();
    const original=await store.addKey(pem(),'original');
    if(original.kind!=='ok')throw new Error('fixture key');
    const replacement=pem(); transport.writes.length=0;
    expect((await controller.rotateKey(original.entry.keyId,replacement,'next',undefined,'wrong')).kind).not.toBe('ok');
    expect(transport.writes).toEqual([]);expect(store.listKeys().map(k=>k.keyId)).toEqual([original.entry.keyId]);
    expect((await controller.rotateKey(original.entry.keyId,replacement,'next',undefined,PASS)).kind).toBe('ok');
    expect(store.listKeys()).toHaveLength(1);expect(store.listKeys()[0].keyId).not.toBe(original.entry.keyId);
  });
  it('read-only phone clients cannot call the controller upload methods directly',async()=>{
    const {store,transport}=await fixture();
    const controller=provideKeyVault({store,canUpload:false})!;
    expect((await controller.addKey(pem(),'not allowed',undefined,PASS)).kind).not.toBe('ok');
    expect((await controller.addPassword('secret','not allowed',PASS)).kind).not.toBe('ok');
    expect(transport.writes).toEqual([]);
    const wrapper=mount(VaultKeyUpload,{props:{idPrefix:'phone'}});
    expect(wrapper.find('form').exists()).toBe(false);wrapper.unmount();
  });
  it('upload capability alone never permits writes without a verified identity and account-bound IO',async()=>{
    const{store,transport}=await fixture();
    const noIdentity=provideKeyVault({store,canUpload:true})!;
    expect(noIdentity.canUpload).toBe(false);
    expect((await noIdentity.addKey(pem(),'not allowed',undefined,PASS)).kind).not.toBe('ok');
    const unscoped=new MemoryTransport();const other=new KeyVaultStore({transport:unscoped,kdf:KDF});await other.createVault(PASS);unscoped.writes.length=0;
    const noScope=provideKeyVault({store:other,canUpload:true,accountId:async()=> 'google:synthetic-review'})!;
    expect(noScope.canUpload).toBe(false);
    expect((await noScope.addPassword('secret','not allowed',PASS)).kind).not.toBe('ok');
    expect(transport.writes).toEqual([]);expect(unscoped.writes).toEqual([]);
  });
  it('a new host credential and its binding commit in one index write after one confirmation',async()=>{
    const{controller,store,transport}=await fixture();const confirm=vi.spyOn(store,'confirmPassphrase');
    const result=await controller.addKey(pem(),'host key',undefined,PASS,{hostAlias:'new-host',gatewayAuth:'managed'});
    expect(result.kind).toBe('ok');if(result.kind!=='ok')throw new Error('add');
    expect(confirm).toHaveBeenCalledTimes(1);expect(transport.writes.filter(slot=>slot==='vault')).toHaveLength(1);
    expect(store.getHostBinding('new-host')).toEqual({keyId:result.entry.keyId,gatewayAuth:'managed'});
  });
  it('granting an existing credential to a host needs a new phrase, while revocation does not',async()=>{
    const{controller,store,transport}=await fixture();const key=await store.addKey(pem(),'existing');if(key.kind!=='ok')throw new Error('fixture');
    transport.writes.length=0;const binding={keyId:key.entry.keyId,gatewayAuth:'managed' as const};
    expect((await controller.bindHost('new-host',binding)).kind).not.toBe('ok');
    expect((await controller.bindHost('new-host',binding,'wrong')).kind).not.toBe('ok');expect(transport.writes).toEqual([]);
    expect((await controller.bindHost('new-host',binding,PASS)).kind).toBe('ok');
    expect(store.getHostBinding('new-host')).toEqual(binding);
    expect((await controller.bindHost('new-host',null)).kind).toBe('ok');expect(store.getHostBinding('new-host')).toBeNull();
  });
  it('detects a file key passphrase before the single vault confirmation',async()=>{
    const{store}=await fixture();const confirm=vi.spyOn(store,'confirmPassphrase');
    const encrypted=String(generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem',cipher:'aes-256-cbc',passphrase:'synthetic key passphrase'}));
    const wrapper=mount(VaultKeyUpload,{props:{idPrefix:'upload'}});
    const file=wrapper.get('[data-testid=vault-key-file]');Object.defineProperty(file.element,'files',{configurable:true,value:[{name:'synthetic.key',text:async()=>encrypted}]});
    await file.trigger('change');
    await vi.waitFor(()=>expect(wrapper.find('[data-testid=vault-key-passphrase]').exists()).toBe(true));
    expect(confirm).not.toHaveBeenCalled();
    await wrapper.get('[data-testid=vault-key-passphrase]').setValue('synthetic key passphrase');await wrapper.get('[data-testid=vault-key-vault-passphrase]').setValue(PASS);
    await wrapper.get('form').trigger('submit');await vi.waitFor(()=>expect(wrapper.emitted('added')).toHaveLength(1),{timeout:10000});
    expect(confirm).toHaveBeenCalledTimes(1);wrapper.unmount();
  });
});
