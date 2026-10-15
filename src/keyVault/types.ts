/**
 * The key vault vocabulary shared by every client (design: pocketshell key
 * vault, section 3). The on-the-wire shapes are parsed strictly in
 * format.ts; these are the decoded forms.
 */

/**
 * How the gateway path authenticates to a host (design section 7):
 *  - `host`: the host's own keys via the host agent; no vault key needed.
 *  - `managed`: the vault key only.
 *  - `both`: the vault key first, then the host's own keys.
 */
export type GatewayAuthPolicy = 'host' | 'managed' | 'both';

export const GATEWAY_AUTH_POLICIES: readonly GatewayAuthPolicy[] = ['host', 'managed', 'both'];

export function isGatewayAuthPolicy(value: unknown): value is GatewayAuthPolicy {
  return value === 'host' || value === 'managed' || value === 'both';
}

/**
 * One host's vault binding, stored in the encrypted index under the ACCOUNT
 * host alias (the host name as it appears in the `main` sync payload).
 */
export interface HostKeyBinding {
  keyId: string;
  gatewayAuth: GatewayAuthPolicy;
}

/** SSH key algorithms the vault accepts, by their OpenSSH wire name. */
export type VaultSshKeyType =
  | 'ssh-ed25519'
  | 'ecdsa-sha2-nistp256'
  | 'ecdsa-sha2-nistp384'
  | 'ecdsa-sha2-nistp521'
  | 'ssh-rsa';

export const VAULT_SSH_KEY_TYPES: readonly VaultSshKeyType[] = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'ssh-rsa',
];

/** An index entry's type: an SSH key, or a host password. */
export type VaultEntryType = VaultSshKeyType | 'password';

/**
 * One entry of the decrypted index. The public key itself lives sealed in
 * the entry's `vk-` blob (`pub`), which keeps the header under 8 KB.
 */
export interface VaultKeyEntry {
  /** b64url(SHA-256(public key wire blob))[:16 B] for keys; 16 random bytes for passwords. */
  keyId: string;
  name: string;
  type: VaultEntryType;
  /** `SHA256:<base64 no padding>`; absent for passwords. */
  fingerprint?: string;
  /** ISO timestamp. */
  createdAt: string;
  /** The keyId this key replaced (rotation history). */
  rotatedFrom?: string;
}

/** The decrypted index (the `index` field of the vault header). */
export interface VaultIndex {
  keys: VaultKeyEntry[];
  /** Keyed by the account host alias (the `main` payload host name). */
  hosts: Record<string, HostKeyBinding>;
  /** The account's settings-sync passphrase, so one vault unlock also opens `main`. */
  sync?: { passphrase: string };
}

/** What decrypting a host's credential yields — plaintext, memory only. */
export type VaultSecret = { kind: 'key'; pem: string } | { kind: 'password'; password: string };
