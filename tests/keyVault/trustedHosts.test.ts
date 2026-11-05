import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KeyVaultStore, importAesKey, sealTrustedHost, openTrustedHost, parseTrustedHostEnvelope, trustedHostSlot, trustedHostAad } from '../../src/index';
import { MemoryTransport } from './memoryTransport';
const vector = JSON.parse(readFileSync(new URL('./fixtures/trusted-host-v1-vector.json',import.meta.url),'utf8'));
describe('trusted host v1 interoperability and authentication', () => {
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
