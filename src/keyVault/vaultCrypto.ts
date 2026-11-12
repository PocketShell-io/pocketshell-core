import { argon2id } from 'hash-wasm';
import { fromB64url, fromUtf8, randomBytes, subtle, toB64url, utf8, wipe, type VaultCryptoKey } from './bytes';
import {
  VAULT_AAD_CHECK,
  VAULT_AAD_DEK,
  VAULT_AAD_INDEX,
  VAULT_AAD_KEY,
  VAULT_AAD_PUB,
  VAULT_CHECK_PLAINTEXT,
  VAULT_FORMAT_VERSION,
  VAULT_INFO_AUTH,
  VAULT_INFO_KEK,
  VAULT_KDF_DEFAULT,
  VAULT_KDF_MIN_M,
  parseKdfParams,
  parseVaultIndex,
  serializeVaultIndex,
  type VaultHeader,
  type VaultKdfParams,
  type VaultKeyBlob,
  type VaultSealed,
} from './format';
import type { VaultIndex } from './types';

/**
 * The vault v1 crypto chain (design section 3), the single implementation
 * every client uses:
 *
 *   passphrase ─NFKC─▶ Argon2id(salt, m, t, p, 32 B) = MK
 *   MK ─HKDF-SHA256(salt = empty, info = ".../kek")─▶ KEK   (wraps the DEK)
 *   MK ─HKDF-SHA256(salt = empty, info = ".../auth")─▶ AUTH (server verifier input)
 *   DEK = 32 random bytes per vault (index + key blobs)
 *
 * All AEAD is AES-256-GCM, 96-bit random nonce, 128-bit tag, with the AAD
 * strings from format.ts. MK and AUTH bytes are wiped after use; KEK and DEK
 * live in non-extractable CryptoKeys once imported.
 */

/** Raw DEK bytes plus the identity they belong to (for "remember on this device"). */
export interface VaultDekMaterial {
  dek: Uint8Array;
  vaultId: string;
  epoch: number;
}

/** Normalize the passphrase exactly once, the same way on every client. */
export function normalizeVaultPassphrase(passphrase: string): string {
  return passphrase.normalize('NFKC');
}

/** Argon2id → MK (32 bytes). The caller wipes the result. */
export async function deriveMasterKey(passphrase: string, kdf: VaultKdfParams): Promise<Uint8Array> {
  const salt = fromB64url(kdf.salt);
  if (!salt || salt.length !== 16) throw new Error('vault kdf salt must be 16 bytes');
  const password = utf8(normalizeVaultPassphrase(passphrase));
  try {
    return await argon2id({
      password,
      salt,
      parallelism: kdf.p,
      iterations: kdf.t,
      memorySize: kdf.m,
      hashLength: 32,
      outputType: 'binary',
    });
  } finally {
    wipe(password);
  }
}

/** HKDF-SHA256(MK, salt = empty, info) → 32 bytes. */
export async function hkdf32(mk: Uint8Array, info: string): Promise<Uint8Array> {
  const base = await subtle().importKey('raw', mk, 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(info) },
    base,
    256,
  );
  return new Uint8Array(bits);
}

/** Import 32 raw bytes as a non-extractable AES-256-GCM key. */
export async function importAesKey(raw: Uint8Array): Promise<VaultCryptoKey> {
  if (raw.length !== 32) throw new Error('vault AES keys are 32 bytes');
  return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** The keys one passphrase derives: the KEK (as a key) and AUTH (raw, for the server verifier). */
export interface VaultPassphraseKeys {
  kek: VaultCryptoKey;
  /** HKDF(MK, ".../auth"): what phase 2 sends to `/vault/verify`. Never decrypts anything. */
  auth: Uint8Array;
}

export async function derivePassphraseKeys(passphrase: string, kdf: VaultKdfParams): Promise<VaultPassphraseKeys> {
  const mk = await deriveMasterKey(passphrase, kdf);
  try {
    const kekRaw = await hkdf32(mk, VAULT_INFO_KEK);
    try {
      return { kek: await importAesKey(kekRaw), auth: await hkdf32(mk, VAULT_INFO_AUTH) };
    } finally {
      wipe(kekRaw);
    }
  } finally {
    wipe(mk);
  }
}

export async function seal(
  key: VaultCryptoKey,
  plaintext: Uint8Array,
  aad: string,
  nonce: Uint8Array = randomBytes(12),
): Promise<VaultSealed> {
  if (nonce.length !== 12) throw new Error('vault nonces are 12 bytes');
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: utf8(aad), tagLength: 128 },
    key,
    plaintext,
  );
  return { n: toB64url(nonce), ct: toB64url(new Uint8Array(ct)) };
}

/** Open a sealed value; null when the tag (key, nonce, ciphertext or AAD) does not verify. */
export async function open(key: VaultCryptoKey, sealed: VaultSealed, aad: string): Promise<Uint8Array | null> {
  const nonce = fromB64url(sealed.n);
  const ct = fromB64url(sealed.ct);
  if (!nonce || nonce.length !== 12 || !ct || ct.length < 16) return null;
  try {
    const pt = await subtle().decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: utf8(aad), tagLength: 128 },
      key,
      ct,
    );
    return new Uint8Array(pt);
  } catch {
    return null;
  }
}

export function newKdfParams(params: { m: number; t: number; p: number } = VAULT_KDF_DEFAULT): VaultKdfParams {
  const kdf = parseKdfParams({ alg: 'argon2id', ...params, salt: toB64url(randomBytes(16)) });
  if (!kdf) throw new Error(`vault kdf parameters out of range (m >= ${VAULT_KDF_MIN_M} KiB)`);
  return kdf;
}

/** Seal the key-check value and the DEK under a KEK. */
export async function wrapDek(
  kek: VaultCryptoKey,
  dek: Uint8Array,
  vaultId: string,
): Promise<Pick<VaultHeader, 'wrappedDek' | 'check'>> {
  return {
    wrappedDek: await seal(kek, dek, VAULT_AAD_DEK + vaultId),
    check: await seal(kek, utf8(VAULT_CHECK_PLAINTEXT), VAULT_AAD_CHECK + vaultId),
  };
}

/** Is this KEK the vault's? The check value's tag answers without touching the DEK. */
export async function verifyCheck(kek: VaultCryptoKey, header: VaultHeader): Promise<boolean> {
  const pt = await open(kek, header.check, VAULT_AAD_CHECK + header.vaultId);
  return pt !== null && fromUtf8(pt) === VAULT_CHECK_PLAINTEXT;
}

/** Unwrap the DEK; null when the wrap is tampered or the KEK is wrong. */
export async function unwrapDek(kek: VaultCryptoKey, header: VaultHeader): Promise<Uint8Array | null> {
  const dek = await open(kek, header.wrappedDek, VAULT_AAD_DEK + header.vaultId);
  if (dek && dek.length !== 32) {
    wipe(dek);
    return null;
  }
  return dek;
}

export async function sealIndex(dek: VaultCryptoKey, vaultId: string, index: VaultIndex): Promise<VaultSealed> {
  return seal(dek, utf8(serializeVaultIndex(index)), VAULT_AAD_INDEX + vaultId);
}

export async function openIndex(dek: VaultCryptoKey, header: VaultHeader): Promise<VaultIndex | null> {
  const pt = await open(dek, header.index, VAULT_AAD_INDEX + header.vaultId);
  if (!pt) return null;
  try {
    return parseVaultIndex(fromUtf8(pt));
  } catch {
    return null;
  } finally {
    wipe(pt);
  }
}

/** Seal a `vk-` blob: the secret, plus the public key line for SSH keys. */
export async function sealKeyBlob(
  dek: VaultCryptoKey,
  vaultId: string,
  keyId: string,
  plaintext: Uint8Array,
  publicKey?: string,
): Promise<VaultKeyBlob> {
  const sealed = await seal(dek, plaintext, `${VAULT_AAD_KEY}${vaultId}|${keyId}`);
  const blob: VaultKeyBlob = { v: VAULT_FORMAT_VERSION, vaultId, keyId, n: sealed.n, ct: sealed.ct };
  if (publicKey !== undefined) blob.pub = await seal(dek, utf8(publicKey), `${VAULT_AAD_PUB}${vaultId}|${keyId}`);
  return blob;
}

/** Open a blob's public key line; null when absent or tampered. */
export async function openKeyBlobPublicKey(dek: VaultCryptoKey, blob: VaultKeyBlob): Promise<string | null> {
  if (!blob.pub) return null;
  const pt = await open(dek, blob.pub, `${VAULT_AAD_PUB}${blob.vaultId}|${blob.keyId}`);
  if (!pt) return null;
  try {
    return fromUtf8(pt);
  } catch {
    return null;
  }
}

/** Open a key blob; the AAD binds it to its vault and keyId, so a swapped blob fails. */
export async function openKeyBlob(dek: VaultCryptoKey, blob: VaultKeyBlob): Promise<Uint8Array | null> {
  return open(dek, { n: blob.n, ct: blob.ct }, `${VAULT_AAD_KEY}${blob.vaultId}|${blob.keyId}`);
}

/** A brand-new vault header: fresh vaultId, salt, DEK; the given index sealed in. */
export async function createVaultHeader(input: {
  passphrase: string;
  index: VaultIndex;
  epoch: number;
  kdf?: { m: number; t: number; p: number };
  now?: Date;
}): Promise<{ header: VaultHeader; dek: Uint8Array; auth: Uint8Array }> {
  const vaultId = toB64url(randomBytes(16));
  const kdf = newKdfParams(input.kdf);
  const { kek, auth } = await derivePassphraseKeys(input.passphrase, kdf);
  const dek = randomBytes(32);
  const dekKey = await importAesKey(dek);
  const header: VaultHeader = {
    v: VAULT_FORMAT_VERSION,
    vaultId,
    kdf,
    ...(await wrapDek(kek, dek, vaultId)),
    index: await sealIndex(dekKey, vaultId, input.index),
    epoch: input.epoch,
    updatedAt: (input.now ?? new Date()).toISOString(),
  };
  return { header, dek, auth };
}
