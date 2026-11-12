import { describe, expect, it } from 'vitest';
import {
  KeyVaultStore,
  generateSyncPassphrase,
  vaultPassphraseReusesSync,
} from '../../src/index';
import { MemoryTransport } from './memoryTransport';

const KDF = { m: 32768, t: 3, p: 1 };
const PASS = 'correct horse battery staple';

describe('reset never wipes a newer vault', () => {
  it('refuses unsupportedVersion unless forced, and wipes nothing', async () => {
    const transport = new MemoryTransport();
    const store = new KeyVaultStore({ transport, kdf: KDF });
    await store.createVault(PASS);
    await store.addPassword('pw', 'p');
    const header = JSON.parse(transport.slots.get('vault')!.data);
    const newer = JSON.stringify({ ...header, v: 2 });
    transport.put('vault', newer);
    const old = new KeyVaultStore({ transport, kdf: KDF });
    expect(await old.resetVault('reset pass')).toEqual({ kind: 'unsupportedVersion' });
    expect(transport.slots.get('vault')!.data).toBe(newer);
    expect([...transport.slots.keys()].some((slot) => slot.startsWith('vk-'))).toBe(true);
    expect((await old.resetVault('reset pass', { forceUnsupported: true })).kind).toBe('ok');
  });
});

describe('decision #7: the vault passphrase never doubles as the sync passphrase', () => {
  it('generateSyncPassphrase gives 32 random bytes as base64url', () => {
    const a = generateSyncPassphrase();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateSyncPassphrase()).not.toBe(a);
  });

  it('flags a passphrase equal to the known sync passphrase or one that opens the host list', async () => {
    expect(await vaultPassphraseReusesSync('same', { syncPassphrase: 'same' })).toBe(true);
    expect(await vaultPassphraseReusesSync('café', { syncPassphrase: 'café' })).toBe(true);
    const opens = async (p: string) => p === 'host list pass';
    expect(await vaultPassphraseReusesSync('host list pass', { opensHostList: opens })).toBe(true);
    expect(await vaultPassphraseReusesSync('different', { syncPassphrase: 'same', opensHostList: opens })).toBe(false);
    expect(await vaultPassphraseReusesSync('anything', {})).toBe(false);
  });
});
