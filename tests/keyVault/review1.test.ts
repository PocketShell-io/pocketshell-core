import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  KeyVaultStore,
  parseVaultHeader,
  vaultKeySlot,
  type VaultServerVerifier,
  type VaultVerifyResult,
} from '../../src/index';
import { MemoryTransport } from './memoryTransport';

/**
 * Regression tests for the independent crypto review of 6490d2d
 * (W1-review-1.md, items 1–7). Each was red before its fix.
 */
const KDF = { m: 32768, t: 3, p: 1 };
const PASS = 'correct horse battery staple';
const NEXT = 'the next vault passphrase';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ed25519Pem = () => String(generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));

async function fresh() {
  const transport = new MemoryTransport();
  const store = new KeyVaultStore({ transport, kdf: KDF });
  await store.createVault(PASS, { syncPassphrase: 'sync' });
  const make = () => new KeyVaultStore({ transport, kdf: KDF });
  return { transport, store, make };
}

/** Whichever passphrase now opens the vault, it must open it fully (index readable, keys decryptable). */
async function vaultIsIntact(make: () => KeyVaultStore, keyId?: string): Promise<'old' | 'new'> {
  for (const [label, pass] of [['old', PASS], ['new', NEXT]] as const) {
    const device = make();
    const result = await device.unlock(pass);
    if (result.kind === 'ok') {
      if (keyId) expect((await device.decryptKey(keyId)).kind).toBe('key');
      return label;
    }
    expect(result.kind, `${label} passphrase`).toBe('wrongPassphrase');
  }
  throw new Error('neither passphrase opens the vault: data loss');
}

describe('review #1: lock() during changePassphrase must not destroy the vault', () => {
  for (const delay of [0, 5, 30, 60, 120]) {
    it(`lock ${delay} ms into the change`, async () => {
      const { store, make } = await fresh();
      const key = await store.addKey(ed25519Pem(), 'k');
      if (key.kind !== 'ok') throw new Error('add failed');
      const change = store.changePassphrase(PASS, NEXT);
      await sleep(delay);
      store.lock();
      const result = await change;
      const which = await vaultIsIntact(make, key.entry.keyId);
      expect(which).toBe(result.kind === 'ok' ? 'new' : 'old');
    });
  }
});

describe('review #2: the store never writes an index its own parser rejects', () => {
  it('long names are clamped, and every device still unlocks', async () => {
    const { store, make } = await fresh();
    const long = 'n'.repeat(400);
    const key = await store.addKey(ed25519Pem(), long);
    const pw = await store.addPassword('pw', long);
    expect(key.kind).toBe('ok');
    expect(pw.kind).toBe('ok');
    if (key.kind === 'ok') await store.renameKey(key.entry.keyId, `x${long}`);
    const other = make();
    expect(await other.unlock(PASS)).toEqual({ kind: 'ok' });
    expect(other.listKeys().every((entry) => entry.name.length <= 256)).toBe(true);
  });

  it('an invalid rotatedFrom is refused', async () => {
    const { store, make } = await fresh();
    const key = await store.addKey(ed25519Pem(), 'k');
    if (key.kind !== 'ok') throw new Error('add failed');
    expect((await store.rotateKey('not-a-key-id', key.entry.keyId)).kind).not.toBe('ok');
    expect(await make().unlock(PASS)).toEqual({ kind: 'ok' });
  });

  it('reset refuses carried data the parser would reject', async () => {
    const { store, make } = await fresh();
    const bad = { '': { keyId: 'x', gatewayAuth: 'nope' } } as never;
    const result = await store.resetVault('reset passphrase', { hosts: bad, syncPassphrase: 7 as never });
    if (result.kind === 'ok') expect(await make().unlock('reset passphrase')).toEqual({ kind: 'ok' });
    else expect(await make().unlock(PASS)).toEqual({ kind: 'ok' });
  });
});

describe('review #3: lock() wins over in-flight operations', () => {
  it('an unlock that finishes after lock() stays locked', async () => {
    const { make } = await fresh();
    const device = make();
    const pending = device.unlock(PASS);
    await sleep(5);
    device.lock();
    await pending;
    expect(device.state).toBe('locked');
  });

  it('a remembered unlock that finishes after lock() stays locked', async () => {
    const { store, transport, make } = await fresh();
    const record = store.exportRememberRecord()!;
    const device = make();
    transport.pullDelayMs = 20;
    const pending = device.unlockWithRememberedDek(record);
    await sleep(5);
    device.lock();
    await pending;
    expect(device.state).toBe('locked');
  });

  it('a decrypt that finishes after lock() returns locked, not plaintext', async () => {
    const { store, transport } = await fresh();
    const key = await store.addKey(ed25519Pem(), 'k');
    if (key.kind !== 'ok') throw new Error('add failed');
    transport.pullDelayMs = 20;
    const pending = store.decryptKey(key.entry.keyId);
    await sleep(5);
    store.lock();
    expect(await pending).toEqual({ kind: 'locked' });
  });
});

describe('review #4: verifier drift after a passphrase change', () => {
  class Server implements VaultServerVerifier {
    auth: string | null = null;
    refuse = false;
    async verify(auth: Uint8Array): Promise<VaultVerifyResult> {
      if (this.auth === null) return { kind: 'noVerifier' };
      return Buffer.from(auth).toString('hex') === this.auth ? { kind: 'ok' } : { kind: 'wrong', retryAfterMs: 0 };
    }
    async setVerifier(input: { auth: Uint8Array; epoch: number; currentAuth?: Uint8Array }) {
      if (this.refuse) return { kind: 'unavailable' as const };
      if (this.auth !== null && (!input.currentAuth || Buffer.from(input.currentAuth).toString('hex') !== this.auth)) {
        return { kind: 'refused' as const };
      }
      this.auth = Buffer.from(input.auth).toString('hex');
      return { kind: 'ok' as const, epoch: input.epoch };
    }
  }

  it('a failed verifier publish is reported and repaired on the next unlock', async () => {
    const server = new Server();
    const transport = new MemoryTransport();
    const store = new KeyVaultStore({ transport, kdf: KDF, verifier: server });
    await store.createVault(PASS);
    const before = server.auth;
    server.refuse = true;
    const result = await store.changePassphrase(PASS, NEXT);
    expect(result).toEqual({ kind: 'ok', verifierPending: true });
    expect(server.auth).toBe(before);
    server.refuse = false;
    store.lock();
    // The new passphrase opens the vault locally; the store replaces the stale verifier with the kept old AUTH.
    expect(await store.unlock(NEXT)).toEqual({ kind: 'ok' });
    expect(server.auth).not.toBe(before);
    expect(await new KeyVaultStore({ transport, verifier: server }).unlock(NEXT)).toEqual({ kind: 'ok' });
  });

  it('a concurrent change on another device aborts this one instead of overwriting it', async () => {
    const { store, make } = await fresh();
    const other = make();
    await other.unlock(PASS);
    expect((await other.changePassphrase(PASS, NEXT)).kind).toBe('ok');
    const result = await store.changePassphrase(PASS, 'a third passphrase');
    expect(result.kind).toBe('passphraseChangedElsewhere');
    expect(await make().unlock(NEXT)).toEqual({ kind: 'ok' });
  });
});

describe('review #5 (store): duplicate uploads', () => {
  it('re-adding a key never rewrites its vk- slot', async () => {
    const { store, transport } = await fresh();
    const pem = ed25519Pem();
    const first = await store.addKey(pem, 'k');
    if (first.kind !== 'ok') throw new Error('add failed');
    const slot = vaultKeySlot(first.entry.keyId);
    const before = transport.slots.get(slot)!.version;
    const again = await store.addKey(pem, 'k');
    expect(again.kind === 'ok' && again.deduplicated).toBe(true);
    expect(transport.slots.get(slot)!.version).toBe(before);
  });
});

describe('review #6: KDF bounds', () => {
  it('refuses downgraded passes and memory that would exhaust a phone', async () => {
    const { transport } = await fresh();
    const header = JSON.parse(transport.slots.get('vault')!.data);
    for (const kdf of [{ t: 1 }, { t: 2 }, { m: 512 * 1024 }, { t: 64 }]) {
      expect(parseVaultHeader(JSON.stringify({ ...header, kdf: { ...header.kdf, ...kdf } })), JSON.stringify(kdf)).toBeNull();
    }
    expect(parseVaultHeader(JSON.stringify(header))).not.toBeNull();
  });
});

describe('review #7: robustness', () => {
  it('a lock during a 409 re-base returns locked instead of throwing', async () => {
    const { store, make } = await fresh();
    const key = await store.addKey(ed25519Pem(), 'k');
    if (key.kind !== 'ok') throw new Error('add failed');
    const other = make();
    await other.unlock(PASS);
    await other.bindHost('elsewhere', key.entry.keyId, 'host');
    const transport = (store as unknown as { transport: MemoryTransport }).transport;
    transport.beforePush = () => store.lock();
    const result = await store.bindHost('here', key.entry.keyId, 'both');
    expect(result.kind).toBe('locked');
  });

  it('a newer header version says unsupportedVersion, not corrupt', async () => {
    const { transport, make } = await fresh();
    const header = JSON.parse(transport.slots.get('vault')!.data);
    transport.put('vault', JSON.stringify({ ...header, v: 2 }));
    expect(await make().unlock(PASS)).toEqual({ kind: 'unsupportedVersion' });
    expect(await make().probe()).toEqual({ kind: 'unsupportedVersion' });
  });
});
