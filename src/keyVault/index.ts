/**
 * The PocketShell key vault (design: pocketshell-key-vault, sections 3–5):
 * the vault v1 format and crypto, SSH private-key handling, the slot-backed
 * store every client drives, and the legacy `keys` slot migration.
 */
export * from './types';
export * from './format';
export {
  createVaultHeader,
  deriveMasterKey,
  derivePassphraseKeys,
  hkdf32,
  importAesKey,
  normalizeVaultPassphrase,
  open as openVaultSealed,
  openIndex as openVaultIndex,
  openKeyBlob as openVaultKeyBlob,
  openKeyBlobPublicKey as openVaultKeyBlobPublicKey,
  seal as sealVaultValue,
  sealIndex as sealVaultIndex,
  sealKeyBlob as sealVaultKeyBlob,
  unwrapDek as unwrapVaultDek,
  verifyCheck as verifyVaultCheck,
  wrapDek as wrapVaultDek,
  type VaultDekMaterial,
  type VaultPassphraseKeys,
} from './vaultCrypto';
export { bcryptPbkdf } from './bcryptPbkdf';
export * from './sshKeys';
export * from './store';
export * from './migration';
export * from './mirror';
export * from './syncPassphrase';
export { VaultCryptoUnavailableError, type VaultCryptoKey, type VaultSubtleCrypto } from './bytes';
