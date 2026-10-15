import { fromB64url } from './bytes';
import {
  isGatewayAuthPolicy,
  VAULT_SSH_KEY_TYPES,
  type HostKeyBinding,
  type VaultEntryType,
  type VaultIndex,
  type VaultKeyEntry,
} from './types';

/**
 * Vault v1 wire format (design section 3) and its strict parsers. Every
 * parser returns null on anything it does not fully understand — an unknown
 * version, a wrong-length field, a non-canonical base64url value — so a
 * malformed or future slot is never half-read.
 */

export const VAULT_FORMAT_VERSION = 1;

/** Slot holding the header. */
export const VAULT_HEADER_SLOT = 'vault';
/** Prefix of the per-key blob slots (`vk-<keyId>`). */
export const VAULT_KEY_SLOT_PREFIX = 'vk-';
/** The legacy per-host credential slot (web only, migrated then deleted). */
export const LEGACY_KEYS_SLOT = 'keys';
/** The settings API rejects `data` over 8 KB. */
export const VAULT_SLOT_LIMIT_BYTES = 8 * 1024;

export const VAULT_INFO_KEK = 'pocketshell-vault/v1/kek';
export const VAULT_INFO_AUTH = 'pocketshell-vault/v1/auth';
export const VAULT_AAD_DEK = 'pocketshell-vault/v1/dek|';
export const VAULT_AAD_CHECK = 'pocketshell-vault/v1/check|';
export const VAULT_AAD_INDEX = 'pocketshell-vault/v1/index|';
export const VAULT_AAD_KEY = 'pocketshell-vault/v1/key|';
export const VAULT_AAD_PUB = 'pocketshell-vault/v1/pub|';
export const VAULT_CHECK_PLAINTEXT = 'pocketshell-vault-check-v1';

/** Argon2id parameters stored in the header (m in KiB). */
export interface VaultKdfParams {
  alg: 'argon2id';
  m: number;
  t: number;
  p: number;
  /** 16 bytes, base64url. */
  salt: string;
}

/** The design default: 64 MiB, 3 passes, 1 lane. */
export const VAULT_KDF_DEFAULT = { m: 65536, t: 3, p: 1 } as const;
/** The slow-device fallback, allowed only when CREATING a vault. */
export const VAULT_KDF_FALLBACK = { m: 32768, t: 3, p: 1 } as const;
/** Parse bounds: below the floor is refused, above the cap would be a DoS. */
export const VAULT_KDF_MIN_M = 32768;
export const VAULT_KDF_MAX_M = 1048576;
export const VAULT_KDF_MAX_T = 16;
export const VAULT_KDF_MAX_P = 8;

/** An AES-GCM box: 12-byte nonce + ciphertext with tag, both base64url. */
export interface VaultSealed {
  n: string;
  ct: string;
}

export interface VaultHeader {
  v: 1;
  vaultId: string;
  kdf: VaultKdfParams;
  wrappedDek: VaultSealed;
  check: VaultSealed;
  index: VaultSealed;
  epoch: number;
  updatedAt: string;
}

export interface VaultKeyBlob {
  v: 1;
  vaultId: string;
  keyId: string;
  /** The private key PEM (or password), sealed. */
  n: string;
  ct: string;
  /** The OpenSSH public key line, sealed separately; absent for passwords. */
  pub?: VaultSealed;
}

export function vaultKeySlot(keyId: string): string {
  return `${VAULT_KEY_SLOT_PREFIX}${keyId}`;
}

/** The keyId a `vk-` slot name holds, or null when it is not a vault key slot. */
export function keyIdFromSlot(slot: string): string | null {
  if (!slot.startsWith(VAULT_KEY_SLOT_PREFIX)) return null;
  const keyId = slot.slice(VAULT_KEY_SLOT_PREFIX.length);
  return isId16(keyId) ? keyId : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isB64Len(value: unknown, length: number): value is string {
  if (typeof value !== 'string') return false;
  const bytes = fromB64url(value);
  return bytes !== null && bytes.length === length;
}

/** A 16-byte base64url identifier (vaultId, keyId, salt). */
export function isId16(value: unknown): value is string {
  return isB64Len(value, 16);
}

function parseSealed(value: unknown, minCt: number): VaultSealed | null {
  if (!isRecord(value) || !isB64Len(value.n, 12) || typeof value.ct !== 'string') return null;
  const ct = fromB64url(value.ct);
  // GCM appends a 16-byte tag; anything shorter cannot be a sealed value.
  if (ct === null || ct.length < minCt + 16) return null;
  return { n: value.n, ct: value.ct };
}

function isIsoTime(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

function isBoundedInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

export function parseKdfParams(value: unknown): VaultKdfParams | null {
  if (!isRecord(value) || value.alg !== 'argon2id') return null;
  if (!isBoundedInt(value.m, VAULT_KDF_MIN_M, VAULT_KDF_MAX_M)) return null;
  if (!isBoundedInt(value.t, 1, VAULT_KDF_MAX_T)) return null;
  if (!isBoundedInt(value.p, 1, VAULT_KDF_MAX_P)) return null;
  if (!isId16(value.salt)) return null;
  return { alg: 'argon2id', m: value.m, t: value.t, p: value.p, salt: value.salt };
}

/** Parse the `vault` slot JSON; null on any unknown version or malformed field. */
export function parseVaultHeader(text: string): VaultHeader | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.v !== VAULT_FORMAT_VERSION || !isId16(raw.vaultId)) return null;
  const kdf = parseKdfParams(raw.kdf);
  const wrappedDek = parseSealed(raw.wrappedDek, 32);
  const check = parseSealed(raw.check, 0);
  const index = parseSealed(raw.index, 0);
  if (!kdf || !wrappedDek || !check || !index) return null;
  if (!isBoundedInt(raw.epoch, 1, Number.MAX_SAFE_INTEGER) || !isIsoTime(raw.updatedAt)) return null;
  return { v: 1, vaultId: raw.vaultId, kdf, wrappedDek, check, index, epoch: raw.epoch, updatedAt: raw.updatedAt };
}

export function serializeVaultHeader(header: VaultHeader): string {
  return JSON.stringify({
    v: header.v,
    vaultId: header.vaultId,
    kdf: header.kdf,
    wrappedDek: header.wrappedDek,
    check: header.check,
    index: header.index,
    epoch: header.epoch,
    updatedAt: header.updatedAt,
  });
}

/**
 * Parse a `vk-` slot JSON. `expect` pins the vault and key the caller asked
 * for: a blob from another vault or another keyId is refused before any
 * decrypt (the AAD would refuse it too).
 */
export function parseVaultKeyBlob(text: string, expect?: { vaultId: string; keyId: string }): VaultKeyBlob | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.v !== VAULT_FORMAT_VERSION || !isId16(raw.vaultId) || !isId16(raw.keyId)) return null;
  const sealed = parseSealed(raw, 1);
  if (!sealed) return null;
  if (expect && (raw.vaultId !== expect.vaultId || raw.keyId !== expect.keyId)) return null;
  const blob: VaultKeyBlob = { v: 1, vaultId: raw.vaultId, keyId: raw.keyId, n: sealed.n, ct: sealed.ct };
  if (raw.pub !== undefined) {
    const pub = parseSealed(raw.pub, 1);
    if (!pub) return null;
    blob.pub = pub;
  }
  return blob;
}

export function serializeVaultKeyBlob(blob: VaultKeyBlob): string {
  return JSON.stringify({
    v: blob.v,
    vaultId: blob.vaultId,
    keyId: blob.keyId,
    n: blob.n,
    ct: blob.ct,
    ...(blob.pub === undefined ? {} : { pub: { n: blob.pub.n, ct: blob.pub.ct } }),
  });
}

const ENTRY_TYPES: readonly VaultEntryType[] = [...VAULT_SSH_KEY_TYPES, 'password'];

function parseKeyEntry(value: unknown): VaultKeyEntry | null {
  if (!isRecord(value) || !isId16(value.keyId)) return null;
  if (typeof value.name !== 'string' || value.name.length > 256) return null;
  if (!ENTRY_TYPES.includes(value.type as VaultEntryType)) return null;
  if (!isIsoTime(value.createdAt)) return null;
  const entry: VaultKeyEntry = {
    keyId: value.keyId,
    name: value.name,
    type: value.type as VaultEntryType,
    createdAt: value.createdAt,
  };
  if (entry.type === 'password') {
    if (value.fingerprint !== undefined) return null;
  } else {
    if (typeof value.fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(value.fingerprint)) return null;
    entry.fingerprint = value.fingerprint;
  }
  if (value.rotatedFrom !== undefined) {
    if (!isId16(value.rotatedFrom)) return null;
    entry.rotatedFrom = value.rotatedFrom;
  }
  return entry;
}

function parseBinding(value: unknown): HostKeyBinding | null {
  if (!isRecord(value) || !isId16(value.keyId) || !isGatewayAuthPolicy(value.gatewayAuth)) return null;
  return { keyId: value.keyId, gatewayAuth: value.gatewayAuth };
}

/** Parse the decrypted index JSON; null when any entry is malformed. */
export function parseVaultIndex(text: string): VaultIndex | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || !Array.isArray(raw.keys) || !isRecord(raw.hosts)) return null;
  const keys: VaultKeyEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw.keys) {
    const entry = parseKeyEntry(item);
    if (!entry || seen.has(entry.keyId)) return null;
    seen.add(entry.keyId);
    keys.push(entry);
  }
  const hosts: Record<string, HostKeyBinding> = {};
  for (const [alias, item] of Object.entries(raw.hosts)) {
    const binding = parseBinding(item);
    if (!binding || alias === '' || alias === '__proto__') return null;
    hosts[alias] = binding;
  }
  const index: VaultIndex = { keys, hosts };
  if (raw.sync !== undefined) {
    if (!isRecord(raw.sync) || typeof raw.sync.passphrase !== 'string') return null;
    index.sync = { passphrase: raw.sync.passphrase };
  }
  return index;
}

export function serializeVaultIndex(index: VaultIndex): string {
  const hosts: Record<string, HostKeyBinding> = {};
  for (const alias of Object.keys(index.hosts).sort()) {
    const binding = index.hosts[alias] as HostKeyBinding;
    hosts[alias] = { keyId: binding.keyId, gatewayAuth: binding.gatewayAuth };
  }
  return JSON.stringify({
    keys: index.keys.map((entry) => ({
      keyId: entry.keyId,
      name: entry.name,
      type: entry.type,
      ...(entry.fingerprint === undefined ? {} : { fingerprint: entry.fingerprint }),
      createdAt: entry.createdAt,
      ...(entry.rotatedFrom === undefined ? {} : { rotatedFrom: entry.rotatedFrom }),
    })),
    hosts,
    ...(index.sync === undefined ? {} : { sync: { passphrase: index.sync.passphrase } }),
  });
}
