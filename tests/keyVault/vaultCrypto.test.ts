import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  deriveMasterKey,
  derivePassphraseKeys,
  hkdf32,
  importAesKey,
  openVaultIndex,
  openVaultKeyBlob,
  openVaultKeyBlobPublicKey,
  parseVaultHeader,
  parseVaultKeyBlob,
  sealVaultValue,
  serializeVaultHeader,
  serializeVaultKeyBlob,
  unwrapVaultDek,
  verifyVaultCheck,
  type VaultHeader,
} from '../../src/index';

/**
 * Known-answer tests for the vault v1 chain. The vectors come from
 * fixtures/generate-vault-vectors.mjs, which uses node:crypto only (an
 * independent Argon2id, HKDF and AES-GCM), so these pin core to the format
 * in the design doc rather than to itself. Every consumer shim must pass
 * the same vectors.
 */
const V = JSON.parse(readFileSync(new URL('./fixtures/vault-v1-vectors.json', import.meta.url), 'utf8'));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const fromHex = (text: string) => new Uint8Array(Buffer.from(text, 'hex'));
const b64urlBytes = (text: string) => new Uint8Array(Buffer.from(text, 'base64url'));

describe('vault v1 known answers', () => {
  it('Argon2id over the NFKC passphrase gives MK', async () => {
    expect(V.passphrase.normalize('NFKC')).toBe(V.normalizedPassphrase);
    expect(V.passphrase).not.toBe(V.normalizedPassphrase);
    expect(hex(await deriveMasterKey(V.passphrase, V.kdf))).toBe(V.mkHex);
    // The normalized form derives the same MK: NFKC happens inside.
    expect(hex(await deriveMasterKey(V.normalizedPassphrase, V.kdf))).toBe(V.mkHex);
  });

  it('HKDF-SHA256 with an empty salt gives KEK and AUTH', async () => {
    const mk = fromHex(V.mkHex);
    expect(hex(await hkdf32(mk, 'pocketshell-vault/v1/kek'))).toBe(V.kekHex);
    expect(hex(await hkdf32(mk, 'pocketshell-vault/v1/auth'))).toBe(V.authHex);
    const keys = await derivePassphraseKeys(V.passphrase, V.kdf);
    expect(hex(keys.auth)).toBe(V.authHex);
    expect(Buffer.from(keys.auth).toString('base64url')).toBe(V.authB64url);
  });

  it('AES-GCM sealing with the fixed nonces reproduces the header and blobs byte for byte', async () => {
    const kek = await importAesKey(fromHex(V.kekHex));
    const dek = await importAesKey(fromHex(V.dekHex));
    const h = V.header;
    expect(await sealVaultValue(kek, fromHex(V.dekHex), `pocketshell-vault/v1/dek|${V.vaultId}`, b64urlBytes(h.wrappedDek.n))).toEqual(h.wrappedDek);
    expect(await sealVaultValue(kek, new TextEncoder().encode('pocketshell-vault-check-v1'), `pocketshell-vault/v1/check|${V.vaultId}`, b64urlBytes(h.check.n))).toEqual(h.check);
    expect(await sealVaultValue(dek, new TextEncoder().encode(V.indexJson), `pocketshell-vault/v1/index|${V.vaultId}`, b64urlBytes(h.index.n))).toEqual(h.index);
    const blob = V.sshKey.blob;
    expect(await sealVaultValue(dek, new TextEncoder().encode(V.sshKey.plaintext), `pocketshell-vault/v1/key|${V.vaultId}|${V.sshKey.keyId}`, b64urlBytes(blob.n))).toEqual({ n: blob.n, ct: blob.ct });
    expect(await sealVaultValue(dek, new TextEncoder().encode(V.sshKey.publicKey), `pocketshell-vault/v1/pub|${V.vaultId}|${V.sshKey.keyId}`, b64urlBytes(blob.pub.n))).toEqual(blob.pub);
  });

  it('parses and opens the fixture header and blobs', async () => {
    const header = parseVaultHeader(V.headerSlotData) as VaultHeader;
    expect(header).not.toBeNull();
    expect(serializeVaultHeader(header)).toBe(V.headerSlotData);
    const { kek } = await derivePassphraseKeys(V.passphrase, header.kdf);
    expect(await verifyVaultCheck(kek, header)).toBe(true);
    const dekBytes = await unwrapVaultDek(kek, header);
    expect(hex(dekBytes as Uint8Array)).toBe(V.dekHex);
    const dek = await importAesKey(dekBytes as Uint8Array);
    const index = await openVaultIndex(dek, header);
    expect(index).toEqual(JSON.parse(V.indexJson));
    expect(index?.sync?.passphrase).toBe('fixture sync passphrase');

    const keyBlob = parseVaultKeyBlob(V.sshKey.slotData, { vaultId: V.vaultId, keyId: V.sshKey.keyId });
    expect(keyBlob && serializeVaultKeyBlob(keyBlob)).toBe(V.sshKey.slotData);
    expect(new TextDecoder().decode((await openVaultKeyBlob(dek, keyBlob!)) as Uint8Array)).toBe(V.sshKey.plaintext);
    expect(await openVaultKeyBlobPublicKey(dek, keyBlob!)).toBe(V.sshKey.publicKey);

    const pwBlob = parseVaultKeyBlob(V.password.slotData, { vaultId: V.vaultId, keyId: V.password.keyId });
    expect(pwBlob?.pub).toBeUndefined();
    expect(new TextDecoder().decode((await openVaultKeyBlob(dek, pwBlob!)) as Uint8Array)).toBe(V.password.plaintext);
  });

  it('a wrong passphrase fails the check value without throwing', async () => {
    const header = parseVaultHeader(V.headerSlotData) as VaultHeader;
    const { kek } = await derivePassphraseKeys('not the passphrase', header.kdf);
    expect(await verifyVaultCheck(kek, header)).toBe(false);
    expect(await unwrapVaultDek(kek, header)).toBeNull();
  });
});

describe('vault v1 tamper resistance', () => {
  const flip = (b64: string, at = 0): string => {
    const bytes = b64urlBytes(b64);
    bytes[at] = (bytes[at] as number) ^ 1;
    return Buffer.from(bytes).toString('base64url');
  };

  it('every sealed header field fails when its nonce or ciphertext changes', async () => {
    const kek = await importAesKey(fromHex(V.kekHex));
    const dek = await importAesKey(fromHex(V.dekHex));
    for (const field of ['wrappedDek', 'check', 'index'] as const) {
      for (const part of ['n', 'ct'] as const) {
        const raw = JSON.parse(V.headerSlotData);
        raw[field][part] = flip(raw[field][part], part === 'ct' ? 3 : 0);
        const header = parseVaultHeader(JSON.stringify(raw)) as VaultHeader;
        expect(header, `${field}.${part}`).not.toBeNull();
        if (field === 'check') expect(await verifyVaultCheck(kek, header)).toBe(false);
        if (field === 'wrappedDek') expect(await unwrapVaultDek(kek, header)).toBeNull();
        if (field === 'index') expect(await openVaultIndex(dek, header)).toBeNull();
      }
    }
  });

  it('a different vaultId (AAD) breaks every sealed value', async () => {
    const kek = await importAesKey(fromHex(V.kekHex));
    const dek = await importAesKey(fromHex(V.dekHex));
    const raw = JSON.parse(V.headerSlotData);
    raw.vaultId = Buffer.from(new Uint8Array(16).fill(7)).toString('base64url');
    const header = parseVaultHeader(JSON.stringify(raw)) as VaultHeader;
    expect(await verifyVaultCheck(kek, header)).toBe(false);
    expect(await unwrapVaultDek(kek, header)).toBeNull();
    expect(await openVaultIndex(dek, header)).toBeNull();
  });

  it('changing the KDF salt or params changes MK, so the check fails', async () => {
    const raw = JSON.parse(V.headerSlotData);
    raw.kdf.t = 2;
    const header = parseVaultHeader(JSON.stringify(raw)) as VaultHeader;
    const { kek } = await derivePassphraseKeys(V.passphrase, header.kdf);
    expect(await verifyVaultCheck(kek, header)).toBe(false);
  });

  it('a key blob moved to another keyId does not open (AAD binds vault and key)', async () => {
    const dek = await importAesKey(fromHex(V.dekHex));
    const raw = JSON.parse(V.sshKey.slotData);
    raw.keyId = V.password.keyId;
    const swapped = parseVaultKeyBlob(JSON.stringify(raw));
    expect(swapped).not.toBeNull();
    expect(await openVaultKeyBlob(dek, swapped!)).toBeNull();
    expect(await openVaultKeyBlobPublicKey(dek, swapped!)).toBeNull();
    // And the parser refuses it outright when the caller pins the expected keyId.
    expect(parseVaultKeyBlob(JSON.stringify(raw), { vaultId: V.vaultId, keyId: V.sshKey.keyId })).toBeNull();
  });

  it('blob ciphertext and pub tampering fail', async () => {
    const dek = await importAesKey(fromHex(V.dekHex));
    for (const mutate of [
      (r: any) => (r.ct = flip(r.ct, 5)),
      (r: any) => (r.n = flip(r.n)),
    ]) {
      const raw = JSON.parse(V.sshKey.slotData);
      mutate(raw);
      expect(await openVaultKeyBlob(dek, parseVaultKeyBlob(JSON.stringify(raw))!)).toBeNull();
    }
    const raw = JSON.parse(V.sshKey.slotData);
    raw.pub.ct = flip(raw.pub.ct, 2);
    expect(await openVaultKeyBlobPublicKey(dek, parseVaultKeyBlob(JSON.stringify(raw))!)).toBeNull();
  });
});

describe('vault v1 strict parsers', () => {
  const header = () => JSON.parse(V.headerSlotData);

  it('rejects unknown versions, bad ids and out-of-range KDF params', () => {
    const cases: Array<(h: any) => void> = [
      (h) => (h.v = 2),
      (h) => (h.v = '1'),
      (h) => (h.vaultId = 'short'),
      (h) => (h.vaultId = h.vaultId + '='),
      (h) => (h.kdf.alg = 'argon2i'),
      (h) => (h.kdf.m = 1024),
      (h) => (h.kdf.m = 4 * 1024 * 1024),
      (h) => (h.kdf.t = 0),
      (h) => (h.kdf.p = 99),
      (h) => (h.kdf.salt = 'AAAA'),
      (h) => (h.wrappedDek.n = 'AAAA'),
      (h) => (h.check = null),
      (h) => (h.epoch = 0),
      (h) => (h.updatedAt = 'yesterday'),
      (h) => delete h.index,
    ];
    for (const mutate of cases) {
      const raw = header();
      mutate(raw);
      expect(parseVaultHeader(JSON.stringify(raw)), mutate.toString()).toBeNull();
    }
    expect(parseVaultHeader('not json')).toBeNull();
    expect(parseVaultHeader(V.headerSlotData)).not.toBeNull();
  });

  it('rejects blobs of another vault or key when pinned, and unknown versions', () => {
    expect(parseVaultKeyBlob(V.sshKey.slotData, { vaultId: V.vaultId, keyId: V.sshKey.keyId })).not.toBeNull();
    const other = Buffer.from(new Uint8Array(16).fill(9)).toString('base64url');
    expect(parseVaultKeyBlob(V.sshKey.slotData, { vaultId: other, keyId: V.sshKey.keyId })).toBeNull();
    expect(parseVaultKeyBlob(V.sshKey.slotData, { vaultId: V.vaultId, keyId: other })).toBeNull();
    const raw = JSON.parse(V.sshKey.slotData);
    raw.v = 2;
    expect(parseVaultKeyBlob(JSON.stringify(raw))).toBeNull();
  });
});
