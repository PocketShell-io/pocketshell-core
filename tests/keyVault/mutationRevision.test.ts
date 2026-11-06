import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KeyVaultStore, type VaultServerVerifier } from '../../src/index';
import { MemoryTransport } from './memoryTransport';

const PASS = 'correct horse battery staple';
const KDF = { m: 32768, t: 3, p: 1 };
const pem = () => String(generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
const verifier: VaultServerVerifier = {
  verify: async () => ({ kind: 'ok' }),
  setVerifier: async input => ({ kind: 'ok', epoch: input.epoch }),
};

async function fixture() {
  const transport = new MemoryTransport();
  const store = new KeyVaultStore({ transport, verifier, kdf: KDF });
  expect(await store.createVault(PASS)).toEqual({ kind: 'ok' });
  const old = { ...transport.slots.get('vault')! };
  const first = await store.addKey(pem(), 'first key');
  const next = await store.addKey(pem(), 'replacement key');
  if (first.kind !== 'ok' || next.kind !== 'ok') throw new Error('fixture keys');
  expect((await store.addPassword('accepted secret', 'keep this entry')).kind).toBe('ok');
  expect((await store.bindHost('original-host', first.entry.keyId, 'managed')).kind).toBe('ok');
  const accepted = { ...transport.slots.get('vault')! };
  return { store, transport, old, accepted, first: first.entry, next: next.entry };
}

describe('Mutation revision floor', () => {
  for (const operation of ['key', 'password', 'bind', 'replacement'] as const) {
    for (const replay of ['lower', 'equal-changed'] as const) {
      for (const gate of ['none', 'push', 'pull'] as const) {
        it(`rejects ${replay} content during ${gate} gated ${operation} retry and direct retry`, async () => {
          const { store, transport, old, accepted, first, next } = await fixture();
          expect(await store.confirmPassphrase(PASS)).toEqual({ kind: 'ok' });
          const savedKeys = store.listKeys();
          const savedBinding = store.getHostBinding('original-host');
          const stale = { ...old, version: replay === 'lower' ? old.version : accepted.version };
          const push = transport.push.bind(transport);
          const pull = transport.pull.bind(transport);
          let indexAttempts = 0;
          let gateDelivered = false;
          let conflicted = false;
          let gatedPull = false;
          transport.push = async (slot, data, base) => {
            if (slot === 'vault') {
              indexAttempts += 1;
              if (gate === 'push' && !gateDelivered) {
                gateDelivered = true;
                return { kind: 'gated' };
              }
              if (!conflicted) {
                conflicted = true;
                transport.slots.set('vault', stale);
                return { kind: 'conflict', currentVersion: stale.version };
              }
            }
            return push(slot, data, base);
          };
          transport.pull = async slot => {
            if (slot === 'vault' && conflicted && gate === 'pull' && !gatedPull) {
              gatedPull = true;
              return { kind: 'gated' };
            }
            return pull(slot);
          };
          const key = pem();
          const mutate = () => operation === 'key' ? store.addKey(key, 'pending addition', undefined, async () => true)
            : operation === 'password' ? store.addPassword('pending secret', 'pending addition', async () => true)
            : operation === 'bind' ? store.bindHost('new-host', next.keyId, 'managed', async () => true)
            : store.rotateKey(first.keyId, next.keyId, async () => true);
          transport.writes.length = 0;
          expect((await mutate()).kind).toBe('vaultChanged');
          expect(store.listKeys()).toEqual(savedKeys);
          expect(store.getHostBinding('original-host')).toEqual(savedBinding);
          expect(store.getHostBinding('new-host')).toBeNull();
          expect(transport.slots.get('vault')).toEqual(stale);
          expect(transport.writes.filter(slot => slot === 'vault')).toEqual([]);
          expect(indexAttempts).toBe(gate === 'push' ? 2 : 1);
          if (gate === 'pull') expect(gatedPull).toBe(true);
          const attempts = indexAttempts;
          const writes = [...transport.writes];
          expect((await mutate()).kind).not.toBe('ok');
          expect(indexAttempts).toBe(attempts);
          expect(transport.writes).toEqual(writes);
          expect(store.listKeys()).toEqual(savedKeys);
        });
      }
    }
  }

  it('rejects equal-revision changed authenticated content at fresh confirmation', async () => {
    const { store, transport, old, accepted } = await fixture();
    transport.slots.set('vault', { ...old, version: accepted.version });
    transport.writes.length = 0;
    expect((await store.confirmPassphrase(PASS)).kind).not.toBe('ok');
    expect((await store.addPassword('pending', 'pending')).kind).not.toBe('ok');
    expect(transport.writes).toEqual([]);
    expect(store.listKeys().some(entry => entry.name === 'keep this entry')).toBe(true);
  });

  it('accepts a spurious conflict carrying exactly the already accepted revision', async () => {
    const { store, transport } = await fixture();
    const push = transport.push.bind(transport);
    let conflicted = false;
    transport.push = async (slot, data, base) => {
      if (slot === 'vault' && !conflicted) {
        conflicted = true;
        return { kind: 'conflict', currentVersion: base };
      }
      return push(slot, data, base);
    };
    expect((await store.addPassword('pending', 'pending')).kind).toBe('ok');
    expect(store.listKeys().some(entry => entry.name === 'keep this entry')).toBe(true);
  });

  it('a rejected session also refuses unguarded index mutations and passphrase changes', async () => {
    const { store, transport, old, first } = await fixture();
    const push = transport.push.bind(transport);
    let conflicted = false;
    transport.push = async (slot, data, base) => {
      if (slot === 'vault' && !conflicted) {
        conflicted = true;
        transport.slots.set('vault', old);
        return { kind: 'conflict', currentVersion: old.version };
      }
      return push(slot, data, base);
    };
    expect((await store.bindHost('new-host', first.keyId, 'managed')).kind).toBe('vaultChanged');
    transport.writes.length = 0;
    expect((await store.renameKey(first.keyId, 'renamed')).kind).toBe('vaultChanged');
    expect((await store.removeKey(first.keyId)).kind).toBe('vaultChanged');
    expect((await store.unbindHost('original-host')).kind).toBe('vaultChanged');
    expect((await store.setSyncPassphrase('different sync passphrase')).kind).toBe('vaultChanged');
    expect((await store.changePassphrase(PASS, 'different vault passphrase')).kind).toBe('vaultChanged');
    expect(transport.writes).toEqual([]);
    expect(store.getKey(first.keyId)?.name).toBe('first key');
  });

  it('refuses a non-monotonic successful index-write acknowledgement', async () => {
    const { store, transport, accepted } = await fixture();
    const push = transport.push.bind(transport);
    transport.push = async (slot, data, base) => slot === 'vault'
      ? { kind: 'ok', version: accepted.version }
      : push(slot, data, base);
    expect((await store.addPassword('pending', 'pending')).kind).toBe('vaultChanged');
    expect(store.listKeys().some(entry => entry.name === 'pending')).toBe(false);
    expect(store.listKeys().some(entry => entry.name === 'keep this entry')).toBe(true);
    const writes = [...transport.writes];
    expect((await store.addPassword('second pending', 'second pending')).kind).not.toBe('ok');
    expect(transport.writes).toEqual(writes);
  });

  it('fresh confirmation accepts a higher authenticated index without replacing the remembered DEK', async () => {
    const { store, transport } = await fixture();
    const before = store.exportRememberRecord()!;
    const other = new KeyVaultStore({ transport });
    expect((await other.unlock(PASS)).kind).toBe('ok');
    expect((await other.addPassword('another device secret', 'newer accepted entry')).kind).toBe('ok');
    const version = transport.slots.get('vault')!.version;
    expect(await store.confirmPassphrase(PASS)).toEqual({ kind: 'ok' });
    expect(store.exportRememberRecord()).toEqual(before);
    expect(store.listKeys().some(entry => entry.name === 'newer accepted entry')).toBe(true);
    transport.writes.length = 0;
    expect((await store.addPassword('pending secret', 'pending addition')).kind).toBe('ok');
    expect(transport.slots.get('vault')!.version).toBe(version + 1);
    expect(store.listKeys().some(entry => entry.name === 'newer accepted entry')).toBe(true);
    expect(transport.writes.filter(slot => slot === 'vault')).toHaveLength(1);
    before.dek.fill(0); before.auth?.fill(0);
  });

  it('pins a newer confirmed revision before a subsequent replay between the prior and confirmed revisions', async () => {
    const { store, transport } = await fixture();
    const previous = { ...transport.slots.get('vault')! };
    const other = new KeyVaultStore({ transport });
    expect((await other.unlock(PASS)).kind).toBe('ok');
    expect((await other.addPassword('newer secret', 'newer accepted entry')).kind).toBe('ok');
    expect(await store.confirmPassphrase(PASS)).toEqual({ kind: 'ok' });
    const push = transport.push.bind(transport);
    let conflict = false;
    transport.push = async (slot, data, base) => {
      if (slot === 'vault' && !conflict) {
        conflict = true;
        transport.slots.set('vault', previous);
        return { kind: 'conflict', currentVersion: previous.version };
      }
      return push(slot, data, base);
    };
    transport.writes.length = 0;
    expect((await store.addPassword('pending', 'pending')).kind).toBe('vaultChanged');
    expect(store.listKeys().some(entry => entry.name === 'newer accepted entry')).toBe(true);
    expect(transport.writes.filter(slot => slot === 'vault')).toEqual([]);
  });

  for (const operation of ['key', 'password', 'bind', 'replacement'] as const) {
    it(`still rebases a legitimate higher revision during ${operation}`, async () => {
      const { store, transport, first, next } = await fixture();
      expect(await store.confirmPassphrase(PASS)).toEqual({ kind: 'ok' });
      const other = new KeyVaultStore({ transport });
      expect((await other.unlock(PASS)).kind).toBe('ok');
      const push = transport.push.bind(transport);
      let conflicted = false;
      transport.push = async (slot, data, base) => {
        if (slot === 'vault' && !conflicted) {
          conflicted = true;
          expect((await other.addPassword('concurrent secret', 'concurrent accepted entry')).kind).toBe('ok');
        }
        return push(slot, data, base);
      };
      const result = operation === 'key' ? await store.addKey(pem(), 'pending addition')
        : operation === 'password' ? await store.addPassword('pending secret', 'pending addition')
        : operation === 'bind' ? await store.bindHost('new-host', next.keyId, 'managed')
        : await store.rotateKey(first.keyId, next.keyId);
      expect(result.kind).toBe('ok');
      expect(store.listKeys().some(entry => entry.name === 'concurrent accepted entry')).toBe(true);
      expect(store.listKeys().some(entry => entry.name === 'keep this entry')).toBe(true);
      if (operation === 'bind') expect(store.getHostBinding('new-host')?.keyId).toBe(next.keyId);
      if (operation === 'replacement') expect(store.getHostBinding('original-host')?.keyId).toBe(next.keyId);
    });
  }
});
