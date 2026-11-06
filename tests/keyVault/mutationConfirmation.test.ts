import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KeyVaultStore, type VaultSlotTransport } from '../../src/index';
import { MemoryTransport } from './memoryTransport';

const PASS='correct horse battery staple';
const KDF={m:32768,t:3,p:1};
const pem=()=>String(generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}));
async function setup(){const transport=new MemoryTransport();const store=new KeyVaultStore({transport,kdf:KDF});await store.createVault(PASS);transport.writes.length=0;return{store,transport};}

describe('Vault mutation confirmation and custody',()=>{
  it('checks the current passphrase without replacing the live session or remembered DEK',async()=>{
    const{store,transport}=await setup();
    const before=store.exportRememberRecord()!;
    expect((await store.confirmPassphrase('wrong')).kind).toBe('wrongPassphrase');
    expect(await store.confirmPassphrase(PASS)).toEqual({kind:'ok'});
    const after=store.exportRememberRecord()!;
    expect(after).toEqual(before);expect(transport.writes).toEqual([]);
    before.dek.fill(0);before.auth?.fill(0);after.dek.fill(0);after.auth?.fill(0);
  });
  it('confirms against the current header after a passphrase change on another device',async()=>{
    const{store,transport}=await setup();
    const other=new KeyVaultStore({transport});await other.unlock(PASS);
    await other.changePassphrase(PASS,'a different strong passphrase');
    expect((await store.confirmPassphrase(PASS)).kind).toBe('error');
    expect((await store.confirmPassphrase('a different strong passphrase')).kind).toBe('error');
    store.lock();await store.unlock('a different strong passphrase');
    expect(await store.confirmPassphrase('a different strong passphrase')).toEqual({kind:'ok'});
  });
  it('refuses a header older than the session version instead of authorizing a rolled-back passphrase',async()=>{
    const{store,transport}=await setup();
    const header=transport.slots.get('vault')!;
    transport.slots.set('vault',{...header,version:header.version-1});
    expect((await store.confirmPassphrase(PASS)).kind).toBe('error');expect(transport.writes).toEqual([]);
  });
  for(const kind of ['key','password'] as const){
    it(`a same-tick lock cancels a queued ${kind} addition before any writes`,async()=>{
      const{store,transport}=await setup();
      const pending=kind==='key'?store.addKey(pem(),'new'):store.addPassword('synthetic-secret','new');
      store.lock();expect((await pending).kind).toBe('locked');expect(transport.writes).toEqual([]);
    });
    it(`cancellation after ${kind} preparation refuses the first write`,async()=>{
      const{store,transport}=await setup();let checks=0;
      const active=async()=>++checks===1;
      const result=kind==='key'?await store.addKey(pem(),'new',undefined,active):await store.addPassword('synthetic-secret','new',active);
      expect(result.kind).not.toBe('ok');expect(transport.writes).toEqual([]);
    });
  }
  it('captures the account transport at call time instead of following a later account selection',async()=>{
    const a=new MemoryTransport();const b=new MemoryTransport();let current=a;
    const transport:VaultSlotTransport={scoped:()=>current,pull:slot=>current.pull(slot),push:(...args)=>current.push(...args),delete:slot=>current.delete(slot),list:()=>current.list()};
    const store=new KeyVaultStore({transport,kdf:KDF});await store.createVault(PASS);a.writes.length=0;
    const pending=store.addPassword('synthetic-secret','original account');current=b;
    expect((await pending).kind).toBe('ok');expect(b.writes).toEqual([]);expect(a.writes).toHaveLength(2);
  });
  it('an account guard that changes while a bound header read is pending prevents KDF continuation',async()=>{
    const{store,transport}=await setup();let active=true;
    const original=transport.pull.bind(transport);let release! :()=>void;let entered! :()=>void;
    const reading=new Promise<void>(resolve=>{entered=resolve;});
    transport.pull=async slot=>{entered();await new Promise<void>(resolve=>{release=resolve;});return original(slot);};
    const pending=store.confirmPassphrase(PASS,async()=>active);await reading;active=false;release();
    expect((await pending).kind).not.toBe('ok');expect(transport.writes).toEqual([]);
  });
  it('a compound password and host binding use one index CAS, with no intermediate credential grant',async()=>{
    const{store,transport}=await setup();
    const added=await store.addPassword('synthetic-secret','host password',undefined,{hostAlias:'new-host',gatewayAuth:'managed'});
    expect(added.kind).toBe('ok');if(added.kind!=='ok')throw new Error('add');
    expect(transport.writes.filter(slot=>slot==='vault')).toHaveLength(1);
    expect(store.getHostBinding('new-host')).toEqual({keyId:added.entry.keyId,gatewayAuth:'managed'});
  });
  it('a duplicate key can be granted to another host without rewriting its sealed blob',async()=>{
    const{store,transport}=await setup();const key=pem();const first=await store.addKey(key,'first');if(first.kind!=='ok')throw new Error('fixture');
    transport.writes.length=0;
    const second=await store.addKey(key,'duplicate',undefined,undefined,{hostAlias:'new-host',gatewayAuth:'managed'});
    expect(second.kind).toBe('ok');expect(transport.writes).toEqual(['vault']);
    expect(store.getHostBinding('new-host')?.keyId).toBe(first.entry.keyId);
  });
});
