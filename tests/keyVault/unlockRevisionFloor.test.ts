import { describe, expect, it } from 'vitest';
import { KeyVaultStore, parseVaultHeader, type VaultServerVerifier, type VaultSlotTransport } from '../../src/index';
import { MemoryTransport } from './memoryTransport';

const PASS = 'correct horse battery staple';
const NEXT = 'a different strong vault passphrase';
const KDF = { m: 32768, t: 3, p: 1 };

async function fixture(gated = false) {
  const transport = new MemoryTransport();
  const verifier: VaultServerVerifier | undefined = gated ? {
    status: async () => {
      const header = parseVaultHeader(transport.slots.get('vault')?.data ?? '');
      return { kind: 'ok', epoch: header?.epoch ?? 1, hasVerifier: !!header, retryAfterMs: 0, ...(header ? { kdf: header.kdf } : {}) };
    },
    verify: async () => ({ kind: 'ok' }),
    setVerifier: async input => ({ kind: 'ok', epoch: input.epoch }),
  } : undefined;
  const store = new KeyVaultStore({ transport, verifier, kdf: KDF });
  expect((await store.createVault(PASS)).kind).toBe('ok');
  const old = { ...transport.slots.get('vault')! };
  expect((await store.addPassword('accepted secret', 'keep accepted entry')).kind).toBe('ok');
  const accepted = { ...transport.slots.get('vault')! };
  const record = store.exportRememberRecord()!;
  return { store, transport, old, accepted, record };
}

describe('Accepted revision knowledge survives secret-session disposal', () => {
  for (const mode of ['passphrase', 'remembered'] as const) {
    for (const replay of ['lower', 'equal-changed'] as const) {
      for (const gated of [false, true]) {
        for (const rejectedBeforeLock of [false, true]) {
          it(`${mode} refuses ${replay} through lock, ${gated ? 'gated' : 'ungated'} unlock and direct retry, prior rejection=${rejectedBeforeLock}`, async () => {
            const { store, transport, old, accepted, record } = await fixture(gated);
            const stale = { ...old, version: replay === 'lower' ? old.version : accepted.version };
            const push = transport.push.bind(transport);
            if (rejectedBeforeLock) {
              let conflicted = false;
              transport.push = async (slot, data, base) => {
                if (slot === 'vault' && !conflicted) {
                  conflicted = true;
                  transport.slots.set('vault', stale);
                  return { kind: 'conflict', currentVersion: stale.version };
                }
                return push(slot, data, base);
              };
              expect((await store.addPassword('interrupted', 'interrupted')).kind).toBe('vaultChanged');
              expect(store.listKeys().some(entry => entry.name === 'keep accepted entry')).toBe(true);
            } else transport.slots.set('vault', stale);
            transport.push = push;
            store.lock();
            transport.writes.length = 0;
            const open = () => mode === 'passphrase' ? store.unlock(PASS) : store.unlockWithRememberedDek(record);
            expect((await open()).kind).not.toBe('ok');
            expect(store.state).toBe('locked');
            expect((await store.confirmPassphrase(PASS)).kind).not.toBe('ok');
            expect((await store.addPassword('pending secret', 'pending')).kind).not.toBe('ok');
            store.lock();
            expect((await open()).kind).not.toBe('ok');
            expect((await store.addPassword('second pending', 'second pending')).kind).not.toBe('ok');
            expect(transport.writes).toEqual([]);
            expect(transport.slots.get('vault')).toEqual(stale);
            // Returning the genuine accepted revision restores service; the
            // failed replay did not erase the floor or poison valid content.
            transport.slots.set('vault', accepted);
            expect((await open()).kind).toBe('ok');
            expect(await store.confirmPassphrase(PASS)).toEqual({ kind: 'ok' });
            expect((await store.addPassword('new secret', 'new addition')).kind).toBe('ok');
            expect(store.listKeys().some(entry => entry.name === 'keep accepted entry')).toBe(true);
            expect(transport.writes.filter(slot => slot === 'vault')).toHaveLength(1);
            record.dek.fill(0); record.auth?.fill(0);
          });
        }
      }
    }

    it(`${mode} accepts a genuine higher revision after lock`, async () => {
      const { store, transport, record } = await fixture();
      const other = new KeyVaultStore({ transport });
      expect((await other.unlock(PASS)).kind).toBe('ok');
      expect((await other.addPassword('newer secret', 'newer accepted entry')).kind).toBe('ok');
      store.lock();
      const result = mode === 'passphrase' ? await store.unlock(PASS) : await store.unlockWithRememberedDek(record);
      expect(result.kind).toBe('ok');
      expect(store.listKeys().map(entry => entry.name)).toEqual(['keep accepted entry', 'newer accepted entry']);
      record.dek.fill(0); record.auth?.fill(0);
    });

    it(`${mode} accepts a new reset vault and refuses the retired lower epoch`, async () => {
      const { store, transport, accepted, record } = await fixture();
      const oldId = store.vaultId;
      expect((await store.resetVault(NEXT)).kind).toBe('ok');
      expect(store.vaultId).not.toBe(oldId);
      const reset = { ...transport.slots.get('vault')! };
      const resetRecord = store.exportRememberRecord()!;
      store.lock();
      const open = () => mode === 'passphrase' ? store.unlock(NEXT) : store.unlockWithRememberedDek(resetRecord);
      expect((await open()).kind).toBe('ok');
      expect(await store.confirmPassphrase(NEXT)).toEqual({ kind: 'ok' });
      store.lock();
      transport.slots.set('vault', accepted);
      const rollback = mode === 'passphrase' ? await store.unlock(PASS) : await store.unlockWithRememberedDek(record);
      expect(rollback.kind).not.toBe('ok');
      transport.slots.set('vault', reset);
      expect((await open()).kind).toBe('ok');
      record.dek.fill(0); record.auth?.fill(0); resetRecord.dek.fill(0); resetRecord.auth?.fill(0);
    });

    it(`${mode} cannot bypass an old revision by relabeling its known vault epoch`, async () => {
      const { store, transport, old, accepted, record } = await fixture();
      const header = JSON.parse(old.data);
      header.epoch += 1;
      transport.slots.set('vault', { data: JSON.stringify(header), version: accepted.version + 1 });
      store.lock();
      const changedRecord = { ...record, epoch: header.epoch };
      const result = mode === 'passphrase' ? await store.unlock(PASS) : await store.unlockWithRememberedDek(changedRecord);
      expect(result.kind).not.toBe('ok');
      record.dek.fill(0); record.auth?.fill(0);
    });
  }

  it('isolates account namespaces even if they hold the same encrypted vault identity at different revisions', async () => {
    const a = new MemoryTransport();
    const b = new MemoryTransport();
    let selected = a;
    const transport: VaultSlotTransport = {
      get scope() { return selected; },
      scoped: () => selected,
      pull: slot => selected.pull(slot), push: (...args) => selected.push(...args),
      delete: slot => selected.delete(slot), list: () => selected.list(),
    };
    const store = new KeyVaultStore({ transport, kdf: KDF });
    expect((await store.createVault(PASS)).kind).toBe('ok');
    const old = { ...a.slots.get('vault')! };
    expect((await store.addPassword('a secret', 'account A accepted')).kind).toBe('ok');
    const acceptedA = { ...a.slots.get('vault')! };
    store.lock(); selected = b; b.slots.set('vault', old);
    expect((await store.unlock(PASS)).kind).toBe('ok');
    expect(await store.confirmPassphrase(PASS)).toEqual({ kind: 'ok' });
    expect((await store.addPassword('b secret', 'account B accepted')).kind).toBe('ok');
    expect(store.listKeys().map(entry => entry.name)).toEqual(['account B accepted']);
    store.lock(); selected = a; a.slots.set('vault', old);
    expect((await store.unlock(PASS)).kind).not.toBe('ok');
    a.slots.set('vault', acceptedA);
    expect((await store.unlock(PASS)).kind).toBe('ok');
    expect(store.listKeys().map(entry => entry.name)).toEqual(['account A accepted']);
  });

  it('can accept a genuinely new vault at a lower slot revision without reviving a retired vault', async () => {
    const { store, transport, accepted, record } = await fixture();
    const oldId = store.vaultId;
    store.lock(); transport.slots.clear();
    const creator = new KeyVaultStore({ transport, kdf: KDF });
    expect((await creator.createVault(NEXT)).kind).toBe('ok');
    expect(transport.slots.get('vault')!.version).toBeLessThan(accepted.version);
    expect((await store.unlock(NEXT)).kind).toBe('ok');
    expect(store.vaultId).not.toBe(oldId);
    const current = { ...transport.slots.get('vault')! };
    store.lock(); transport.slots.set('vault', accepted);
    expect((await store.unlock(PASS)).kind).not.toBe('ok');
    expect((await store.unlockWithRememberedDek(record)).kind).not.toBe('ok');
    transport.slots.set('vault', current);
    expect((await store.unlock(NEXT)).kind).toBe('ok');
    record.dek.fill(0); record.auth?.fill(0);
  });

  it('keeps only non-secret floor data while lock wipes the held DEK and AUTH', async () => {
    const { store, transport, accepted, record } = await fixture();
    const held = Reflect.get(store, 'unlocked');
    store.lock();
    expect(Reflect.get(store, 'unlocked')).toBeNull();
    expect(Array.from(held.dek)).toEqual(Array(32).fill(0));
    expect(Array.from(held.auth)).toEqual(Array(32).fill(0));
    const account = Reflect.get(store, 'revisionFloors').get(transport);
    const floor = account.vaults.get(record.vaultId);
    expect(Object.keys(floor).sort()).toEqual(['epoch', 'header', 'version']);
    expect(floor.version).toBe(accepted.version);
    expect(floor.header).not.toContain(PASS);
    expect(floor.header).not.toContain('accepted secret');
    expect(floor.header).not.toContain('keep accepted entry');
    expect(floor.header).not.toContain(Buffer.from(record.dek).toString('base64url'));
    record.dek.fill(0); record.auth?.fill(0);
  });

  it('retains an accepted index acknowledgement even if ordinary lock happens before its response is consumed', async () => {
    const { store, transport, accepted, record } = await fixture();
    const push = transport.push.bind(transport);
    transport.push = async (slot, data, base) => {
      const result = await push(slot,data,base);
      if (slot === 'vault' && result.kind === 'ok') store.lock();
      return result;
    };
    expect((await store.addPassword('dispatched secret','accepted while locking')).kind).not.toBe('ok');
    expect(store.state).toBe('locked');
    const latest = { ...transport.slots.get('vault')! };
    transport.push = push;
    transport.slots.set('vault',accepted);
    expect((await store.unlock(PASS)).kind).not.toBe('ok');
    expect((await store.unlockWithRememberedDek(record)).kind).not.toBe('ok');
    transport.slots.set('vault',latest);
    expect((await store.unlock(PASS)).kind).toBe('ok');
    expect(store.listKeys().some(entry => entry.name === 'accepted while locking')).toBe(true);
    record.dek.fill(0); record.auth?.fill(0);
  });

  it('retains accepted fresh-creation content if lock happens during its dispatched write', async () => {
    const transport = new MemoryTransport();
    const store = new KeyVaultStore({transport,kdf:KDF});
    const push = transport.push.bind(transport);
    transport.push = async (...args) => { const result = await push(...args);store.lock();return result; };
    expect((await store.createVault(PASS)).kind).toBe('ok');
    expect(store.state).toBe('locked');
    const accepted = { ...transport.slots.get('vault')! };
    const header = JSON.parse(accepted.data);header.updatedAt='2020-01-01T00:00:00.000Z';
    transport.slots.set('vault',{version:accepted.version,data:JSON.stringify(header)});
    expect((await store.unlock(PASS)).kind).not.toBe('ok');
    transport.slots.set('vault',accepted);
    expect((await store.unlock(PASS)).kind).toBe('ok');
  });

  it('a new account reset neither inherits another scope credentials nor rewrites its data or floor', async () => {
    const a=new MemoryTransport();const b=new MemoryTransport();let selected=a;
    const transport:VaultSlotTransport={get scope(){return selected;},scoped:()=>selected,
      pull:slot=>selected.pull(slot),push:(...args)=>selected.push(...args),delete:slot=>selected.delete(slot),list:()=>selected.list()};
    const store=new KeyVaultStore({transport,kdf:KDF});
    expect((await store.createVault(PASS,{syncPassphrase:'account A sync secret'})).kind).toBe('ok');
    expect((await store.addPassword('A secret','A entry')).kind).toBe('ok');
    const acceptedA={...a.slots.get('vault')!};
    selected=b;
    expect((await store.resetVault(NEXT)).kind).toBe('ok');
    expect(store.getSyncPassphrase()).toBeNull();expect(store.listKeys()).toEqual([]);
    expect(a.slots.get('vault')).toEqual(acceptedA);
    store.lock();selected=a;
    expect((await store.unlock(PASS)).kind).toBe('ok');
    expect(store.getSyncPassphrase()).toBe('account A sync secret');
    expect(store.listKeys().map(entry=>entry.name)).toEqual(['A entry']);
  });

  it('a selected foreign scope cannot change the held account passphrase', async () => {
    const a=new MemoryTransport();const b=new MemoryTransport();let selected=a;
    const transport:VaultSlotTransport={get scope(){return selected;},scoped:()=>selected,
      pull:slot=>selected.pull(slot),push:(...args)=>selected.push(...args),delete:slot=>selected.delete(slot),list:()=>selected.list()};
    const store=new KeyVaultStore({transport,kdf:KDF});
    expect((await store.createVault(PASS)).kind).toBe('ok');const accepted={...a.slots.get('vault')!};
    a.writes.length=0;selected=b;
    expect((await store.changePassphrase(PASS,NEXT)).kind).toBe('locked');
    expect(a.slots.get('vault')).toEqual(accepted);expect(a.writes).toEqual([]);expect(b.writes).toEqual([]);
  });

  it('a pending verifier proof remains tied to its original scope', async () => {
    const a=new MemoryTransport();const b=new MemoryTransport();let selected=a;let fail=false;
    const proofs:string[]=[];
    const verifierFor=(name:string):VaultServerVerifier=>({verify:async()=>({kind:'ok'}),setVerifier:async input=>{
      proofs.push(name);return fail?{kind:'unavailable'}:{kind:'ok',epoch:input.epoch};
    }});
    let av=verifierFor('a');const bv=verifierFor('b');
    const verifier:VaultServerVerifier={scoped:()=>selected===a?av:bv,verify:async()=>({kind:'ok'}),setVerifier:input=>(selected===a?av:bv).setVerifier(input)};
    const transport:VaultSlotTransport={get scope(){return selected;},scoped:()=>selected,
      pull:slot=>selected.pull(slot),push:(...args)=>selected.push(...args),delete:slot=>selected.delete(slot),list:()=>selected.list()};
    const store=new KeyVaultStore({transport,verifier,kdf:KDF});
    expect((await store.createVault(PASS)).kind).toBe('ok');fail=true;
    expect(await store.changePassphrase(PASS,NEXT)).toEqual({kind:'ok',verifierPending:true});
    proofs.length=0;selected=b;
    expect((await store.retryVerifierPublish()).kind).toBe('unavailable');expect(proofs).toEqual([]);
    selected=a;fail=false;av=verifierFor('refreshed-a');
    expect((await store.retryVerifierPublish()).kind).toBe('ok');expect(proofs).toEqual(['refreshed-a']);
  });

  it('a lock during an acknowledged passphrase write cannot reinstall a pending secret proof', async () => {
    const transport=new MemoryTransport();let fail=false;
    const verifier:VaultServerVerifier={verify:async()=>({kind:'ok'}),setVerifier:async input=>fail?{kind:'unavailable'}:{kind:'ok',epoch:input.epoch}};
    const store=new KeyVaultStore({transport,verifier,kdf:KDF});
    expect((await store.createVault(PASS)).kind).toBe('ok');fail=true;
    const push=transport.push.bind(transport);
    transport.push=async(...args)=>{const result=await push(...args);if(args[0]==='vault'&&result.kind==='ok')store.lock();return result;};
    expect((await store.changePassphrase(PASS,NEXT)).kind).toBe('ok');
    expect(store.state).toBe('locked');expect(store.verifierPending).toBe(false);
    expect(Reflect.get(store,'pendingVerifier')).toBeNull();
  });

  for(const operation of ['remove','rename','unbind','sync'] as const){
    it(`captures account ownership for a queued ${operation} mutation`,async()=>{
      const a=new MemoryTransport();const b=new MemoryTransport();let selected=a;
      const transport:VaultSlotTransport={get scope(){return selected;},scoped:()=>selected,
        pull:slot=>selected.pull(slot),push:(...args)=>selected.push(...args),delete:slot=>selected.delete(slot),list:()=>selected.list()};
      const store=new KeyVaultStore({transport,kdf:KDF});
      expect((await store.createVault(PASS)).kind).toBe('ok');
      const added=await store.addPassword('secret','entry');if(added.kind!=='ok')throw new Error('fixture');
      expect((await store.bindHost('host',added.entry.keyId,'managed')).kind).toBe('ok');
      const accepted={...a.slots.get('vault')!};a.writes.length=0;
      const pending=operation==='remove'?store.removeKey(added.entry.keyId):operation==='rename'?store.renameKey(added.entry.keyId,'renamed')
        :operation==='unbind'?store.unbindHost('host'):store.setSyncPassphrase('new sync secret');
      selected=b;
      expect((await pending).kind).not.toBe('ok');expect(a.writes).toEqual([]);expect(b.writes).toEqual([]);
      expect(a.slots.get('vault')).toEqual(accepted);
    });
  }
});
