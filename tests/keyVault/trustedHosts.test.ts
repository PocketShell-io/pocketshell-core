import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { KeyVaultStore, importAesKey, sealTrustedHost, openTrustedHost, parseTrustedHostEnvelope, trustedHostSlot, trustedHostAad } from '../../src/index';
import { MemoryTransport } from './memoryTransport';
const vector = JSON.parse(readFileSync(new URL('./fixtures/trusted-host-v1-vector.json',import.meta.url),'utf8'));
describe('trusted host v1 interoperability and authentication', () => {
  async function pair() {
    const transport = new MemoryTransport();
    const make = () => new KeyVaultStore({transport,kdf:{m:32768,t:3,p:1}});
    const first=make(),second=make();
    await first.createVault('long fixture passphrase');
    await second.unlock('long fixture passphrase');
    const target={serverUrl:vector.identity.serverUrl,deviceId:vector.identity.deviceId};
    const register=async(store:KeyVaultStore)=>{
      const pem=String(generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}));
      const added=await store.addKey(pem,'new server');
      if(added.kind!=='ok') throw new Error('key creation failed');
      const data={...vector.data,keyId:added.entry.keyId};
      await store.bindHost(data.hostAlias,data.keyId,'managed');
      await store.putTrustedHost(vector.identity.accountId,target,data,0);
      return data;
    };
    return{transport,first,second,target,register};
  }

  it('an already unlocked phone discovers another client registration without another passphrase',async()=>{
    const {transport,first,second,register}=await pair();
    const data=await register(second);
    await second.bindHost('Other server',data.keyId,'managed');
    await second.putTrustedHost(vector.identity.accountId,{serverUrl:vector.identity.serverUrl,deviceId:'other-server'},
      {...data,hostAlias:'Other server'},0);
    let headerReads=0;
    const pull=transport.pull.bind(transport);
    transport.pull=async slot=>{if(slot==='vault') headerReads++;return pull(slot);};
    const hosts=await first.listTrustedHosts(vector.identity.accountId);
    expect(hosts).toHaveLength(2);expect(hosts.every(host=>host.keyId===data.keyId)).toBe(true);
    expect(first.state).toBe('unlocked');expect(headerReads).toBe(1);
  });

  it.each(['remove','rebind'])('direct dial refuses a binding another client changed (%s)',async(change)=>{
    const {first,second,target,register}=await pair();
    const data=await register(first);
    await second.unlock('long fixture passphrase');
    expect((await first.getTrustedHost(vector.identity.accountId,target)).kind).toBe('ok');
    if(change==='remove') await second.removeKey(data.keyId);
    else await second.bindHost(data.hostAlias,data.keyId,'host');
    expect((await first.getTrustedHost(vector.identity.accountId,target)).kind).toBe('invalid');
  });

  it.each(['rollback','same-version-change','tampered-index','reset','missing'])('fresh authorization refuses header %s',async(change)=>{
    const {transport,first,second,target,register}=await pair();
    const old=transport.slots.get('vault')!;
    await register(first);
    const current=transport.slots.get('vault')!;
    if(change==='rollback') transport.slots.set('vault',old);
    else if(change==='missing') transport.slots.delete('vault');
    else if(change==='reset') await second.resetVault('another strong fixture passphrase');
    else {
      const header=JSON.parse(current.data);
      if(change==='same-version-change') header.updatedAt='2026-10-01T00:00:00.000Z';
      else header.index.ct=(header.index.ct[0]==='A'?'B':'A')+header.index.ct.slice(1);
      transport.slots.set('vault',{version:current.version+(change==='tampered-index'?1:0),data:JSON.stringify(header)});
    }
    const read=await first.getTrustedHost(vector.identity.accountId,target);
    expect(read.kind).toBe(change==='rollback'?'rollback':'invalid');
    expect(first.state).toBe('locked');
  });

  it('a lock/account cancellation during header refresh wins, and queued unlock stays independent',async()=>{
    const {transport,first,target,register}=await pair();
    await register(first);
    const pull=transport.pull.bind(transport);
    let release!:(value:Awaited<ReturnType<typeof pull>>)=>void;
    let began!:()=>void;
    const started=new Promise<void>(r=>{began=r;});
    transport.pull=async slot=>{if(slot==='vault'){transport.pull=pull;began();return new Promise(r=>{release=r;});}return pull(slot);};
    const read=first.getTrustedHost(vector.identity.accountId,target);
    await started;
    first.lock();
    const unlock=first.unlock('long fixture passphrase');
    release(await pull('vault'));
    expect(await read).toEqual({kind:'locked'});
    expect(await unlock).toEqual({kind:'ok'});
    expect(first.state).toBe('unlocked');
  });

  it('trust refresh serializes with local index writes instead of overwriting their bindings',async()=>{
    const {transport,first,target,register}=await pair();
    const data=await register(first);
    const pull=transport.pull.bind(transport);
    let release!:(value:Awaited<ReturnType<typeof pull>>)=>void;
    let began!:()=>void;
    const started=new Promise<void>(r=>{began=r;});
    transport.pull=async slot=>{if(slot==='vault'){transport.pull=pull;began();return new Promise(r=>{release=r;});}return pull(slot);};
    const read=first.getTrustedHost(vector.identity.accountId,target);
    await started;
    const changed=first.bindHost(data.hostAlias,data.keyId,'host');
    release(await pull('vault'));
    expect((await read).kind).toBe('ok');
    expect(await changed).toEqual({kind:'ok'});
    expect(first.getHostBinding(data.hostAlias)?.gatewayAuth).toBe('host');
    expect((await first.getTrustedHost(vector.identity.accountId,target)).kind).toBe('invalid');
  });

  it('a list header timeout releases the queue and cannot later overwrite a completed local write',async()=>{
    const {transport,first,register}=await pair();
    const data=await register(first);
    const pull=transport.pull.bind(transport);
    const oldHeader=await pull('vault');
    let release!:(value:Awaited<ReturnType<typeof pull>>)=>void;
    let began!:()=>void;
    const started=new Promise<void>(r=>{began=r;});
    transport.pull=async slot=>{if(slot==='vault'){transport.pull=pull;began();return new Promise(r=>{release=r;});}return pull(slot);};
    vi.useFakeTimers();
    try {
      const list=first.listTrustedHosts(vector.identity.accountId);
      const refused=expect(list).rejects.toThrow('timed out');
      await started;
      await vi.advanceTimersByTimeAsync(15001);
      await refused;
      expect(await first.bindHost(data.hostAlias,data.keyId,'host')).toEqual({kind:'ok'});
      release(oldHeader);
      for(let i=0;i<8;i++) await Promise.resolve();
      expect(first.getHostBinding(data.hostAlias)?.gatewayAuth).toBe('host');
      expect(first.state).toBe('unlocked');
    } finally {vi.useRealTimers();}
  });
  it('matches independent deterministic AES-GCM, AAD, slot vector', async () => {
    const key = await importAesKey(new Uint8Array(Buffer.from(vector.dekHex,'hex')));
    expect(await trustedHostSlot(vector.identity)).toBe(vector.slot);
    expect(trustedHostAad(vector.identity)).toBe(vector.aad);
    expect(await sealTrustedHost(key,vector.identity,vector.data,new Uint8Array(Buffer.from(vector.envelope.n,'base64url')))).toEqual(vector.envelope);
    expect(await openTrustedHost(key,vector.envelope)).toEqual(vector.data);
    for(const field of ['accountId','deviceId','vaultId','serverUrl','epoch','revision']) {
      const changed = {...vector.envelope,[field]:typeof vector.envelope[field] === 'number' ? 2 : vector.envelope[field]+'x'};
      if(parseTrustedHostEnvelope(JSON.stringify(changed))) expect(await openTrustedHost(key,changed)).toBeNull();
    }
    expect(parseTrustedHostEnvelope(JSON.stringify({...vector.envelope,v:2}))).toBeNull();
    expect(parseTrustedHostEnvelope(JSON.stringify({...vector.envelope,extra:true}))).toBeNull();
    expect(parseTrustedHostEnvelope(JSON.stringify({...vector.envelope,serverUrl:null}))).toBeNull();
  });

  it('requires managed vault binding and refuses account/rotation/rollback/deletion/substitution', async () => {
    const transport = new MemoryTransport();
    const store = new KeyVaultStore({transport,kdf:{m:32768,t:3,p:1}});
    expect(await store.createVault('long fixture passphrase')).toEqual({kind:'ok'});
    const pem = String(generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}));
    const added = await store.addKey(pem,'fixture');
    if(added.kind !== 'ok') throw new Error('key creation failed');
    const data = {...vector.data,keyId:added.entry.keyId};
    const target = {serverUrl:vector.identity.serverUrl,deviceId:vector.identity.deviceId};
    await store.bindHost(data.hostAlias,data.keyId,'host');
    expect((await store.putTrustedHost(vector.identity.accountId,target,data,0)).kind).toBe('error');
    await store.bindHost(data.hostAlias,data.keyId,'managed');
    expect(await store.putTrustedHost(vector.identity.accountId,target,data,0)).toEqual({kind:'ok',version:1});
    expect((await store.getTrustedHost(vector.identity.accountId,target)).kind).toBe('ok');
    expect((await store.getTrustedHost('google:someone-else',target)).kind).toBe('invalid');
    expect((await store.getTrustedHost(vector.identity.accountId,target,2)).kind).toBe('rollback');
    await store.bindHost(data.hostAlias,data.keyId,'both');
    expect((await store.getTrustedHost(vector.identity.accountId,target)).kind).toBe('invalid');
    await store.bindHost(data.hostAlias,data.keyId,'managed');
    const slot = await trustedHostSlot(target);
    const original = transport.slots.get(slot)!;
    let pulls = 0;
    const realPull = transport.pull.bind(transport);
    transport.pull = async name => {if(name===slot) pulls++;return realPull(name);};
    expect(await store.listTrustedHosts(vector.identity.accountId)).toHaveLength(1);
    expect(pulls).toBe(1);
    transport.slots.set(slot,{...original,data:JSON.stringify({...JSON.parse(original.data),epoch:2})});
    expect((await store.getTrustedHost(vector.identity.accountId,target)).kind).toBe('invalid');
    transport.slots.set(slot,original);
    const different = await store.addKey(String(generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'})),'replacement');
    if(different.kind!=='ok') throw new Error('replacement key failed');
    await store.bindHost(data.hostAlias,different.entry.keyId,'managed');
    expect((await store.getTrustedHost(vector.identity.accountId,target)).kind).toBe('invalid');
    await store.bindHost(data.hostAlias,data.keyId,'managed');
    expect(await store.putTrustedHost(vector.identity.accountId,target,{...data,status:'revoked'},1)).toEqual({kind:'ok',version:2});
    const revoked = await store.getTrustedHost(vector.identity.accountId,target,2);
    expect(revoked.kind === 'ok' && revoked.host.status).toBe('revoked');
    transport.slots.set(slot,original);
    expect((await store.getTrustedHost(vector.identity.accountId,target,2)).kind).toBe('rollback');
    transport.slots.delete(slot);
    expect((await store.getTrustedHost(vector.identity.accountId,target,1)).kind).toBe('rollback');
    await expect(store.listTrustedHosts(vector.identity.accountId,{[slot]:1})).rejects.toThrow('missing');
  });

  it('does not return stale account results after a lock during list', async () => {
    const transport = new MemoryTransport();
    const store = new KeyVaultStore({transport,kdf:{m:32768,t:3,p:1}});
    await store.createVault('long fixture passphrase');
    transport.list = async () => {store.lock();return [];};
    await expect(store.listTrustedHosts(vector.identity.accountId)).rejects.toThrow('Vault changed');
  });
});
