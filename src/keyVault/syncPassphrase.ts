import { randomBytes, toB64url } from './bytes';

/**
 * Decision #7: the vault passphrase must never also encrypt the `main` host
 * list. The settings-sync envelope uses PBKDF2, a far cheaper guess than the
 * vault's Argon2id, and `main` is not behind the vault read gate, so a shared
 * passphrase would turn the host list into a cheap oracle for the vault.
 */

/** A fresh sync passphrase for an account with no host list yet: 32 random bytes, base64url (43 chars). */
export function generateSyncPassphrase(): string {
  return toB64url(randomBytes(32));
}

/**
 * Would `passphrase` (a new vault passphrase) reuse the sync passphrase?
 * True when it equals the known sync passphrase (raw or after NFKC), or when
 * the platform's `opensHostList` check decrypts the `main` slot with it.
 * Setup, change and reset refuse such a passphrase.
 */
export async function vaultPassphraseReusesSync(
  passphrase: string,
  options: { syncPassphrase?: string | null; opensHostList?: (passphrase: string) => Promise<boolean> },
): Promise<boolean> {
  const sync = options.syncPassphrase;
  if (typeof sync === 'string' && sync !== '') {
    if (sync === passphrase || sync.normalize('NFKC') === passphrase.normalize('NFKC')) return true;
  }
  if (options.opensHostList) {
    if (await options.opensHostList(passphrase)) return true;
    const normalized = passphrase.normalize('NFKC');
    if (normalized !== passphrase && (await options.opensHostList(normalized))) return true;
  }
  return false;
}
