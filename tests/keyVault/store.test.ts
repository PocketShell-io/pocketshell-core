import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  KeyVaultStore,
  migrateLegacyKeys,
  parseLegacyKeysSlot,
  parseVaultHeader,
  vaultBackoffMs,
  vaultKeySlot,
  type VaultServerStatus,
  type VaultServerVerifier,
  type VaultVerifyResult,
} from '../../src/index';
import { MemoryTransport } from './memoryTransport';

/** The parser floor (32 MiB, 3 passes): real Argon2id, fast enough for a suite. */
const KDF = { m: 32768, t: 3, p: 1 };
const PASS = 'correct horse battery staple';

const ed25519Pem = () => String(generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
const rsaPem = (bits = 2048) =>
  String(generateKeyPairSync('rsa', { modulusLength: bits }).privateKey.export({ type: 'pkcs1', format: 'pem' }));

function setup(options: { clock?: { t: number }; verifier?: VaultServerVerifier } = {}) {
  const transport = new MemoryTransport();
  const now = options.clock ? () => options.clock!.t : undefined;
  const make = () =>
    new KeyVaultStore({ transport, kdf: KDF, ...(now ? { now } : {}), ...(options.verifier ? { verifier: options.verifier } : {}) });
  return { transport, store: make(), make };
}

describe('KeyVaultStore: create and unlock', () => {
  it('reports noVault, creates once, and unlocks from another device', async () => {
    const { store, make, transport } = setup();
    expect(await store.probe()).toEqual({ kind: 'noVault' });
    expect(await store.unlock(PASS)).toEqual({ kind: 'noVault' });
    expect(await store.createVault(PASS, { syncPassphrase: 'sync-pass' })).toEqual({ kind: 'ok' });
    expect(store.state).toBe('unlocked');
    expect(await store.createVault(PASS)).toEqual({ kind: 'exists' });

    const other = make();
    expect(other.state).toBe('locked');
    expect(await other.unlock(PASS)).toEqual({ kind: 'ok' });
    expect(other.getSyncPassphrase()).toBe('sync-pass');
    expect(other.vaultId).toBe(store.vaultId);
    expect(other.epoch).toBe(1);
    const header = parseVaultHeader(transport.slots.get('vault')!.data)!;
    expect(header.kdf).toMatchObject({ alg: 'argon2id', ...KDF });
    // Nothing secret is in the clear: the index is sealed.
    expect(transport.slots.get('vault')!.data).not.toContain('sync-pass');
  });

  it('a wrong passphrase is a result, then backs off 1s, 2s, 4s … 30s after 3 free tries', async () => {
    const clock = { t: 1_000_000 };
    const { store, make } = setup({ clock });
    await store.createVault(PASS);
    const device = make();
    expect(await device.unlock('nope')).toEqual({ kind: 'wrongPassphrase', retryAfterMs: 0 });
    expect(await device.unlock('nope')).toEqual({ kind: 'wrongPassphrase', retryAfterMs: 0 });
    expect(await device.unlock('nope')).toEqual({ kind: 'wrongPassphrase', retryAfterMs: 1000 });
    expect(await device.unlock(PASS)).toEqual({ kind: 'backoff', retryAfterMs: 1000 });
    clock.t += 1000;
    expect(await device.unlock('nope')).toEqual({ kind: 'wrongPassphrase', retryAfterMs: 2000 });
    clock.t += 2000;
    expect(await device.unlock(PASS)).toEqual({ kind: 'ok' });
    expect(device.backoffRemainingMs()).toBe(0);
    expect([3, 4, 5, 6, 7, 8, 9, 20].map(vaultBackoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it('NFKC: a differently composed passphrase unlocks the same vault', async () => {
    const { store, make } = setup();
    await store.createVault('café ﬁle');
    expect(await make().unlock('café file')).toEqual({ kind: 'ok' });
  });

  it('a corrupt or tampered header is corrupt, not a wrong passphrase', async () => {
    const { store, make, transport } = setup();
    await store.createVault(PASS);
    const raw = JSON.parse(transport.slots.get('vault')!.data);
    transport.put('vault', '{"v":1}');
    expect(await make().unlock(PASS)).toEqual({ kind: 'corrupt' });
    expect(await make().probe()).toEqual({ kind: 'corrupt' });
    // Valid shape, tampered index: the check passes, the index does not open.
    const ct = Buffer.from(raw.index.ct, 'base64url');
    ct[0] ^= 1;
    raw.index.ct = ct.toString('base64url');
    transport.put('vault', JSON.stringify(raw));
    expect(await make().unlock(PASS)).toEqual({ kind: 'corrupt' });
  });
});

describe('KeyVaultStore: keys, passwords and hosts', () => {
  it('adds a key, binds a host, decrypts it on another device, and exposes the public key', async () => {
    const { store, make, transport } = setup();
    await store.createVault(PASS);
    const pem = rsaPem();
    const added = await store.addKey(pem, ' hetzner ');
    expect(added.kind).toBe('ok');
    if (added.kind !== 'ok') return;
    expect(added.entry).toMatchObject({ name: 'hetzner', type: 'ssh-rsa' });
    expect(added.deduplicated).toBe(false);
    expect(transport.slots.has(vaultKeySlot(added.entry.keyId))).toBe(true);
    expect(transport.slots.get(vaultKeySlot(added.entry.keyId))!.data).not.toContain('PRIVATE');
    expect(await store.bindHost('hetzner', added.entry.keyId, 'both')).toEqual({ kind: 'ok' });

    const phone = make();
    await phone.unlock(PASS);
    expect(phone.getHostBinding('hetzner')).toEqual({ keyId: added.entry.keyId, gatewayAuth: 'both' });
    expect(await phone.decryptKeyForHost('hetzner')).toEqual({ kind: 'key', pem });
    expect(await phone.getPublicKey(added.entry.keyId)).toMatch(/^ssh-rsa AAAA/);
    expect(await phone.decryptKeyForHost('nowhere')).toEqual({ kind: 'unbound' });
    phone.lock();
    expect(await phone.decryptKeyForHost('hetzner')).toEqual({ kind: 'locked' });
  });

  it('deduplicates the same key, and refuses encrypted keys without their passphrase', async () => {
    const { store } = setup();
    await store.createVault(PASS);
    const pem = ed25519Pem();
    const first = await store.addKey(pem, 'laptop');
    const second = await store.addKey(pem, 'again');
    expect(second.kind === 'ok' && second.deduplicated).toBe(true);
    expect(store.listKeys()).toHaveLength(1);
    expect(store.listKeys()[0]!.name).toBe('laptop');
    expect(first.kind === 'ok' && second.kind === 'ok' && first.entry.keyId === second.entry.keyId).toBe(true);

    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const encrypted = String(privateKey.export({ type: 'pkcs1', format: 'pem', cipher: 'aes-128-cbc', passphrase: 'kp' }));
    expect((await store.addKey(encrypted, 'enc')).kind).toBe('needsPassphrase');
    expect((await store.addKey(encrypted, 'enc', 'bad')).kind).toBe('wrongPassphrase');
    const ok = await store.addKey(encrypted, 'enc', 'kp');
    expect(ok.kind).toBe('ok');
    const secret = ok.kind === 'ok' ? await store.decryptKey(ok.entry.keyId) : null;
    expect(secret?.kind === 'key' && secret.pem).not.toContain('ENCRYPTED');
  });

  it('stores passwords as entries with a random keyId and no public key', async () => {
    const { store, make } = setup();
    await store.createVault(PASS);
    const added = await store.addPassword('hunter2', 'nas password');
    expect(added.kind).toBe('ok');
    if (added.kind !== 'ok') return;
    expect(added.entry.type).toBe('password');
    expect(added.entry.fingerprint).toBeUndefined();
    await store.bindHost('nas', added.entry.keyId, 'host');
    const other = make();
    await other.unlock(PASS);
    expect(await other.decryptKeyForHost('nas')).toEqual({ kind: 'password', password: 'hunter2' });
    expect(await other.getPublicKey(added.entry.keyId)).toBeNull();
  });

  it('removes a key: its slot goes, the host binding stays and reports missingKey until re-uploaded', async () => {
    const { store, transport } = setup();
    await store.createVault(PASS);
    const pem = ed25519Pem();
    const added = await store.addKey(pem, 'k');
    if (added.kind !== 'ok') throw new Error('add failed');
    await store.bindHost('h', added.entry.keyId, 'managed');
    expect(await store.removeKey(added.entry.keyId)).toEqual({ kind: 'ok' });
    expect(transport.slots.has(vaultKeySlot(added.entry.keyId))).toBe(false);
    expect(await store.decryptKeyForHost('h')).toEqual({ kind: 'missingKey', keyId: added.entry.keyId });
    // Re-uploading the same key reattaches it (same content-derived keyId).
    await store.addKey(pem, 'k');
    expect((await store.decryptKeyForHost('h')).kind).toBe('key');
  });

  it('rotates a key: hosts follow, rotatedFrom recorded, old slot deleted', async () => {
    const { store, transport } = setup();
    await store.createVault(PASS);
    const a = await store.addKey(ed25519Pem(), 'old');
    const b = await store.addKey(ed25519Pem(), 'new');
    if (a.kind !== 'ok' || b.kind !== 'ok') throw new Error('add failed');
    await store.bindHost('h', a.entry.keyId, 'both');
    expect(await store.rotateKey(a.entry.keyId, b.entry.keyId)).toEqual({ kind: 'ok' });
    expect(store.getHostBinding('h')?.keyId).toBe(b.entry.keyId);
    expect(store.getKey(b.entry.keyId)?.rotatedFrom).toBe(a.entry.keyId);
    expect(transport.slots.has(vaultKeySlot(a.entry.keyId))).toBe(false);
  });

  it('a blob copied into another key slot does not decrypt (AAD)', async () => {
    const { store, transport } = setup();
    await store.createVault(PASS);
    const a = await store.addKey(ed25519Pem(), 'a');
    const b = await store.addKey(ed25519Pem(), 'b');
    if (a.kind !== 'ok' || b.kind !== 'ok') throw new Error('add failed');
    const raw = JSON.parse(transport.slots.get(vaultKeySlot(a.entry.keyId))!.data);
    raw.keyId = b.entry.keyId;
    transport.put(vaultKeySlot(b.entry.keyId), JSON.stringify(raw));
    expect(await store.decryptKey(b.entry.keyId)).toEqual({ kind: 'corrupt' });
    // Unmodified copy: the parser's keyId pin refuses it.
    transport.put(vaultKeySlot(b.entry.keyId), transport.slots.get(vaultKeySlot(a.entry.keyId))!.data);
    expect(await store.decryptKey(b.entry.keyId)).toEqual({ kind: 'corrupt' });
  });

  it('an RSA-4096 key blob stays well under the 8 KB slot limit', async () => {
    const { store, transport } = setup();
    await store.createVault(PASS);
    const added = await store.addKey(rsaPem(4096), 'big');
    expect(added.kind).toBe('ok');
    if (added.kind !== 'ok') return;
    const size = new TextEncoder().encode(transport.slots.get(vaultKeySlot(added.entry.keyId))!.data).length;
    expect(size).toBeLessThan(7 * 1024);
  });

  it('a full index answers indexFull and leaves no orphan blob', async () => {
    const { store, transport } = setup();
    await store.createVault(PASS);
    let last: { kind: string } = { kind: 'ok' };
    let added = 0;
    while (last.kind === 'ok' && added < 200) {
      last = await store.addPassword(`pw-${added}`, `a host with a fairly long descriptive name number ${added}`);
      if (last.kind === 'ok') added += 1;
    }
    expect(last.kind).toBe('indexFull');
    expect(added).toBeGreaterThan(20);
    const blobs = [...transport.slots.keys()].filter((slot) => slot.startsWith('vk-'));
    expect(blobs).toHaveLength(added);
  });
});

describe('KeyVaultStore: concurrency', () => {
  it('re-bases on a 409 and keeps both devices’ writes', async () => {
    const { store, make, transport } = setup();
    await store.createVault(PASS);
    const key = await store.addKey(ed25519Pem(), 'k');
    if (key.kind !== 'ok') throw new Error('add failed');
    const other = make();
    await other.unlock(PASS);
    // Another device writes after our last read: our next push hits a 409.
    await other.bindHost('from-other', key.entry.keyId, 'host');
    expect(await store.bindHost('from-us', key.entry.keyId, 'managed')).toEqual({ kind: 'ok' });
    const third = make();
    await third.unlock(PASS);
    expect(third.listHostBindings()).toEqual({
      'from-other': { keyId: key.entry.keyId, gatewayAuth: 'host' },
      'from-us': { keyId: key.entry.keyId, gatewayAuth: 'managed' },
    });
  });

  it('a reset on another device locks this one with vaultChanged', async () => {
    const { store, make } = setup();
    await store.createVault(PASS);
    const other = make();
    await other.unlock(PASS);
    expect((await other.resetVault('new pass')).kind).toBe('ok');
    expect(await store.setSyncPassphrase('x')).toEqual({ kind: 'vaultChanged' });
    expect(store.state).toBe('locked');
  });
});

describe('KeyVaultStore: change passphrase, remember, reset', () => {
  it('change passphrase: old fails, new works, keys readable, remembered DEKs still valid', async () => {
    const { store, make } = setup();
    await store.createVault(PASS);
    const key = await store.addKey(ed25519Pem(), 'k');
    if (key.kind !== 'ok') throw new Error('add failed');
    const remembered = store.exportRememberRecord()!;
    expect(remembered.dek).toHaveLength(32);
    expect(remembered.auth).toHaveLength(32);

    expect((await store.changePassphrase('wrong', 'next')).kind).toBe('wrongPassphrase');
    expect(await store.changePassphrase(PASS, 'next one')).toEqual({ kind: 'ok' });
    expect((await make().unlock(PASS)).kind).toBe('wrongPassphrase');
    const fresh = make();
    expect(await fresh.unlock('next one')).toEqual({ kind: 'ok' });
    expect((await fresh.decryptKey(key.entry.keyId)).kind).toBe('key');
    // The new AUTH replaced the old one in memory.
    expect(Buffer.from(store.exportRememberRecord()!.auth!).equals(Buffer.from(remembered.auth!))).toBe(false);

    const device = make();
    expect(await device.unlockWithRememberedDek(remembered)).toEqual({ kind: 'ok' });
    expect((await device.decryptKey(key.entry.keyId)).kind).toBe('key');
  });

  it('remember record: wrong vault, epoch or DEK is stale', async () => {
    const { store, make } = setup();
    await store.createVault(PASS);
    const record = store.exportRememberRecord()!;
    expect(await make().unlockWithRememberedDek({ ...record, epoch: 2 })).toEqual({ kind: 'stale' });
    expect(await make().unlockWithRememberedDek({ ...record, vaultId: 'AAAAAAAAAAAAAAAAAAAAAA' })).toEqual({ kind: 'stale' });
    expect(await make().unlockWithRememberedDek({ ...record, dek: new Uint8Array(32) })).toEqual({ kind: 'stale' });
    store.lock();
    expect(store.exportRememberRecord()).toBeNull();
    // lock() wiped the store's copy, not the exported record.
    expect(record.dek.some((b) => b !== 0)).toBe(true);
  });

  it('reset wipes every vk- slot, bumps the epoch, carries bindings and sync passphrase', async () => {
    const { store, make, transport } = setup();
    await store.createVault(PASS, { syncPassphrase: 'sync' });
    const pem = ed25519Pem();
    const key = await store.addKey(pem, 'k');
    if (key.kind !== 'ok') throw new Error('add failed');
    await store.bindHost('h', key.entry.keyId, 'both');
    transport.put('main', 'host list stays');
    const record = store.exportRememberRecord()!;
    const oldVaultId = store.vaultId;

    expect(await store.resetVault('brand new')).toEqual({ kind: 'ok' });
    expect([...transport.slots.keys()].filter((s) => s.startsWith('vk-'))).toEqual([]);
    expect(transport.slots.get('main')?.data).toBe('host list stays');
    expect(store.epoch).toBe(2);
    expect(store.vaultId).not.toBe(oldVaultId);
    expect(store.listKeys()).toEqual([]);
    expect(store.getHostBinding('h')).toEqual({ keyId: key.entry.keyId, gatewayAuth: 'both' });
    expect(store.getSyncPassphrase()).toBe('sync');
    expect(await store.decryptKeyForHost('h')).toEqual({ kind: 'missingKey', keyId: key.entry.keyId });
    expect(await make().unlockWithRememberedDek(record)).toEqual({ kind: 'stale' });
    expect((await make().unlock(PASS)).kind).toBe('wrongPassphrase');

    // Re-uploading the same key reattaches the host.
    await store.addKey(pem, 'k');
    expect(await store.decryptKeyForHost('h')).toEqual({ kind: 'key', pem: expect.any(String) });
  });

  it('reset while locked (forgot passphrase) can carry nothing', async () => {
    const { store, make } = setup();
    await store.createVault(PASS, { syncPassphrase: 'sync' });
    const forgetful = make();
    expect(await forgetful.resetVault('again', { syncPassphrase: null })).toEqual({ kind: 'ok' });
    expect(forgetful.getSyncPassphrase()).toBeNull();
    expect(forgetful.listHostBindings()).toEqual({});
  });
});

describe('KeyVaultStore: read-only transport (Android)', () => {
  it('unlock, remembered unlock, decrypt and public key never write', async () => {
    const { store, make, transport } = setup();
    await store.createVault(PASS);
    const key = await store.addKey(ed25519Pem(), 'k');
    const pw = await store.addPassword('pw', 'p');
    if (key.kind !== 'ok' || pw.kind !== 'ok') throw new Error('add failed');
    await store.bindHost('h', key.entry.keyId, 'managed');
    const record = store.exportRememberRecord()!;

    transport.readOnly = true;
    transport.writes.length = 0;
    const phone = make();
    expect(await phone.probe()).toMatchObject({ kind: 'vault' });
    expect(await phone.unlock('wrong')).toMatchObject({ kind: 'wrongPassphrase' });
    expect(await phone.unlock(PASS)).toEqual({ kind: 'ok' });
    expect((await phone.decryptKeyForHost('h')).kind).toBe('key');
    expect((await phone.decryptKey(pw.entry.keyId)).kind).toBe('password');
    expect(await phone.getPublicKey(key.entry.keyId)).toMatch(/^ssh-ed25519 /);
    const second = make();
    expect(await second.unlockWithRememberedDek(record)).toEqual({ kind: 'ok' });
    expect((await second.decryptKeyForHost('h')).kind).toBe('key');
    expect(transport.writes).toEqual([]);
  });
});

describe('KeyVaultStore: phase-2 server verifier', () => {
  class FakeServer implements VaultServerVerifier {
    verifier: string | null = null;
    gatedKdf: unknown = null;
    lockedFor = 0;
    calls: string[] = [];
    async status(): Promise<VaultServerStatus> {
      this.calls.push('status');
      return { kind: 'ok', epoch: 1, hasVerifier: this.verifier !== null, retryAfterMs: 0, ...(this.gatedKdf ? { kdf: this.gatedKdf as never } : {}) };
    }
    async verify(auth: Uint8Array): Promise<VaultVerifyResult> {
      this.calls.push('verify');
      if (this.lockedFor) return { kind: 'locked', retryAfterMs: this.lockedFor };
      if (this.verifier === null) return { kind: 'noVerifier' };
      return Buffer.from(auth).toString('hex') === this.verifier ? { kind: 'ok' } : { kind: 'wrong', retryAfterMs: 0 };
    }
    async setVerifier(input: { auth: Uint8Array; epoch: number; currentAuth?: Uint8Array }) {
      this.calls.push(input.currentAuth ? 'setVerifier+current' : 'setVerifier');
      if (this.verifier !== null && input.currentAuth && Buffer.from(input.currentAuth).toString('hex') !== this.verifier) {
        return { kind: 'refused' as const };
      }
      this.verifier = Buffer.from(input.auth).toString('hex');
      return { kind: 'ok' as const, epoch: input.epoch };
    }
  }

  it('publishes the verifier on create and on change, verifies on unlock', async () => {
    const server = new FakeServer();
    const { store, make } = setup({ verifier: server });
    await store.createVault(PASS);
    expect(server.verifier).not.toBeNull();
    expect(await make().unlock(PASS)).toEqual({ kind: 'ok' });
    await store.changePassphrase(PASS, 'second');
    expect(server.calls).toContain('setVerifier+current');
    expect(await make().unlock('second')).toEqual({ kind: 'ok' });
    expect((await make().unlock(PASS)).kind).toBe('wrongPassphrase');
  });

  it('a server lockout answers rateLimited; an unavailable server never blocks the unlock', async () => {
    const server = new FakeServer();
    const { store, make } = setup({ verifier: server });
    await store.createVault(PASS);
    server.lockedFor = 60_000;
    expect(await make().unlock(PASS)).toEqual({ kind: 'rateLimited', retryAfterMs: 60_000 });
    server.lockedFor = 0;
    server.verify = async () => ({ kind: 'unavailable' });
    expect(await make().unlock(PASS)).toEqual({ kind: 'ok' });
    server.verify = async () => {
      throw new Error('network down');
    };
    expect(await make().unlock(PASS)).toEqual({ kind: 'ok' });
  });

  it('a server with no verifier yet gets one after a successful local unlock', async () => {
    const { store, transport } = setup();
    await store.createVault(PASS);
    const server = new FakeServer();
    const device = new KeyVaultStore({ transport, verifier: server });
    expect(await device.unlock(PASS)).toEqual({ kind: 'ok' });
    expect(server.verifier).not.toBeNull();
  });

  it('gated mode: KDF from status, verify before reading the header; a wrong AUTH never reads it', async () => {
    const server = new FakeServer();
    const { store, transport } = setup({ verifier: server });
    await store.createVault(PASS);
    server.gatedKdf = parseVaultHeader(transport.slots.get('vault')!.data)!.kdf;
    let headerReads = 0;
    const pull = transport.pull.bind(transport);
    transport.pull = async (slot) => {
      if (slot === 'vault') headerReads += 1;
      return pull(slot);
    };
    const device = new KeyVaultStore({ transport, verifier: server });
    expect((await device.unlock('wrong')).kind).toBe('wrongPassphrase');
    expect(headerReads).toBe(0);
    expect(await device.unlock(PASS)).toEqual({ kind: 'ok' });
    expect(server.calls.slice(-2)).toEqual(['status', 'verify']);
    expect(headerReads).toBe(1);

    // Remembered device: silent AUTH verify; a passphrase change elsewhere makes it stale.
    const record = device.exportRememberRecord()!;
    expect(await new KeyVaultStore({ transport, verifier: server }).unlockWithRememberedDek(record)).toEqual({ kind: 'ok' });
    await device.changePassphrase(PASS, 'changed');
    expect(await new KeyVaultStore({ transport, verifier: server }).unlockWithRememberedDek(record)).toEqual({ kind: 'stale' });
    const { auth: _drop, ...noAuth } = record;
    expect(await new KeyVaultStore({ transport, verifier: server }).unlockWithRememberedDek(noAuth)).toEqual({ kind: 'stale' });
  });
});

describe('KeyVaultStore: gated slots (403 vault_verify_required)', () => {
  it('hides vault and vk-* until a verify; the store re-verifies silently with its AUTH', async () => {
    const { transport } = setup();
    let serverAuth: string | null = null;
    let windowOpen = false;
    const server: VaultServerVerifier = {
      async status() {
        const kdf = parseVaultHeader(transport.slots.get('vault')!.data)!.kdf;
        return { kind: 'ok', epoch: 1, hasVerifier: serverAuth !== null, retryAfterMs: 0, kdf };
      },
      async verify(auth) {
        if (serverAuth === null) return { kind: 'noVerifier' };
        windowOpen = Buffer.from(auth).toString('hex') === serverAuth;
        return windowOpen ? { kind: 'ok' } : { kind: 'wrong', retryAfterMs: 0 };
      },
      async setVerifier({ auth, epoch }) {
        serverAuth = Buffer.from(auth).toString('hex');
        return { kind: 'ok', epoch };
      },
    };
    const owner = new KeyVaultStore({ transport, kdf: KDF, verifier: server });
    await owner.createVault(PASS);
    const key = await owner.addKey(ed25519Pem(), 'k');
    if (key.kind !== 'ok') throw new Error('add failed');
    await owner.bindHost('h', key.entry.keyId, 'managed');

    const pull = transport.pull.bind(transport);
    const push = transport.push.bind(transport);
    const hidden = (slot: string) => (slot === 'vault' || slot.startsWith('vk-')) && !windowOpen;
    transport.pull = async (slot) => (hidden(slot) ? { kind: 'gated' } : pull(slot));
    transport.push = async (slot, data, base) => (hidden(slot) ? { kind: 'gated' } : push(slot, data, base));

    const phone = new KeyVaultStore({ transport, verifier: server });
    windowOpen = false;
    expect(await phone.probe()).toEqual({ kind: 'gated' });
    expect(await phone.unlock(PASS)).toEqual({ kind: 'ok' });
    windowOpen = false; // the verify window lapses
    expect((await phone.decryptKeyForHost('h')).kind).toBe('key');
    windowOpen = false;
    expect(await phone.bindHost('h2', key.entry.keyId, 'both')).toEqual({ kind: 'ok' });

    const record = phone.exportRememberRecord()!;
    windowOpen = false;
    const remembered = new KeyVaultStore({ transport, verifier: server });
    expect(await remembered.unlockWithRememberedDek(record)).toEqual({ kind: 'ok' });
    expect(remembered.getHostBinding('h2')?.gatewayAuth).toBe('both');
  });
});

describe('legacy keys slot migration', () => {
  it('parses the legacy shape and skips empty fields', () => {
    const parsed = parseLegacyKeysSlot(
      JSON.stringify({ v: 1, secrets: { a: { privateKeyPem: 'PEM', keyPassphrase: 'kp' }, b: { password: 'pw' }, c: { password: '' } } }),
    );
    expect(parsed).toEqual({
      kind: 'ok',
      items: [
        { hostAlias: 'a', kind: 'key', pem: 'PEM', keyPassphrase: 'kp' },
        { hostAlias: 'b', kind: 'password', password: 'pw' },
      ],
    });
    expect(parseLegacyKeysSlot('{"v":2,"secrets":{}}')).toEqual({ kind: 'invalid' });
    expect(parseLegacyKeysSlot('nope')).toEqual({ kind: 'invalid' });
  });

  it('moves keys (decrypting with the stored keyPassphrase) and passwords, binding hosts by name; idempotent', async () => {
    const { store, make } = setup();
    await store.createVault(PASS);
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const encrypted = String(privateKey.export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'kp' }));
    const plain = ed25519Pem();
    const legacy = JSON.stringify({
      v: 1,
      secrets: {
        hetzner: { privateKeyPem: encrypted, keyPassphrase: 'kp' },
        nas: { password: 'nas-pw' },
        both: { privateKeyPem: plain, password: 'both-pw' },
        broken: { privateKeyPem: encrypted },
      },
    });
    const parsed = parseLegacyKeysSlot(legacy);
    if (parsed.kind !== 'ok') throw new Error('parse failed');
    const report = await migrateLegacyKeys(store, parsed.items);
    expect(report.complete).toBe(false);
    expect(report.outcomes.map((o) => [o.hostAlias, o.kind, o.status])).toEqual([
      ['hetzner', 'key', 'migrated'],
      ['nas', 'password', 'migrated'],
      ['both', 'key', 'migrated'],
      ['both', 'password', 'migrated'],
      ['broken', 'key', 'needsPassphrase'],
    ]);

    const phone = make();
    await phone.unlock(PASS);
    expect((await phone.decryptKeyForHost('hetzner')).kind).toBe('key');
    expect(await phone.decryptKeyForHost('nas')).toEqual({ kind: 'password', password: 'nas-pw' });
    expect(await phone.decryptKeyForHost('both')).toEqual({ kind: 'key', pem: expect.stringContaining('OPENSSH') });
    expect(phone.getHostBinding('nas')?.gatewayAuth).toBe('both');

    const count = store.listKeys().length;
    const again = await migrateLegacyKeys(store, parsed.items);
    expect(again.outcomes.filter((o) => o.status === 'migrated')).toHaveLength(4);
    expect(store.listKeys()).toHaveLength(count);
  });
});
